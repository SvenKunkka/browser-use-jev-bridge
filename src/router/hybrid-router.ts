/**
 * The hybrid router.
 *
 * Owns the loop. Decides, per step, whether the Jev fast policy may act or
 * whether the step belongs to Browser Use Pi, applies the approval policy,
 * enforces freshness, records everything, and refuses to call a run complete
 * until the independent verifier agrees.
 *
 * Invariants:
 *   - one browser session, owned by the caller and passed in as a backend;
 *   - a Decision is consumed exactly once, before any mutation;
 *   - a Decision is never applied to a different page fingerprint;
 *   - nothing is retried automatically after an action reached the browser;
 *   - control returns to Jev only after a fresh observation with a new
 *     fingerprint.
 */

import type {
  ActionRecord,
  Decision,
  FallbackReason,
  HandoffContext,
  JevRawAction,
  JevSnapshot,
  RunOutcome,
  RunStatus,
} from '../types.js';
import type { BridgeConfig } from '../config.js';
import type { BrowserBackend } from '../pi/session.js';
import type { JevExecutorPort } from '../jev/executor.js';
import { UnsafeActionError } from '../jev/executor.js';
import { StaleDecisionError, StalePageError, assertDecisionFresh } from '../jev/freshness.js';
import { InvalidModelResponseError, choose, type TypeSafeClient } from '../jev/policy.js';
import {
  TextHelperUnavailableError,
  fieldContext,
  type TextModelClient,
} from '../jev/text-helper.js';
import type { ApprovalGate } from '../safety/approval-policy.js';
import { assessRisk } from '../safety/approval-policy.js';
import type { DomainPolicy } from '../safety/domains.js';
import { DomainBlockedError } from '../safety/domains.js';
import type { Redactor } from '../safety/redaction.js';
import type { AuditLog } from '../logging/audit-log.js';
import { verifyOutcome } from '../verification/verifier.js';
import { buildHandoff } from './handoff.js';
import type { FallbackOutcome } from '../pi/fallback.js';

const CREDENTIAL_FIELD =
  /(password|passcode|pin\b|otp|one[- ]time|2fa|mfa|verification code|card number|cvv|cvc|iban|ssn|密码|验证码|银行卡|身份证)/i;

const UPLOAD_GOAL = /(upload|attach|附件|上传)/i;

export interface FallbackRunner {
  readonly available: boolean;
  run(context: HandoffContext): Promise<FallbackOutcome>;
}

export interface RouterDependencies {
  backend: BrowserBackend;
  executor: JevExecutorPort;
  typeSafe?: TypeSafeClient;
  textModel: TextModelClient;
  fallback?: FallbackRunner;
  gate: ApprovalGate;
  redactor: Redactor;
  domainPolicy: DomainPolicy;
  audit: AuditLog;
  config: BridgeConfig;
  signal?: AbortSignal;
  now?: () => number;
}

export interface UnsupportedVerdict {
  unsupported: boolean;
  reasons: string[];
}

/**
 * Deterministic "this page is not Jev's" test. Kept pure and exported so the
 * routing rules are unit-testable without a browser.
 */
export function detectUnsupported(
  snapshot: JevSnapshot,
  goal = '',
  baselineTabCount = 1,
): UnsupportedVerdict {
  const reasons: string[] = [];
  const actionable = snapshot.actions.filter(
    (action) => action.kind !== 'wait' && action.kind !== 'scroll',
  ).length;
  const signals = snapshot.unsupported;

  // A new tab appearing *during the run* is the signal. The operator's other
  // tabs are none of our business, so the baseline is taken at run start.
  if ((snapshot.tabCount ?? baselineTabCount) > baselineTabCount) {
    reasons.push('a new page-type tab appeared during the run (popup or new tab)');
  }
  if (signals.openDialogs > 0 && actionable === 0) reasons.push('a modal <dialog> is open with no modelled controls');
  if (actionable === 0 && signals.iframes > 0) reasons.push('no modelled controls, but the page embeds iframes');
  if (actionable === 0 && signals.canvases > 0) reasons.push('no modelled controls, but the page renders a canvas');
  if (actionable === 0 && signals.shadowRoots > 0) reasons.push('no modelled controls, but the page uses shadow DOM');
  if (signals.crossOriginIframes > 0 && actionable === 0) reasons.push('cross-origin iframe with no modelled controls');
  if (signals.fileInputs > 0 && UPLOAD_GOAL.test(goal)) reasons.push('the goal requires a file upload');

  return { unsupported: reasons.length > 0, reasons };
}

