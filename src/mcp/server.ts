/**
 * The MCP surface.
 *
 * This layer owns **only** session lifecycle and the cross-call approval
 * channel. Every security decision — risk classification, the approval gate,
 * domain policy, the run budget and deadline, redaction, verification — comes
 * from the same `runTask` the CLI uses. There is no second router and no
 * MCP-only path that skips a check.
 *
 * Two rules the schemas enforce rather than document:
 *   - no tool accepts an API key, cookie or Authorization header; credentials
 *     come from the environment and from `.env`, and from nowhere else;
 *   - unknown fields are rejected, so a typo cannot silently widen a budget.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { loadConfig, type BridgeConfig, type BridgeMode } from '../config.js';
import { Redactor } from '../safety/redaction.js';
import { registerSecrets } from '../config.js';
import { SessionManager, type SessionSnapshot } from './session-manager.js';
import { doctorReport, type DoctorReport } from '../doctor.js';

export const SERVER_NAME = 'browser-fast-hybrid';
export const SERVER_VERSION = '0.2.0';

const MODE = z.enum(['fast', 'hybrid', 'pi']);

const DoctorInput = z
  .object({ mode: MODE.optional().describe('Which leg(s) to check. Default hybrid.') })
  .strict();

const StartInput = z
  .object({
    url: z.string().min(1).describe('Absolute http(s) or file URL to start from.'),
    goal: z.string().min(1).max(4000).describe('The end state that must be visibly true when the run finishes.'),
    mode: MODE.optional().describe('fast = no Pi fallback; hybrid (default); pi = go straight to Pi.'),
    review: z
      .boolean()
      .optional()
      .describe('Ask for approval before EVERY action and every Pi tool call, through browser_fast_approve.'),
    allowedDomains: z.array(z.string().min(1)).max(50).optional(),
    prohibitedDomains: z.array(z.string().min(1)).max(50).optional(),
    maxSteps: z.number().int().positive().max(200).optional(),
    timeoutMs: z.number().int().positive().max(1_800_000).optional(),
    maxCostUsd: z.number().positive().max(20).optional(),
    record: z.boolean().optional().describe('Enable Pi screen recording. Off by default.'),
  })
  .strict();

const SessionInput = z.object({ sessionId: z.string().min(1) }).strict();

const ApproveInput = z
  .object({
    sessionId: z.string().min(1),
    approvalId: z.string().min(1),
    approved: z.boolean(),
    reason: z.string().max(500).optional(),
  })
  .strict();

const VerifyInput = z
  .object({
    sessionId: z.string().min(1).optional(),
    auditPath: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.sessionId) !== Boolean(value.auditPath), {
    message: 'Provide exactly one of sessionId or auditPath.',
  });

const ListInput = z.object({}).strict();

export interface McpServerOptions {
  /** Defaults are safe; an operator can widen them with environment variables. */
  maxSessions?: number;
  approvalTimeoutMs?: number;
  completedTtlMs?: number;
  /** Diagnostics. MUST go to stderr: stdout belongs to the JSON-RPC stream. */
  log?: (message: string) => void;
  /** Overridden in tests so a run never needs credentials. */
  baseConfig?: (overrides: Parameters<typeof loadConfig>[0]) => BridgeConfig;
  /** Test seam; replaces only the paid model transports. */
  testTransport?: import('./session-manager.js').TestTransport;
}

export interface BridgeMcpServer {
  server: McpServer;
  sessions: SessionManager;
  close(): Promise<void>;
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
  };
}

/** Everything leaving this server passes through one redactor. */
function redactOut<T>(value: T): T {
  const redactor = new Redactor();
  redactor.registerEnvironment();
  return redactor.redactValue(value);
}

