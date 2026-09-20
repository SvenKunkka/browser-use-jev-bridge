/**
 * Public surface of browser-use-jev-bridge.
 *
 * `runTask` wires the pieces together in the only supported order: one Pi
 * session is created and owns the browser, the Jev executor is bound to that
 * session, and the router drives both.
 */

export * from './types.js';
export { loadConfig, describeConfig, registerSecrets, collectSecrets } from './config.js';
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
export { PiFallbackRunner, UnavailableFallbackRunner, runFallback, buildBeforeToolCall } from './pi/fallback.js';
export type { FallbackOutcome } from './pi/fallback.js';
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
import { PiFallbackRunner, UnavailableFallbackRunner } from './pi/fallback.js';
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

  const typeSafe: TypeSafeClient | undefined = config.typesafe.apiKey
    ? new HttpTypeSafeClient(config.typesafe.baseUrl, config.typesafe.apiKey)
    : undefined;
  const textModel: TextModelClient = config.textModel.apiKey
    ? new HttpTextModelClient(
        config.textModel.baseUrl,
        config.textModel.apiKey,
        config.textModel.model,
        config.textModel.reasoning,
      )
    : new MissingTextModelClient();

  const gate: ApprovalGate = options.gate ?? new DenyHighRiskGate();
  const session = await PiSession.create({ config, redactor, domainPolicy });
  try {
    const executor = new JevExecutor(session);
    const fallback =
      config.mode === 'fast'
        ? new UnavailableFallbackRunner()
        : new PiFallbackRunner({
            session,
            gate,
            redactor,
            budget: {
              maxSteps: Math.max(1, config.maxSteps),
              timeoutMs: config.timeoutMs,
              maxCostUsd: config.maxCostUsd,
            },
            ...(options.signal ? { signal: options.signal } : {}),
          });

    const router = new HybridRouter({
      backend: session,
      executor,
      ...(typeSafe ? { typeSafe } : {}),
      textModel,
      fallback,
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