export class HybridRouter {
  private readonly history: ActionRecord[] = [];
  private readonly fallbackReasons: FallbackReason[] = [];
  private readonly notes: string[] = [];
  private consecutiveStale = 0;
  private noProgress = 0;
  private jevSteps = 0;
  private piFallbacks = 0;
  private usedPiOnce = false;
  private baselineTabCount = 1;
  private pendingText: { key: string; text: string } | undefined;

  constructor(private readonly deps: RouterDependencies) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private note(message: string): void {
    this.notes.push(message);
    this.deps.audit.write({ type: 'note', message });
  }

  async run(goal: string, startUrl: string): Promise<RunOutcome> {
    const { config, audit, domainPolicy } = this.deps;
    const startedAt = this.now;
    const deadline = startedAt + config.timeoutMs;

    audit.write({
      type: 'run_start',
      goal,
      startUrl,
      mode: config.mode,
      review: config.review,
      budgets: { maxSteps: config.maxSteps, timeoutMs: config.timeoutMs, maxCostUsd: config.maxCostUsd },
    });

    let snapshot: JevSnapshot;
    let status: RunStatus = 'error';
    let error: string | undefined;

    try {
      domainPolicy.assert(startUrl);
      await this.deps.backend.goto(startUrl);
      snapshot = await this.observe();
      this.baselineTabCount = snapshot.tabCount ?? 1;
    } catch (caught) {
      const message = this.deps.redactor.redact(caught instanceof Error ? caught.message : String(caught));
      audit.write({ type: 'error', phase: 'startup', message });
      return this.finish('error', goal, startUrl, startUrl, startedAt, {
        verified: false,
        verdict: 'NOT_RUN',
        confidence: null,
        reasons: [message],
        evidence: null,
        deterministicChecks: [],
      }, message);
    }

    while (true) {
      if (this.deps.signal?.aborted) {
        status = 'error';
        error = 'Run cancelled.';
        break;
      }
      if (this.now > deadline) {
        status = 'timeout';
        break;
      }
      if (this.history.length >= config.maxSteps) {
        const handled = await this.maybeFallback(goal, snapshot, 'step_limit');
        if (handled) {
          snapshot = handled;
          continue;
        }
        status = 'step_limit';
        break;
      }

      // ---- routing: does this page belong to Pi? --------------------------
      if (config.mode !== 'fast') {
        const verdict = detectUnsupported(snapshot, goal, this.baselineTabCount);
        if (verdict.unsupported) {
          this.note(`Routed to Pi: ${verdict.reasons.join('; ')}`);
          const handled = await this.maybeFallback(goal, snapshot, 'unsupported_page');
          if (handled) {
            snapshot = handled;
            continue;
          }
          status = 'blocked';
          break;
        }
      }
      if (config.mode === 'pi') {
        const handled = await this.maybeFallback(goal, snapshot, 'operator_request');
        if (handled) {
          snapshot = handled;
          // In pi mode a single fallback leg is the whole run.
          const verification = await this.verify(goal, snapshot);
          return this.finish(
            verification.verified ? 'completed' : 'unverified',
            goal,
            startUrl,
            snapshot.url,
            startedAt,
            verification,
          );
        }
        status = 'blocked';
        break;
      }

      if (this.jevSteps >= config.thresholds.jevMaxSteps) {
        const handled = await this.maybeFallback(goal, snapshot, 'step_limit');
        if (handled) {
          snapshot = handled;
          continue;
        }
        status = 'step_limit';
        break;
      }

      // ---- decide ---------------------------------------------------------
      let decision: Decision;
      try {
        if (!this.deps.typeSafe) {
          throw new InvalidModelResponseError('No TypeSafe client is configured for the fast policy.');
        }
        const chosen = await choose(snapshot, goal, this.history, {
          client: this.deps.typeSafe,
          model: config.typesafe.model,
          ...(this.deps.signal ? { signal: this.deps.signal } : {}),
        });
        decision = chosen.decision;
      } catch (caught) {
        const message = this.deps.redactor.redact(caught instanceof Error ? caught.message : String(caught));
        this.deps.audit.write({ type: 'error', phase: 'decide', message });
        const handled = await this.maybeFallback(goal, snapshot, 'decision_error');
        if (handled) {
          snapshot = handled;
          continue;
        }
        status = 'error';
        error = message;
        break;
      }

      this.deps.audit.write({
        type: 'decision',
        source: 'jev',
        fingerprint: snapshot.fingerprint,
        url: snapshot.url,
        operation: decision.operation,
        choice: decision.choice,
        target: decision.target,
        confidence: decision.confidence,
        latencyMs: decision.latencyMs,
      });

      // ---- terminal choices ----------------------------------------------
      if (decision.operation === 'BLOCKED') {
        const handled = await this.maybeFallback(goal, snapshot, 'jev_blocked');
        if (handled) {
          snapshot = handled;
          continue;
        }
        status = 'blocked';
        break;
      }

      if (decision.operation === 'DONE') {
        // A DONE claim is worth nothing until the page is re-read.
        if (!(await this.deps.executor.isFresh(snapshot))) {
          snapshot = await this.observe();
          this.registerStale('page changed before DONE could be accepted');
          continue;
        }
        const fresh = await this.observe();
        const verification = await this.verify(goal, fresh);
        if (verification.verified) {
          return this.finish('completed', goal, startUrl, fresh.url, startedAt, verification);
        }
        this.note(`DONE was claimed but not verified (${verification.verdict}).`);
        return this.finish('unverified', goal, startUrl, fresh.url, startedAt, verification);
      }

      // ---- resolve the concrete action ------------------------------------
      const action = snapshot.actions.find((candidate) => candidate.id === decision.choice);
      if (!action) {
        this.deps.audit.write({
          type: 'error',
          phase: 'resolve',
          message: `Decision referenced action "${decision.choice}" which is not in this observation.`,
        });
        status = 'error';
        error = 'Decision referenced an action that was not observed.';
        break;
      }

      const stepResult = await this.executeStep(goal, snapshot, decision, action);
      if (stepResult.kind === 'stopped') {
        status = stepResult.status;
        if (stepResult.error) error = stepResult.error;
        break;
      }
      if (stepResult.kind === 'stale') {
        snapshot = stepResult.snapshot;
        if (this.consecutiveStale >= config.thresholds.maxConsecutiveStale) {
          const handled = await this.maybeFallback(goal, snapshot, 'stale_repeated');
          if (handled) {
            snapshot = handled;
            continue;
          }
          status = 'blocked';
          break;
        }
        continue;
      }
      if (stepResult.kind === 'fallback') {
        const handled = await this.maybeFallback(goal, snapshot, stepResult.reason);
        if (handled) {
          snapshot = handled;
          continue;
        }
        status = 'blocked';
        break;
      }

      snapshot = stepResult.snapshot;
      if (this.noProgress >= config.thresholds.maxNoProgress) {
        const handled = await this.maybeFallback(goal, snapshot, 'no_progress');
        if (handled) {
          snapshot = handled;
          continue;
        }
        status = 'blocked';
        break;
      }
    }

    const verification = await this.verify(goal, snapshot).catch(() => ({
      verified: false,
      verdict: 'NOT_RUN' as const,
      confidence: null,
      reasons: ['Verification could not run after the loop ended.'],
      evidence: null,
      deterministicChecks: [],
    }));
    if (status === 'completed' && !verification.verified) status = 'unverified';
    return this.finish(status, goal, startUrl, snapshot.url, startedAt, verification, error);
  }

