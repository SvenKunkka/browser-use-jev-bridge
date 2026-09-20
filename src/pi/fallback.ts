/**
 * The Browser Use Pi fallback leg.
 *
 * Pi runs on the same session, the same tab and the same workspace as the fast
 * path. It is given a structured handoff, a hard budget, and a `beforeToolCall`
 * hook that inspects the JavaScript it is about to run.
 *
 * Honest limitation: Pi's tool is "execute arbitrary JavaScript against the
 * page", so action-level approval here is a code inspection, not a semantic
 * action gate the way it is on the Jev side. High-risk *intent* expressed in
 * the handoff is refused up front; high-risk *code* is blocked by the hook when
 * it is recognisable. This is documented in docs/SECURITY.md.
 */

import type { ApprovalGate } from '../safety/approval-policy.js';
import { assessRisk } from '../safety/approval-policy.js';
import type { HandoffContext } from '../types.js';
import type { Redactor } from '../safety/redaction.js';
import type { PiSession } from './session.js';
import { renderHandoffPrompt } from '../router/handoff.js';

export interface FallbackBudget {
  maxSteps: number;
  timeoutMs: number;
  maxCostUsd: number;
}

export interface FallbackOutcome {
  status: string;
  text: string;
  steps: number;
  durationMs: number;
  blockedActions: string[];
  costUsd?: number;
}

export interface FallbackDependencies {
  session: PiSession;
  gate: ApprovalGate;
  redactor: Redactor;
  budget: FallbackBudget;
  /** First fallback of a session uses run(); later ones keep context with followUp(). */
  useFollowUp: boolean;
  signal?: AbortSignal;
}

const HIGH_RISK_CODE =
  /(place\s*order|checkout|\bpay\b|payment|transfer|withdraw|\bdelete\b|\bremove\b|publish|\bsubmit\b|sendMessage|mailto:|setFileInputFiles)/i;

export async function runFallback(
  context: HandoffContext,
  deps: FallbackDependencies,
): Promise<FallbackOutcome> {
  const blockedActions: string[] = [];
  const started = Date.now();

  const options = {
    maxSteps: deps.budget.maxSteps,
    timeoutMs: deps.budget.timeoutMs,
    maxCostUsd: deps.budget.maxCostUsd,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };

  const prompt = renderHandoffPrompt(context);
  const result = deps.useFollowUp
    ? await deps.session.followUp(prompt, options)
    : await deps.session.run(prompt, options);

  const outcome: FallbackOutcome = {
    status: result.status,
    text: deps.redactor.redact(result.text ?? ''),
    steps: result.steps,
    durationMs: Date.now() - started,
    blockedActions,
  };
  const cost = (result.usage as { costUsd?: number } | undefined)?.costUsd;
  if (typeof cost === 'number') outcome.costUsd = cost;
  return outcome;
}

/**
 * Built separately from `runFallback` because Pi takes it at session creation.
 * Returns a hook that blocks a tool call whose code reads as a high-risk
 * browser action unless the gate approves it.
 */
export function buildBeforeToolCall(gate: ApprovalGate, redactor: Redactor, currentUrl: () => string) {
  return async (toolContext: { toolName?: string; arguments?: unknown }) => {
    const argumentText =
      typeof toolContext.arguments === 'string'
        ? toolContext.arguments
        : JSON.stringify(toolContext.arguments ?? {});
    if (!HIGH_RISK_CODE.test(argumentText)) return undefined;

    const assessment = assessRisk({
      operation: 'PI_FALLBACK',
      url: currentUrl(),
      code: argumentText,
    });
    assessment.risk = 'high';
    assessment.requiresApproval = true;
    assessment.reasons.push('fallback code matches a high-risk action pattern');

    const decision = await gate.request({
      url: currentUrl(),
      source: 'pi',
      operation: `PI_FALLBACK:${toolContext.toolName ?? 'javascript'}`,
      actionLabel: 'fallback JavaScript cell',
      targetDescription: redactor.redact(argumentText.slice(0, 400)),
      assessment,
    });
    if (decision.approved) return undefined;
    return {
      block: true,
      reason: `Blocked by browser-use-jev-bridge approval policy: ${decision.reason}`,
    };
  };
}

/** Adapter that satisfies the router's FallbackRunner port. */
export class PiFallbackRunner {
  readonly available = true;
  private used = false;

  constructor(private readonly deps: Omit<FallbackDependencies, 'useFollowUp'>) {}

  async run(context: HandoffContext): Promise<FallbackOutcome> {
    const outcome = await runFallback(context, { ...this.deps, useFollowUp: this.used });
    this.used = true;
    return outcome;
  }
}

/** Used when the operator selected `--mode fast`, or Pi could not be started. */
export class UnavailableFallbackRunner {
  readonly available = false;
  async run(): Promise<FallbackOutcome> {
    throw new Error('No Browser Use Pi fallback is available in this run.');
  }
}
