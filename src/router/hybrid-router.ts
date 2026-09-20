/**
 * The hybrid router.
 *
 * Owns the loop, the budget, the routing rules and the approval sequencing,
 * and refuses to call a run complete until the verifier agrees.
 *
 * ## Jev → Pi is one-way
 *
 * The fallback is **terminal**. Once a step is handed to Browser Use Pi, the
 * run re-observes the page, verifies, and ends. Control is not handed back to
 * the fast path.
 *
 * The reason is honesty about what we can record. Pi's tool is "run this
 * JavaScript", and a single cell may click, type and submit several times.
 * This project cannot currently enumerate those individual browser actions,
 * so it cannot populate `mustNotRepeat` for them — and without that, handing
 * control back to a policy that would plan its own next click risks repeating
 * something Pi already did. Ending the run is the safe reading of "never
 * repeat an action that may already have taken effect".
 *
 * ## Invariants
 *   - one browser session, owned by the caller and passed in as a backend;
 *   - a Decision is consumed exactly once, before any mutation;
 *   - a Decision never applies to a different page fingerprint;
 *   - nothing is retried automatically after an action reached the browser;
 *   - a single BudgetTracker covers Jev steps, Pi steps, wall clock and cost;
 *   - a denied approval — on either leg — ends the run as stopped_by_approval.
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
  VerificationResult,
} from '../types.js';
import type { BridgeConfig } from '../config.js';
import { BudgetTracker } from '../budget.js';
import type { BrowserBackend } from '../pi/session.js';
import type { JevExecutorPort } from '../jev/executor.js';
import { UnsafeActionError } from '../jev/executor.js';
import { StaleDecisionError, StalePageError, assertDecisionFresh } from '../jev/freshness.js';
import { InvalidModelResponseError, choose, type TypeSafeClient } from '../jev/policy.js';
import { TextHelperUnavailableError, fieldContext, type TextModelClient } from '../jev/text-helper.js';
import type { ApprovalGate } from '../safety/approval-policy.js';
import { assessRisk } from '../safety/approval-policy.js';
import type { DomainPolicy } from '../safety/domains.js';
import { DomainBlockedError } from '../safety/domains.js';
import type { Redactor } from '../safety/redaction.js';
import type { AuditLog } from '../logging/audit-log.js';
import { verifyOutcome } from '../verification/verifier.js';
import { buildHandoff } from './handoff.js';
import type { FallbackBudget, FallbackOutcome, PiApprovalController } from '../pi/fallback.js';

const CREDENTIAL_FIELD =
  /(password|passcode|pin\b|otp|one[- ]time|2fa|mfa|verification code|card number|cvv|cvc|iban|ssn|密码|验证码|银行卡|身份证)/i;

const UPLOAD_GOAL = /(upload|attach|附件|上传)/i;

export interface FallbackRunner {
  readonly available: boolean;
  run(context: HandoffContext, budget: FallbackBudget): Promise<FallbackOutcome>;
}

export interface RouterDependencies {
  backend: BrowserBackend;
  executor: JevExecutorPort;
  typeSafe?: TypeSafeClient;
  textModel: TextModelClient;
  fallback?: FallbackRunner;
  /** Carries the Pi-side approval state; absent in fast mode and in unit tests. */
  piController?: Pick<PiApprovalController, 'denial'>;
  gate: ApprovalGate;
  redactor: Redactor;
  domainPolicy: DomainPolicy;
  audit: AuditLog;
  config: BridgeConfig;
  budget?: BudgetTracker;
  /**
   * Called after every observation. Used to keep the Pi approval hook's idea
   * of "current URL" accurate without giving it a second view of the browser.
   */
  onUrlChange?: (url: string) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export interface UnsupportedVerdict {
  unsupported: boolean;
  reasons: string[];
}

/** Deterministic "this page is not Jev's" test. Pure, so it is unit-testable. */
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

const NOT_RUN: VerificationResult = {
  verified: false,
  verdict: 'NOT_RUN',
  confidence: null,
  reasons: ['Verification did not run.'],
  evidence: null,
  deterministicChecks: [],
};

export class HybridRouter {
  private readonly history: ActionRecord[] = [];
  private readonly fallbackReasons: FallbackReason[] = [];
  private readonly notes: string[] = [];
  private readonly budget: BudgetTracker;
  private consecutiveStale = 0;
  private noProgress = 0;
  private jevSteps = 0;
  private piFallbacks = 0;
  private baselineTabCount = 1;
  private pendingText: { key: string; text: string } | undefined;