  // -------------------------------------------------------------------------

  private async observe(): Promise<JevSnapshot> {
    const snapshot = await this.deps.executor.observe();
    this.deps.audit.write({
      type: 'observation',
      url: snapshot.url,
      title: snapshot.title,
      fingerprint: snapshot.fingerprint,
      actions: snapshot.actions.length,
      omittedActions: snapshot.omittedActions,
      unsupported: snapshot.unsupported,
      tabCount: snapshot.tabCount ?? null,
    });
    return snapshot;
  }

  private registerStale(message: string): void {
    this.consecutiveStale += 1;
    this.deps.audit.write({ type: 'stale', message, consecutive: this.consecutiveStale });
  }

  private async executeStep(
    goal: string,
    snapshot: JevSnapshot,
    pendingDecision: Decision,
    action: JevRawAction,
  ): Promise<
    | { kind: 'executed'; snapshot: JevSnapshot }
    | { kind: 'stale'; snapshot: JevSnapshot }
    | { kind: 'fallback'; reason: FallbackReason }
    | { kind: 'stopped'; status: RunStatus; error?: string }
  > {
    const { config, redactor, audit } = this.deps;

    // Consume the decision before anything can mutate the page: a retry after
    // this point can never re-execute the same choice.
    let decision: Decision;
    try {
      decision = assertDecisionFresh(pendingDecision, snapshot);
    } catch (caught) {
      if (caught instanceof StaleDecisionError) {
        this.registerStale(caught.message);
        return { kind: 'stale', snapshot: await this.observe() };
      }
      throw caught;
    }

    // Domain policy applies to the page we are about to act on, and to links.
    try {
      this.deps.domainPolicy.assert(snapshot.url);
      if (action.href) {
        const resolved = new URL(action.href, snapshot.url).toString();
        this.deps.domainPolicy.assert(resolved);
      }
    } catch (caught) {
      if (caught instanceof DomainBlockedError) {
        audit.write({ type: 'error', phase: 'domain', message: caught.message, url: caught.url });
        return { kind: 'stopped', status: 'blocked', error: caught.message };
      }
      throw caught;
    }

    // Text generation, when the operation needs it.
    let text: string | undefined;
    if (action.kind === 'fill') {
      if (CREDENTIAL_FIELD.test(action.label)) {
        this.note(`Refused to generate text for credential-like field "${action.label}".`);
        return { kind: 'fallback', reason: 'credential_field' };
      }
      if (!(await this.deps.executor.isFresh(snapshot))) {
        this.registerStale('page changed before text generation');
        return { kind: 'stale', snapshot: await this.observe() };
      }
      const context = fieldContext(goal, action, snapshot, this.history);
      const key = JSON.stringify(context);
      try {
        if (this.pendingText?.key === key) {
          text = this.pendingText.text;
        } else {
          const generated = await this.deps.textModel.complete(
            context,
            ...(this.deps.signal ? [this.deps.signal] : []),
          );
          text = generated.text;
          this.pendingText = { key, text };
        }
      } catch (caught) {
        if (caught instanceof TextHelperUnavailableError) {
          audit.write({ type: 'error', phase: 'text', message: caught.message });
          return { kind: 'fallback', reason: 'text_helper_unavailable' };
        }
        throw caught;
      }
    }

    // Risk assessment and approval.
    const assessment = assessRisk({
      operation: decision.operation,
      action,
      url: snapshot.url,
      ...(snapshot.text ? { context: snapshot.text } : {}),
    });
    const textSummary = text === undefined ? undefined : redactor.summarizeTyped(text);
    audit.write({
      type: 'risk',
      operation: decision.operation,
      label: action.label,
      risk: assessment.risk,
      reasons: assessment.reasons,
    });

    const needsPrompt = config.review || assessment.requiresApproval;
    let approved = true;
    if (needsPrompt) {
      const request = {
        url: snapshot.url,
        source: 'jev' as const,
        operation: decision.operation,
        actionLabel: action.label,
        targetDescription: `${action.role ?? action.kind} — ${action.label}`,
        ...(textSummary ? { textSummary } : {}),
        assessment,
      };
      const gateDecision =
        config.review && this.deps.gate.review
          ? await this.deps.gate.review(request)
          : await this.deps.gate.request(request);
      approved = gateDecision.approved;
      audit.write({
        type: 'approval',
        operation: decision.operation,
        label: action.label,
        risk: assessment.risk,
        approved,
        by: gateDecision.by,
        reason: gateDecision.reason,
      });
      if (!approved) {
        return {
          kind: 'stopped',
          status: 'stopped_by_approval',
          error: `Action not approved: ${gateDecision.reason}`,
        };
      }
    }

    // Execute. Any failure here aborts the step; nothing is retried.
    const startedAt = this.now;
    try {
      await this.deps.executor.act(action, snapshot, text);
    } catch (caught) {
      if (caught instanceof StalePageError) {
        this.registerStale(caught.message);
        this.pendingText = undefined;
        return { kind: 'stale', snapshot: await this.observe() };
      }
      if (caught instanceof UnsafeActionError) {
        audit.write({ type: 'error', phase: 'execute', message: caught.message });
        return { kind: 'fallback', reason: 'decision_error' };
      }
      throw caught;
    }

    this.pendingText = undefined;
    this.consecutiveStale = 0;
    this.jevSteps += 1;

    const record: ActionRecord = {
      step: this.history.length + 1,
      source: 'jev',
      operation: decision.operation,
      kind: action.kind,
      actionId: action.id,
      label: action.label,
      url: snapshot.url,
      ...(textSummary ? { textSummary } : {}),
      risk: assessment.risk,
      approved: needsPrompt ? true : undefined,
      pageChanged: null,
      fingerprintBefore: snapshot.fingerprint,
      startedAt,
      finishedAt: this.now,
      effectUncertain: action.kind !== 'wait' && action.kind !== 'scroll',
    };
    // Recorded before observing: a navigation that interrupts the post-action
    // observation must not erase the fact that the action was dispatched.
    this.history.push(record);
    audit.write({ type: 'execution', ...record });

    const next = await this.observe();
    record.fingerprintAfter = next.fingerprint;
    record.pageChanged = next.fingerprint !== snapshot.fingerprint;
    audit.write({
      type: 'execution',
      step: record.step,
      phase: 'observed',
      pageChanged: record.pageChanged,
      url: next.url,
      fingerprintAfter: next.fingerprint,
    });

    if (action.kind === 'wait') {
      this.noProgress = 0;
    } else if (record.pageChanged) {
      this.noProgress = 0;
    } else {
      this.noProgress += 1;
    }
    return { kind: 'executed', snapshot: next };
  }

