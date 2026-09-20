/**
 * Public surface of browser-use-jev-bridge.
 *
 * `runTask` wires the pieces together in the only supported order: one Pi
 * session is created and owns the browser, the Jev executor is bound to that
 * session, and the router drives both.
 */

export * from './types.js';
export {
  loadConfig,
  describeConfig,
  registerSecrets,
  collectSecrets,
  applyDotEnv,
  parseDotEnv,
  providerCredential,
} from './config.js';
export type { DotEnvResult, ProviderCredential } from './config.js';
export type { BridgeConfig, BridgeMode, ConfigOverrides } from './config.js';
export { Redactor, defaultRedactor } from './safety/redaction.js';
export { DomainPolicy, DomainBlockedError, hostMatches } from './safety/domains.js';
export {
  assessRisk,
  DenyHighRiskGate,
  TerminalApprovalGate,
  ScriptedApprovalGate,
  type ApprovalGate,
} from './safety/approval-policy.js';
export { buildActionSpace, operationChoices } from './jev/action-space.js';
export { choose, validateChoice, buildDecisionRequest, HttpTypeSafeClient, InvalidModelResponseError } from './jev/policy.js';
export type { TypeSafeClient, TypeSafeRequest } from './jev/policy.js';
export {
  HttpTextModelClient,
  MissingTextModelClient,
  TextHelperUnavailableError,
  fieldContext,
  parseFieldValue,
} from './jev/text-helper.js';
export type { TextModelClient, FieldContext } from './jev/text-helper.js';
export {
  StalePageError,
  StaleDecisionError,
  assertDecisionFresh,
  fingerprintSnapshot,
  guardMatches,
  stableStringify,
} from './jev/freshness.js';
export { JevExecutor, UnsafeActionError } from './jev/executor.js';
export type { JevExecutorPort } from './jev/executor.js';
export { SNAPSHOT_SOURCE, MARKER_SOURCE, guardSource, actTargetSource, settleSource } from './jev/snapshot.js';
export { PiSession, browserOptionsFor } from './pi/session.js';
export type { BrowserBackend, PageInfo } from './pi/session.js';
export {
  PiFallbackRunner,
  UnavailableFallbackRunner,
  PiApprovalController,
  runFallback,
  describeToolCall,
} from './pi/fallback.js';
export type {
  FallbackOutcome,
  FallbackBudget,
  PiBeforeToolCall,
  PiBeforeToolCallContext,
  PiDenial,
} from './pi/fallback.js';
export { BudgetTracker } from './budget.js';
export type { BudgetLimits, BudgetReport, BudgetRemaining, BudgetExhaustion } from './budget.js';
export { HybridRouter, detectUnsupported } from './router/hybrid-router.js';
export type { RouterDependencies, FallbackRunner } from './router/hybrid-router.js';
export { buildHandoff, buildMustNotRepeat, renderHandoffPrompt, FALLBACK_REASON_TEXT } from './router/handoff.js';
export { verifyOutcome, deterministicChecks } from './verification/verifier.js';
export { AuditLog, MemoryAuditLog } from './logging/audit-log.js';

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { BridgeConfig } from './config.js';
import { registerSecrets } from './config.js';
import { JevExecutor } from './jev/executor.js';
import { HttpTypeSafeClient, type TypeSafeClient } from './jev/policy.js';
import {
  HttpTextModelClient,
  MissingTextModelClient,
  type TextModelClient,
} from './jev/text-helper.js';
import { AuditLog } from './logging/audit-log.js';
import { PiApprovalController, PiFallbackRunner, UnavailableFallbackRunner } from './pi/fallback.js';
import { PiSession } from './pi/session.js';
import { HybridRouter } from './router/hybrid-router.js';
import { DenyHighRiskGate, type ApprovalGate } from './safety/approval-policy.js';
import { DomainPolicy } from './safety/domains.js';
import { Redactor } from './safety/redaction.js';
import type { RunOutcome } from './types.js';

export interface RunTaskOptions {
  config: BridgeConfig;
  goal: string;
  url: string;
  gate?: ApprovalGate;
  signal?: AbortSignal;
  /**
   * Live, already-redacted run events. Same stream the audit log persists, so
   * a caller (the MCP layer) never has to reach into the router for progress.
   */
  onAudit?: (record: Record<string, unknown>) => void;
  /** Called once with the audit log's path, as soon as it exists. */
  onAuditPath?: (path: string) => void;
  /**
   * Test seam. Replaces ONLY the paid model transports — the TypeSafe
   * decision endpoint, the field-text endpoint and Pi's provider request.
   * Everything else (router, approval gate, budget, Pi's agent loop, Chrome,
   * the verifier) is the real implementation. Never set in production.
   */
  testTransport?: {
    typeSafe?: TypeSafeClient;
    textModel?: TextModelClient;
    piStreamFn?: unknown;
  };
}

export async function runTask(options: RunTaskOptions): Promise<RunOutcome> {
  const { config, goal, url } = options;
  const redactor = new Redactor();
  registerSecrets(config, redactor);
  const domainPolicy = new DomainPolicy({
    allowedDomains: config.allowedDomains,
    prohibitedDomains: config.prohibitedDomains,
  });
  mkdirSync(config.workspace, { recursive: true });
  const audit = new AuditLog(config.workspace, redactor, randomUUID());
  if (options.onAudit) audit.onRecord = options.onAudit as AuditLog['onRecord'];
  options.onAuditPath?.(audit.path);

  const typeSafe: TypeSafeClient | undefined =
    options.testTransport?.typeSafe ??
    (config.typesafe.apiKey ? new HttpTypeSafeClient(config.typesafe.baseUrl, config.typesafe.apiKey) : undefined);
  const textModel: TextModelClient =
    options.testTransport?.textModel ??
    (config.textModel.apiKey
      ? new HttpTextModelClient(
          config.textModel.baseUrl,
          config.textModel.apiKey,
          config.textModel.model,
          config.textModel.reasoning,
        )
      : new MissingTextModelClient());

  const gate: ApprovalGate = options.gate ?? new DenyHighRiskGate();

  // The Pi approval hook must exist before the session, because Pi only
  // accepts `beforeToolCall` at creation time.
  let currentUrl = url;
  const controller = new PiApprovalController({
    gate,
    redactor,
    audit,
    review: config.review,
    currentUrl: () => currentUrl,
  });

  const session = await PiSession.create({
    config,
    redactor,
    domainPolicy,
    ...(config.mode === 'fast' ? {} : { beforeToolCall: controller.hook }),
    ...(options.testTransport?.piStreamFn ? { streamFn: options.testTransport.piStreamFn as never } : {}),
  });
  try {
    const executor = new JevExecutor(session);
    const fallback =
      config.mode === 'fast'
        ? new UnavailableFallbackRunner()
        : new PiFallbackRunner({ session, redactor, controller });

    const router = new HybridRouter({
      backend: session,
      onUrlChange: (next) => {
        currentUrl = next;
      },
      executor,
      ...(typeSafe ? { typeSafe } : {}),
      textModel,
      fallback,
      piController: controller,
      gate,
      redactor,
      domainPolicy,
      audit,
      config,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return await router.run(goal, url);
  } finally {
    await session.close();
    gate.close?.();
  }
}