export function createBridgeMcpServer(options: McpServerOptions = {}): BridgeMcpServer {
  const log = options.log ?? (() => {});
  const sessions = new SessionManager({
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.completedTtlMs !== undefined ? { completedTtlMs: options.completedTtlMs } : {}),
    ...(options.testTransport ? { testTransport: options.testTransport } : {}),
    log,
  });

  const buildConfig = options.baseConfig ?? ((overrides) => loadConfig(overrides));

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Hybrid browser tool. browser_fast_start returns immediately with a sessionId; poll ' +
        'browser_fast_status. When state is awaiting_approval, answer with browser_fast_approve — ' +
        'high-risk actions are never auto-approved. The Browser Use Pi fallback is terminal: a run ' +
        'that reaches it ends there. Only state "completed" means the goal was verified.',
    },
  );

  // -- doctor ---------------------------------------------------------------
  server.registerTool(
    'browser_fast_doctor',
    {
      title: 'Check readiness',
      description:
        'Report whether the tool can run right now: ready | partial | not_ready, with blockers. ' +
        'Credentials are reported as set/unset only; no value is ever returned.',
      inputSchema: DoctorInput,
    },
    async (args) => {
      const parsed = DoctorInput.safeParse(args ?? {});
      if (!parsed.success) return fail(parsed.error.message);
      const report: DoctorReport = await doctorReport((parsed.data.mode ?? 'hybrid') as BridgeMode);
      return ok(redactOut(report));
    },
  );

  // -- start ----------------------------------------------------------------
  server.registerTool(
    'browser_fast_start',
    {
      title: 'Start a browser task',
      description:
        'Start an asynchronous browser task and return its sessionId immediately. Budgets default to ' +
        'safe values. No credential may be passed here; they come from the environment.',
      inputSchema: StartInput,
    },
    async (args) => {
      const parsed = StartInput.safeParse(args ?? {});
      if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.message}`);
      const input = parsed.data;

      let target: URL;
      try {
        target = new URL(input.url);
      } catch {
        return fail(`url is not a valid absolute URL: ${input.url}`);
      }
      if (!['http:', 'https:', 'file:'].includes(target.protocol)) {
        return fail(`url must be http(s) or file, got ${target.protocol}`);
      }

      let config: BridgeConfig;
      try {
        config = buildConfig({
          mode: (input.mode ?? 'hybrid') as BridgeMode,
          review: input.review ?? false,
          json: true,
          ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
          ...(input.prohibitedDomains ? { prohibitedDomains: input.prohibitedDomains } : {}),
          ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
          ...(input.record ? { record: true } : {}),
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }

      let session;
      try {
        session = sessions.create(input.goal, target.toString(), config);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      session.start();
      log(`session ${session.id} started (${config.mode}${config.review ? ', review' : ''})`);
      return ok(redactOut(summarise(session.snapshot())));
    },
  );

  // -- status ---------------------------------------------------------------
  server.registerTool(
    'browser_fast_status',
    {
      title: 'Read a task',
      description:
        'State, current URL, executed steps (including actions whose effect is uncertain), budget, ' +
        'audit path, any pending approval, and the final RunOutcome once finished.',
      inputSchema: SessionInput,
    },
    async (args) => {
      const parsed = SessionInput.safeParse(args ?? {});
      if (!parsed.success) return fail(parsed.error.message);
      const session = sessions.get(parsed.data.sessionId);
      if (!session) return fail(`Unknown sessionId: ${parsed.data.sessionId}`);
      return ok(redactOut(session.snapshot()));
    },
  );

  // -- approve --------------------------------------------------------------
  server.registerTool(
    'browser_fast_approve',
    {
      title: 'Answer a pending approval',
      description:
        'Approve or decline the one pending action. approvalId is single-use and must match the ' +
        'current pending approval for that session. Declining stops the run safely.',
      inputSchema: ApproveInput,
    },
    async (args) => {
      const parsed = ApproveInput.safeParse(args ?? {});
      if (!parsed.success) return fail(parsed.error.message);
      const { sessionId, approvalId, approved, reason } = parsed.data;
      const session = sessions.get(sessionId);
      if (!session) return fail(`Unknown sessionId: ${sessionId}`);
      const result = session.resolveApproval(approvalId, approved, reason);
      if (!result.ok) return fail(result.error);
      log(`session ${sessionId} approval ${approvalId} -> ${approved ? 'approved' : 'declined'}`);
      // Let the run act on the answer before the snapshot is taken.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return ok(redactOut({ applied: true, approved, ...summarise(session.snapshot()) }));
    },
  );

  // -- cancel ---------------------------------------------------------------
  server.registerTool(
    'browser_fast_cancel',
    {
      title: 'Cancel a task',
      description: 'Abort the run, deny any pending approval and release the browser. Idempotent.',
      inputSchema: SessionInput,
    },
    async (args) => {
      const parsed = SessionInput.safeParse(args ?? {});
      if (!parsed.success) return fail(parsed.error.message);
      const session = sessions.get(parsed.data.sessionId);
      if (!session) return fail(`Unknown sessionId: ${parsed.data.sessionId}`);
      const alreadyDone = session.done;
      session.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return ok(redactOut({ cancelled: true, alreadyFinished: alreadyDone, ...summarise(session.snapshot()) }));
    },
  );

  // -- verify ---------------------------------------------------------------
  server.registerTool(
    'browser_fast_verify',
    {
      title: 'Re-check a result',
      description:
        'With sessionId: re-read the finished run’s verification result. With auditPath: check a ' +
        'recorded log offline. Neither re-observes the live page, so both are reported as ' +
        'audit-only verification, never as a fresh check.',
      inputSchema: VerifyInput,
    },
    async (args) => {
      const parsed = VerifyInput.safeParse(args ?? {});
      if (!parsed.success) return fail(parsed.error.message);
      if (parsed.data.sessionId) {
        const session = sessions.get(parsed.data.sessionId);
        if (!session) return fail(`Unknown sessionId: ${parsed.data.sessionId}`);
        const snapshot = session.snapshot();
        if (!snapshot.outcome) {
          return ok(
            redactOut({
              kind: 'session',
              verificationMode: 'none',
              note: 'The run has not finished, so there is no verification result yet.',
              state: snapshot.state,
            }),
          );
        }
        return ok(
          redactOut({
            kind: 'session',
            // The page was observed during the run; this call does not re-observe.
            verificationMode: 'recorded_run_result',
            freshObservation: false,
            state: snapshot.state,
            outcomeStatus: snapshot.outcome.status,
            verified: snapshot.outcome.verification.verified,
            verification: snapshot.outcome.verification,
            uncertainActions: snapshot.uncertainActions,
            auditPath: snapshot.auditPath,
          }),
        );
      }
      return ok(redactOut(verifyAuditFile(parsed.data.auditPath as string)));
    },
  );

  // -- list -----------------------------------------------------------------
  server.registerTool(
    'browser_fast_list_sessions',
    {
      title: 'List tasks',
      description: 'Sessions this server knows about, with state only — no page content, no secrets.',
      inputSchema: ListInput,
    },
    async (args) => {
      const parsed = ListInput.safeParse(args ?? {});
      if (!parsed.success) return fail(parsed.error.message);
      return ok(
        redactOut({
          maxSessions: sessions.maxSessions,
          active: sessions.activeCount,
          sessions: sessions.list().map((snapshot) => ({
            sessionId: snapshot.sessionId,
            state: snapshot.state,
            goal: snapshot.goal,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
            expiresAt: snapshot.expiresAt,
            awaitingApprovalId: snapshot.pendingApproval?.approvalId ?? null,
          })),
        }),
      );
    },
  );

  return {
    server,
    sessions,
    async close() {
      await sessions.close();
      await server.close().catch(() => {});
    },
  };
}

/** The compact shape returned by start/approve/cancel. */
function summarise(snapshot: SessionSnapshot) {
  return {
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    currentUrl: snapshot.currentUrl,
    pendingApproval: snapshot.pendingApproval,
    steps: snapshot.steps.length,
    uncertainActions: snapshot.uncertainActions.length,
    budget: snapshot.budget,
    auditPath: snapshot.auditPath,
    outcomeStatus: snapshot.outcomeStatus,
  };
}

export interface AuditVerification {
  kind: 'audit';
  verificationMode: 'audit_only';
  freshObservation: false;
  path: string;
  runEndFound: boolean;
  status: string | null;
  verified: boolean | null;
  completionBackedByVerification: boolean;
  uncertainActions: number;
  secretShapedStrings: boolean;
  problems: string[];
}

export function verifyAuditFile(path: string): AuditVerification {
  const result: AuditVerification = {
    kind: 'audit',
    verificationMode: 'audit_only',
    freshObservation: false,
    path,
    runEndFound: false,
    status: null,
    verified: null,
    completionBackedByVerification: false,
    uncertainActions: 0,
    secretShapedStrings: false,
    problems: [],
  };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    result.problems.push(`Could not read the audit log: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  const lines = text.split('\n').filter(Boolean);
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      result.problems.push('The audit log contains a line that is not JSON.');
    }
  }
  const end = records.findLast((record) => record['type'] === 'run_end');
  if (end) {
    result.runEndFound = true;
    result.status = String(end['status'] ?? '');
    result.verified = end['verified'] === true;
    result.completionBackedByVerification = end['status'] !== 'completed' || end['verified'] === true;
    if (!result.completionBackedByVerification) {
      result.problems.push('The log claims completed without a verified result.');
    }
  } else {
    result.problems.push('No run_end record: the run did not finish, or the log is truncated.');
  }
  result.uncertainActions = records.filter(
    (record) => record['type'] === 'execution' && record['effectUncertain'] === true,
  ).length;
  result.secretShapedStrings = /sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(text);
  if (result.secretShapedStrings) result.problems.push('The log contains credential-shaped text.');
  return result;
}

/** Registers the process's secrets with a redactor, for the stderr logger. */
export function prepareRedaction(config: BridgeConfig): Redactor {
  const redactor = new Redactor();
  registerSecrets(config, redactor);
  return redactor;
}