  /**
   * Hand the task to Pi. Returns the fresh post-fallback observation when the
   * fallback ran, or undefined when there is no fallback available.
   */
  private async maybeFallback(
    goal: string,
    snapshot: JevSnapshot,
    reason: FallbackReason,
  ): Promise<JevSnapshot | undefined> {
    const { config, audit } = this.deps;
    if (config.mode === 'fast' || !this.deps.fallback?.available) {
      this.note(`No fallback available for "${reason}"; stopping instead of guessing.`);
      return undefined;
    }
    if (this.piFallbacks >= 3) {
      this.note('Fallback budget exhausted (3 Pi legs); stopping instead of looping.');
      return undefined;
    }

    const stopCondition =
      `Stop as soon as the goal is demonstrably satisfied on the page, or as soon as you establish it cannot be ` +
      `satisfied without a prohibited action. Budget: ${config.maxSteps - this.history.length} further steps.`;
    const context = buildHandoff(goal, snapshot, this.history, reason, stopCondition);

    this.fallbackReasons.push(reason);
    this.piFallbacks += 1;
    audit.write({
      type: 'fallback_start',
      reason,
      url: context.currentUrl,
      mustNotRepeat: context.mustNotRepeat,
      completedActions: context.completedActions.length,
    });

    let outcome: FallbackOutcome;
    try {
      outcome = await this.deps.fallback.run(context);
    } catch (caught) {
      const message = this.deps.redactor.redact(caught instanceof Error ? caught.message : String(caught));
      audit.write({ type: 'fallback_end', reason, status: 'error', message });
      this.note(`Pi fallback failed: ${message}`);
      return undefined;
    }

    const record: ActionRecord = {
      step: this.history.length + 1,
      source: 'pi',
      operation: 'PI_FALLBACK',
      kind: 'pi',
      actionId: `pi:${this.piFallbacks}`,
      label: `Pi fallback (${reason})`,
      url: context.currentUrl,
      risk: 'medium',
      pageChanged: null,
      fingerprintBefore: snapshot.fingerprint,
      startedAt: this.now,
      finishedAt: this.now,
      effectUncertain: true,
    };
    this.history.push(record);

    audit.write({
      type: 'fallback_end',
      reason,
      status: outcome.status,
      steps: outcome.steps,
      durationMs: outcome.durationMs,
      blockedActions: outcome.blockedActions,
    });

    // Control returns to Jev only through a fresh observation: a new
    // fingerprint, new node ids, and no surviving decision.
    this.usedPiOnce = true;
    this.consecutiveStale = 0;
    this.noProgress = 0;
    this.pendingText = undefined;
    const next = await this.observe();
    record.fingerprintAfter = next.fingerprint;
    record.pageChanged = next.fingerprint !== snapshot.fingerprint;
    return next;
  }