  constructor(private readonly deps: RouterDependencies) {
    this.budget =
      deps.budget ??
      new BudgetTracker(
        {
          maxSteps: deps.config.maxSteps,
          timeoutMs: deps.config.timeoutMs,
          maxCostUsd: deps.config.maxCostUsd,
        },
        deps.now ?? Date.now,
      );
  }

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

    audit.write({
      type: 'run_start',
      goal,
      startUrl,
      mode: config.mode,
      review: config.review,
      budget: this.budget.report(),
    });

    let snapshot: JevSnapshot;
    try {
      domainPolicy.assert(startUrl);
      await this.deps.backend.goto(startUrl);
      snapshot = await this.observe();
      this.baselineTabCount = snapshot.tabCount ?? 1;
    } catch (caught) {
      const message = this.deps.redactor.redact(caught instanceof Error ? caught.message : String(caught));
      audit.write({ type: 'error', phase: 'startup', message });
      return this.finish('error', goal, startUrl, startUrl, startedAt, { ...NOT_RUN, reasons: [message] }, message);
    }

    for (;;) {
      if (this.deps.signal?.aborted) {
        return this.conclude('error', goal, startUrl, snapshot, startedAt, 'Run cancelled.');
      }

      const exhausted = this.budget.exhausted();
      if (exhausted) {
        this.note(`Budget exhausted (${exhausted}).`);
        return this.conclude(exhausted, goal, startUrl, snapshot, startedAt);
      }

      // ---- routing: does this page belong to Pi? --------------------------
      if (config.mode === 'pi') {
        return this.concludeViaFallback(goal, startUrl, snapshot, 'operator_request', startedAt);
      }
      if (config.mode !== 'fast') {
        const verdict = detectUnsupported(snapshot, goal, this.baselineTabCount);
        if (verdict.unsupported) {
          this.note(`Routed to Pi: ${verdict.reasons.join('; ')}`);
          return this.concludeViaFallback(goal, startUrl, snapshot, 'unsupported_page', startedAt);
        }
      }
      if (this.jevSteps >= config.thresholds.jevMaxSteps) {
        return this.concludeViaFallback(goal, startUrl, snapshot, 'step_limit', startedAt);
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
        audit.write({ type: 'error', phase: 'decide', message });
        if (this.canFallback()) {
          return this.concludeViaFallback(goal, startUrl, snapshot, 'decision_error', startedAt);
        }
        return this.conclude('error', goal, startUrl, snapshot, startedAt, message);
      }

      audit.write({
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
        return this.concludeViaFallback(goal, startUrl, snapshot, 'jev_blocked', startedAt);
      }

      if (decision.operation === 'DONE') {
        const claimedAt = this.now;
        if (!(await this.deps.executor.isFresh(snapshot))) {
          snapshot = await this.observe();
          this.registerStale('page changed before DONE could be accepted');
          continue;
        }
        const fresh = await this.observe();
        const verification = await this.verify(goal, fresh, claimedAt);
        if (verification.verified) {
          return this.finish('completed', goal, startUrl, fresh.url, startedAt, verification);
        }
        this.note(`DONE was claimed but not verified (${verification.verdict}).`);
        return this.finish('unverified', goal, startUrl, fresh.url, startedAt, verification);
      }

      // ---- resolve the concrete action ------------------------------------
      const action = snapshot.actions.find((candidate) => candidate.id === decision.choice);
      if (!action) {
        audit.write({
          type: 'error',
          phase: 'resolve',
          message: `Decision referenced action "${decision.choice}" which is not in this observation.`,
        });
        return this.conclude(
          'error',
          goal,
          startUrl,
          snapshot,
          startedAt,
          'Decision referenced an action that was not observed.',
        );
      }

      const stepResult = await this.executeStep(goal, snapshot, decision, action);
      if (stepResult.kind === 'stopped') {
        return this.conclude(stepResult.status, goal, startUrl, snapshot, startedAt, stepResult.error);
      }
      if (stepResult.kind === 'stale') {
        snapshot = stepResult.snapshot;
        if (this.consecutiveStale >= config.thresholds.maxConsecutiveStale) {
          return this.concludeViaFallback(goal, startUrl, snapshot, 'stale_repeated', startedAt);
        }
        continue;
      }
      if (stepResult.kind === 'fallback') {
        return this.concludeViaFallback(goal, startUrl, snapshot, stepResult.reason, startedAt);
      }

      snapshot = stepResult.snapshot;
      if (this.noProgress >= config.thresholds.maxNoProgress) {
        return this.concludeViaFallback(goal, startUrl, snapshot, 'no_progress', startedAt);
      }
    }
  }

  // -------------------------------------------------------------------------

