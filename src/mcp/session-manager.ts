/**
 * MCP session lifecycle.
 *
 * An MCP call must not block for the length of a browser task, so a task runs
 * in the background and the client polls. That makes lifecycle the whole
 * problem: who owns the browser, what happens to a half-finished run when the
 * client disappears, and how an approval that is *asked for inside the run*
 * gets answered by a *different* MCP call.
 *
 * Rules enforced here:
 *   - at most `maxSessions` active browser tasks (default 1), so two tasks can
 *     never fight over one Chrome profile;
 *   - one pending approval per session, with a single-use random id;
 *   - an unanswered approval is DENIED when it times out — never approved;
 *   - a finished session is readable for a TTL, then expires and is dropped;
 *   - cancel is idempotent and always releases the browser, the timers and the
 *     approval waiter;
 *   - shutdown cancels everything, so a disconnecting client cannot leave a
 *     browser task running.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { runTask } from '../index.js';
import type { BridgeConfig } from '../config.js';
import type { ApprovalDecision, ApprovalRequest, RunOutcome } from '../types.js';
import type { ApprovalGate } from '../safety/approval-policy.js';
import { Redactor } from '../safety/redaction.js';

export type SessionState =
  | 'created'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'unverified'
  | 'blocked'
  | 'timeout'
  | 'cost_limit'
  | 'cancelled'
  | 'failed'
  | 'expired';

const TERMINAL: ReadonlySet<SessionState> = new Set<SessionState>([
  'completed',
  'unverified',
  'blocked',
  'timeout',
  'cost_limit',
  'cancelled',
  'failed',
  'expired',
]);

/** RunOutcome.status → session state. Nothing is invented: the raw status is kept too. */
export function sessionStateForOutcome(status: RunOutcome['status']): SessionState {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'unverified':
      return 'unverified';
    case 'timeout':
      return 'timeout';
    case 'cost_limit':
      return 'cost_limit';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'failed';
    case 'blocked':
    case 'step_limit':
    case 'stopped_by_approval':
    default:
      return 'blocked';
  }
}

export interface PendingApproval {
  approvalId: string;
  createdAt: number;
  expiresAt: number;
  source: 'jev' | 'pi';
  operation: string;
  actionLabel: string;
  targetDescription: string;
  textSummary?: string;
  url: string;
  risk: string;
  riskReasons: string[];
}

export interface StepSummary {
  step: number;
  source: string;
  operation: string;
  label: string;
  executionPhase: string;
  effectUncertain: boolean;
  pageChanged: boolean | null;
  url: string;
}

export interface SessionSnapshot {
  sessionId: string;
  state: SessionState;
  goal: string;
  startUrl: string;
  mode: string;
  review: boolean;
  currentUrl: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  steps: StepSummary[];
  uncertainActions: StepSummary[];
  budget: unknown;
  auditPath: string | null;
  pendingApproval: PendingApproval | null;
  outcome: RunOutcome | null;
  /** The raw RunOutcome.status, which carries more detail than SessionState. */
  outcomeStatus: string | null;
  error: string | null;
  notes: string[];
}

export type TestTransport = NonNullable<Parameters<typeof runTask>[0]['testTransport']>;

export interface SessionManagerOptions {
  /** Test seam; forwarded to every run. Replaces only the paid model transports. */
  testTransport?: TestTransport;
  maxSessions?: number;
  approvalTimeoutMs?: number;
  completedTtlMs?: number;
  sweepIntervalMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

interface ApprovalWaiter {
  approvalId: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/** The approval gate a background run uses when it is driven over MCP. */
class McpApprovalGate implements ApprovalGate {
  readonly name = 'mcp';
  constructor(private readonly session: BrowserTaskSession) {}
  request(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.session.askForApproval(request);
  }
  review(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.session.askForApproval(request);
  }
}

export class BrowserTaskSession {
  readonly id: string;
  state: SessionState = 'created';
  readonly createdAt: number;
  updatedAt: number;
  finishedAt: number | null = null;
  expiresAt: number | null = null;
  currentUrl: string | null = null;
  auditPath: string | null = null;
  outcome: RunOutcome | null = null;
  error: string | null = null;
  readonly notes: string[] = [];
  readonly steps: StepSummary[] = [];
  budget: unknown = null;
  pending: PendingApproval | null = null;

  private waiter: ApprovalWaiter | undefined;
  private readonly controller = new AbortController();
  private readonly redactor = new Redactor();
  private settled = false;