  private async verify(goal: string, snapshot: JevSnapshot) {
    const verification = await verifyOutcome(goal, snapshot, this.history, {
      ...(this.deps.typeSafe ? { client: this.deps.typeSafe } : {}),
      model: this.deps.config.typesafe.model,
      domainPolicy: this.deps.domainPolicy,
      ...(this.deps.signal ? { signal: this.deps.signal } : {}),
    });
    this.deps.audit.write({ type: 'verification', ...verification });
    return verification;
  }

  private finish(
    status: RunStatus,
    goal: string,
    startUrl: string,
    finalUrl: string,
    startedAt: number,
    verification: RunOutcome['verification'],
    error?: string,
  ): RunOutcome {
    const outcome: RunOutcome = {
      status,
      goal,
      startUrl,
      finalUrl,
      steps: this.history.length,
      jevSteps: this.jevSteps,
      piFallbacks: this.piFallbacks,
      history: this.history,
      verification,
      fallbackReasons: this.fallbackReasons,
      durationMs: this.now - startedAt,
      auditLogPath: this.deps.audit.path,
      notes: this.notes,
    };
    if (error) outcome.error = this.deps.redactor.redact(error);
    if (this.usedPiOnce) outcome.notes.push('At least one step was executed by the Browser Use Pi fallback.');
    this.deps.audit.write({
      type: 'run_end',
      status: outcome.status,
      steps: outcome.steps,
      jevSteps: outcome.jevSteps,
      piFallbacks: outcome.piFallbacks,
      verified: verification.verified,
      verdict: verification.verdict,
      durationMs: outcome.durationMs,
    });
    return outcome;
  }
}