  private canFallback(): boolean {
    return this.deps.config.mode !== 'fast' && Boolean(this.deps.fallback?.available);
  }

  private async observe(): Promise<JevSnapshot> {
    const snapshot = await this.deps.executor.observe();
    this.deps.onUrlChange?.(snapshot.url);
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

    try {
      this.deps.domainPolicy.assert(snapshot.url);
      if (action.href) this.deps.domainPolicy.assert(new URL(action.href, snapshot.url).toString());
    } catch (caught) {
      if (caught instanceof DomainBlockedError) {
        audit.write({ type: 'error', phase: 'domain', message: caught.message, url: caught.url });
        return { kind: 'stopped', status: 'blocked', error: caught.message };
      }
      throw caught;
    }

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

    const assessment = assessRisk({
      operation: decision.operation,
      action,
      url: snapshot.url,
      ...(snapshot.text ? { context: snapshot.text } : {}),
    });
    const textSummary = text === undefined ? undefined : redactor.summarizeTyped(text);
    audit.write({
      type: 'risk',
      source: 'jev',
      operation: decision.operation,
      label: action.label,
      risk: assessment.risk,
      reasons: assessment.reasons,
    });

    const needsPrompt = config.review || assessment.requiresApproval;
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
      audit.write({
        type: 'approval',
        source: 'jev',
        operation: decision.operation,
        label: action.label,
        risk: assessment.risk,
        approved: gateDecision.approved,
        by: gateDecision.by,
        reason: gateDecision.reason,
      });
      if (!gateDecision.approved) {
        return {
          kind: 'stopped',
          status: 'stopped_by_approval',
          error: `Action not approved: ${gateDecision.reason}`,
        };
      }
    }

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
    this.budget.recordJevStep();

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

    if (action.kind === 'wait' || record.pageChanged) this.noProgress = 0;
    else this.noProgress += 1;