  constructor(
    readonly goal: string,
    readonly startUrl: string,
    readonly config: BridgeConfig,
    private readonly options: {
      approvalTimeoutMs: number;
      completedTtlMs: number;
      log: (message: string) => void;
      now: () => number;
      testTransport?: TestTransport;
    },
  ) {
    this.id = `bfh_${randomBytes(12).toString('hex')}`;
    this.createdAt = options.now();
    this.updatedAt = this.createdAt;
  }

  get done(): boolean {
    return TERMINAL.has(this.state);
  }

  private touch(state?: SessionState): void {
    if (state) this.state = state;
    this.updatedAt = this.options.now();
  }

  /** Start the background run. Returns immediately. */
  start(): void {
    this.touch('running');
    const gate = new McpApprovalGate(this);
    void runTask({
      config: this.config,
      goal: this.goal,
      url: this.startUrl,
      gate,
      signal: this.controller.signal,
      onAuditPath: (path) => {
        this.auditPath = path;
      },
      onAudit: (record) => this.absorb(record),
      ...(this.options.testTransport ? { testTransport: this.options.testTransport } : {}),
    })
      .then((outcome) => {
        this.outcome = outcome;
        this.currentUrl = outcome.finalUrl;
        this.budget = outcome.budget ?? this.budget;
        this.notes.push(...outcome.notes.filter((note) => !this.notes.includes(note)));
        if (outcome.error) this.error = outcome.error;
        this.finish(sessionStateForOutcome(outcome.status));
      })
      .catch((error: unknown) => {
        this.error = this.redactor.redact(error instanceof Error ? error.message : String(error));
        this.finish(this.controller.signal.aborted ? 'cancelled' : 'failed');
      });
  }

  /** Derive live progress from the run's own redacted audit stream. */
  private absorb(record: Record<string, unknown>): void {
    const type = record['type'];
    if (type === 'observation' && typeof record['url'] === 'string') this.currentUrl = record['url'];
    if (type === 'run_start' || type === 'run_end' || type === 'fallback_end') {
      if (record['budget'] !== undefined) this.budget = record['budget'];
    }
    if (type === 'note' && typeof record['message'] === 'string') this.notes.push(record['message']);
    if (type === 'execution' && typeof record['step'] === 'number') {
      const step = record['step'] as number;
      const existing = this.steps.find((entry) => entry.step === step);
      const merged: StepSummary = {
        step,
        source: String(record['source'] ?? existing?.source ?? 'jev'),
        operation: String(record['operation'] ?? existing?.operation ?? ''),
        label: String(record['label'] ?? existing?.label ?? ''),
        executionPhase: String(record['executionPhase'] ?? existing?.executionPhase ?? 'dispatch_started'),
        effectUncertain: Boolean(record['effectUncertain'] ?? existing?.effectUncertain ?? false),
        pageChanged: (record['pageChanged'] as boolean | null | undefined) ?? existing?.pageChanged ?? null,
        url: String(record['url'] ?? existing?.url ?? ''),
      };
      if (existing) Object.assign(existing, merged);
      else this.steps.push(merged);
    }
    this.touch();
  }

  /**
   * Called from inside the run. Publishes a pending approval and waits for an
   * answer from a separate MCP call.
   */
  askForApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.pending) {
      // One at a time, by construction: the router never runs two actions at once.
      return Promise.resolve({
        approved: false,
        reason: 'Another approval is already pending for this session.',
        by: 'policy',
      });
    }
    const approvalId = `apr_${randomBytes(9).toString('hex')}`;
    const createdAt = this.options.now();
    this.pending = {
      approvalId,
      createdAt,
      expiresAt: createdAt + this.options.approvalTimeoutMs,
      source: request.source,
      operation: request.operation,
      actionLabel: this.redactor.redact(request.actionLabel),
      targetDescription: this.redactor.redact(request.targetDescription),
      ...(request.textSummary ? { textSummary: this.redactor.redact(request.textSummary) } : {}),
      url: this.redactor.redact(request.url),
      risk: request.assessment.risk,
      riskReasons: request.assessment.reasons,
    };
    this.touch('awaiting_approval');

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        // Unanswered means denied. Never the other way round.
        this.clearPending();
        this.touch('running');
        resolve({
          approved: false,
          reason: `No answer within ${this.options.approvalTimeoutMs} ms; denied by default.`,
          by: 'policy',
        });
      }, this.options.approvalTimeoutMs);
      timer.unref?.();
      this.waiter = { approvalId, resolve, timer };
    });
  }

  /** Answer the pending approval. Single-use and strictly matched. */
  resolveApproval(approvalId: string, approved: boolean, reason?: string): { ok: true } | { ok: false; error: string } {
    if (!this.pending || !this.waiter) return { ok: false, error: 'No approval is pending for this session.' };
    if (this.pending.approvalId !== approvalId || this.waiter.approvalId !== approvalId) {
      return { ok: false, error: 'approvalId does not match the pending approval for this session.' };
    }
    const waiter = this.waiter;
    this.clearPending();
    this.touch('running');
    waiter.resolve({
      approved,
      reason: reason ?? (approved ? 'approved over MCP' : 'declined over MCP'),
      by: 'operator',
    });
    return { ok: true };
  }

  private clearPending(): void {
    if (this.waiter) clearTimeout(this.waiter.timer);
    this.waiter = undefined;
    this.pending = null;
  }

  /** Idempotent. Aborts the run, denies any pending approval, releases timers. */
  cancel(reason = 'cancelled over MCP'): void {
    if (this.done) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.clearPending();
      waiter.resolve({ approved: false, reason, by: 'policy' });
    }
    this.controller.abort();
    this.notes.push(reason);
    // The run's own catch settles the state; force it if the run never started.
    if (this.state === 'created') this.finish('cancelled');
  }

  private finish(state: SessionState): void {
    if (this.settled) return;
    this.settled = true;
    this.clearPending();
    this.touch(state);
    this.finishedAt = this.options.now();
    this.expiresAt = this.finishedAt + this.options.completedTtlMs;
  }

  expire(): void {
    this.clearPending();
    this.state = 'expired';
    this.updatedAt = this.options.now();
  }

  snapshot(): SessionSnapshot {
    const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());
    return {
      sessionId: this.id,
      state: this.state,
      goal: this.goal,
      startUrl: this.startUrl,
      mode: this.config.mode,
      review: this.config.review,
      currentUrl: this.currentUrl,
      createdAt: new Date(this.createdAt).toISOString(),
      updatedAt: new Date(this.updatedAt).toISOString(),
      finishedAt: iso(this.finishedAt),
      expiresAt: iso(this.expiresAt),
      steps: this.steps,
      uncertainActions: this.steps.filter((step) => step.effectUncertain),
      budget: this.budget,
      auditPath: this.auditPath,
      pendingApproval: this.pending,
      outcome: this.outcome,
      outcomeStatus: this.outcome?.status ?? null,
      error: this.error,
      notes: this.notes,
    };
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, BrowserTaskSession>();
  private readonly sweep: NodeJS.Timeout;
  private closed = false;

  readonly maxSessions: number;
  readonly approvalTimeoutMs: number;
  readonly completedTtlMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly testTransport: TestTransport | undefined;

  constructor(options: SessionManagerOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 1);
    this.approvalTimeoutMs = Math.max(1_000, options.approvalTimeoutMs ?? 300_000);
    this.completedTtlMs = Math.max(1_000, options.completedTtlMs ?? 900_000);
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.testTransport = options.testTransport;
    this.sweep = setInterval(() => this.sweepExpired(), options.sweepIntervalMs ?? 30_000);
    // Never keep the process alive just to sweep.
    this.sweep.unref?.();
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((session) => !session.done).length;
  }

  create(goal: string, startUrl: string, config: BridgeConfig): BrowserTaskSession {
    if (this.closed) throw new Error('The session manager is shutting down.');
    if (this.activeCount >= this.maxSessions) {
      throw new Error(
        `At most ${this.maxSessions} browser task(s) may run at once; cancel the active session first.`,
      );
    }
    const session = new BrowserTaskSession(goal, startUrl, config, {
      approvalTimeoutMs: this.approvalTimeoutMs,
      completedTtlMs: this.completedTtlMs,
      log: this.log,
      now: this.now,
      ...(this.testTransport ? { testTransport: this.testTransport } : {}),
    });
    this.sessions.set(session.id, session);
    this.log(`session ${session.id} created`);
    return session;
  }

  get(sessionId: string): BrowserTaskSession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  sweepExpired(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.done && session.expiresAt !== null && now >= session.expiresAt) {
        if (session.state !== 'expired') session.expire();
        this.sessions.delete(id);
        this.log(`session ${id} expired and was dropped`);
      }
    }
  }

  /** Idempotent shutdown: nothing is left running and nothing holds the loop open. */
  async close(reason = 'the MCP server is shutting down'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweep);
    for (const session of this.sessions.values()) session.cancel(reason);
    // Give the aborted runs a moment to release Chrome before the process exits.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.log('all sessions cancelled');
  }
}

export const newRunId = (): string => randomUUID();