    return { kind: 'executed', snapshot: next };
  }

  /**
   * Hand the run to Pi and finish. This never returns control to Jev — see the
   * module header for why.
   */
  private async concludeViaFallback(
    goal: string,
    startUrl: string,
    snapshot: JevSnapshot,
    reason: FallbackReason,
    startedAt: number,
  ): Promise<RunOutcome> {
    const { config, audit } = this.deps;

    if (!this.canFallback()) {
      this.note(`No fallback available for "${reason}"; stopping instead of guessing.`);
      const status: RunStatus = reason === 'step_limit' ? 'step_limit' : 'blocked';
      return this.conclude(status, goal, startUrl, snapshot, startedAt);
    }
    if (!this.budget.canStartFallback()) {
      const exhausted = this.budget.exhausted() ?? 'step_limit';
      this.note(`Not enough budget left to start a Pi fallback (${exhausted}).`);
      return this.conclude(exhausted, goal, startUrl, snapshot, startedAt);
    }

    const remaining = this.budget.remaining();
    const stopCondition =
      'Stop as soon as the goal is demonstrably satisfied on the page, or as soon as you establish it cannot be ' +
      `satisfied without a prohibited action. Remaining budget: ${remaining.steps} steps, ` +
      `${Math.round(remaining.timeMs / 1000)} s, $${remaining.costUsd.toFixed(4)}.`;
    const context = buildHandoff(goal, snapshot, this.history, reason, stopCondition);

    // The stated intent is assessed before any code exists, so a consequential
    // goal is caught even when the model has not yet written a cell.
    const intentRisk = assessRisk({ operation: 'PI_FALLBACK', url: snapshot.url, intent: goal });
    audit.write({
      type: 'risk',
      source: 'pi',
      phase: 'intent',
      risk: intentRisk.risk,
      reasons: intentRisk.reasons,
      reasonForFallback: reason,
    });
    if (intentRisk.requiresApproval || config.review) {
      const decision = await (config.review && this.deps.gate.review
        ? this.deps.gate.review({
            url: snapshot.url,
            source: 'pi',
            operation: 'PI_FALLBACK:start',
            actionLabel: `hand the task to Browser Use Pi (${reason})`,
            targetDescription: goal,
            assessment: intentRisk,
          })
        : this.deps.gate.request({
            url: snapshot.url,
            source: 'pi',
            operation: 'PI_FALLBACK:start',
            actionLabel: `hand the task to Browser Use Pi (${reason})`,
            targetDescription: goal,
            assessment: intentRisk,
          }));
      audit.write({
        type: 'approval',
        source: 'pi',
        phase: 'intent',
        approved: decision.approved,
        by: decision.by,
        reason: decision.reason,
        risk: intentRisk.risk,
      });
      if (!decision.approved) {
        this.note(`Pi fallback not approved: ${decision.reason}`);
        return this.conclude(
          'stopped_by_approval',
          goal,
          startUrl,
          snapshot,
          startedAt,
          `Fallback not approved: ${decision.reason}`,
        );
      }
    }

    this.fallbackReasons.push(reason);
    this.piFallbacks += 1;
    audit.write({
      type: 'fallback_start',
      reason,
      url: context.currentUrl,
      mustNotRepeat: context.mustNotRepeat,
      completedActions: context.completedActions.length,
      budget: this.budget.report(),
    });

    const legBudget: FallbackBudget = {
      maxSteps: remaining.steps,
      timeoutMs: remaining.timeMs,
      maxCostUsd: remaining.costUsd,
    };

    let outcome: FallbackOutcome;
    try {
      outcome = await this.deps.fallback!.run(context, legBudget);
    } catch (caught) {
      const message = this.deps.redactor.redact(caught instanceof Error ? caught.message : String(caught));
      audit.write({ type: 'fallback_end', reason, status: 'error', message });
      this.note(`Pi fallback failed: ${message}`);
      this.budget.recordPiRun(1, 0);
      return this.conclude('error', goal, startUrl, snapshot, startedAt, message);
    }

    this.budget.recordPiRun(outcome.steps, outcome.costUsd);

    const record: ActionRecord = {
      step: this.history.length + 1,
      source: 'pi',
      operation: 'PI_FALLBACK',
      kind: 'pi',
      actionId: `pi:${this.piFallbacks}`,
      label: `Pi fallback (${reason}) — ${outcome.steps} Pi step(s); individual browser actions are not enumerated`,
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
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      blockedActions: outcome.blockedActions,
      budget: this.budget.report(),
    });

    const denial = this.deps.piController?.denial;
    const claimedAt = this.now;
    const fresh = await this.observe().catch(() => snapshot);
    record.fingerprintAfter = fresh.fingerprint;
    record.pageChanged = fresh.fingerprint !== snapshot.fingerprint;

    if (denial) {
      this.note(
        `A Browser Use Pi tool call (${denial.toolName}) was not approved, so the run stopped: ${denial.reason}`,
      );
      return this.conclude(
        'stopped_by_approval',
        goal,
        startUrl,
        fresh,
        startedAt,
        `Pi tool call "${denial.toolName}" not approved: ${denial.reason}`,
      );
    }

    this.note(
      'The Browser Use Pi fallback is terminal: the run ends here rather than returning to the fast path, ' +
        'because this version cannot enumerate the individual browser actions Pi performed.',
    );
    const verification = await this.verify(goal, fresh, claimedAt);
    return this.finish(
      verification.verified ? 'completed' : 'unverified',
      goal,
      startUrl,
      fresh.url,
      startedAt,
      verification,
    );
  }

  /** End the run on a non-completion path, still running the verifier. */
  private async conclude(
    status: RunStatus,
    goal: string,
    startUrl: string,
    snapshot: JevSnapshot,
    startedAt: number,
    error?: string,
  ): Promise<RunOutcome> {
    const verification =
      status === 'stopped_by_approval'
        ? { ...NOT_RUN, reasons: ['Verification was not run because the run stopped for approval.'] }
        : await this.verify(goal, snapshot).catch(() => NOT_RUN);
    return this.finish(status, goal, startUrl, snapshot.url, startedAt, verification, error);
  }

  private async verify(goal: string, snapshot: JevSnapshot, claimedAt?: number): Promise<VerificationResult> {
    const verification = await verifyOutcome(goal, snapshot, this.history, {
      ...(this.deps.typeSafe ? { client: this.deps.typeSafe } : {}),
      model: this.deps.config.typesafe.model,
      domainPolicy: this.deps.domainPolicy,
      thresholds: this.deps.config.verification,
      ...(claimedAt !== undefined ? { claimedAt } : {}),
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
    verification: VerificationResult,
    error?: string,
  ): RunOutcome {
    if (status === 'completed' && !verification.verified) status = 'unverified';
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
      budget: this.budget.report(),
      auditLogPath: this.deps.audit.path,
      notes: this.notes,
    };
    if (error) outcome.error = this.deps.redactor.redact(error);
    this.deps.audit.write({
      type: 'run_end',
      status: outcome.status,
      steps: outcome.steps,
      jevSteps: outcome.jevSteps,
      piFallbacks: outcome.piFallbacks,
      verified: verification.verified,
      verdict: verification.verdict,
      durationMs: outcome.durationMs,
      budget: outcome.budget,
    });
    return outcome;
  }
}
