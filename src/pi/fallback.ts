/**
 * The Browser Use Pi fallback leg, and the approval gate that sits in front of
 * every tool call Pi makes.
 *
 * Two things were wrong before and are fixed here:
 *
 *  1. `beforeToolCall` was built but never handed to `BrowserUse.create()`, so
 *     nothing on the Pi side was ever gated. It is now passed in at session
 *     creation (the only place Pi accepts it) through a controller whose state
 *     the router owns per run.
 *  2. The hook read `toolContext.arguments` and `toolContext.toolName`, which
 *     do not exist. Pi 0.1.0 forwards `@earendil-works/pi-agent-core`'s
 *     `BeforeToolCallContext`: `{ assistantMessage, toolCall, args, context }`,
 *     where the tool name is `toolCall.name` and the validated arguments are
 *     `args`. The types below are *derived from* `BrowserUse.create`'s own
 *     parameter type, so a change upstream breaks the build instead of
 *     silently disabling the gate.
 */

import type { BrowserUse } from '@browser_use/pi';
import type { ApprovalGate } from '../safety/approval-policy.js';
import { assessRisk } from '../safety/approval-policy.js';
import type { ApprovalDecision, HandoffContext, RiskAssessment } from '../types.js';
import type { Redactor } from '../safety/redaction.js';
import type { AuditLog } from '../logging/audit-log.js';
import type { PiSession } from './session.js';
import { renderHandoffPrompt } from '../router/handoff.js';

type CreateOptions = Parameters<typeof BrowserUse.create>[0];
/** Exactly the hook signature Pi accepts — derived, never hand-written. */
export type PiBeforeToolCall = NonNullable<CreateOptions['beforeToolCall']>;
export type PiBeforeToolCallContext = Parameters<PiBeforeToolCall>[0];
export type PiBeforeToolCallResult = Awaited<ReturnType<PiBeforeToolCall>>;

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
  costUsd: number;
  blockedActions: string[];
}

/** Tool calls that only deliver a result; they touch no page. */
const DELIVERY_TOOLS = new Set(['finish', 'finish_from_js']);

/**
 * Patterns that make a Pi JavaScript cell high risk on its own.
 * This is a *backstop*, not the primary control: the primary controls are the
 * pre-leg intent approval and, in --review, the per-call prompt. See
 * docs/SECURITY.md for what this can and cannot catch.
 */
const HIGH_RISK_CODE =
  /(place\s*order|checkout|\bpay\b|payment|purchase|transfer|withdraw|\bdelete\b|\bremove\b|publish|\bsubmit\b|sendMessage|mailto:|setFileInputFiles|\bbuy\b|下单|支付|付款|购买|删除|发布|提交|上传)/i;

export function describeToolCall(name: string, args: unknown): string {
  if (name === 'javascript') {
    const code = (args as { code?: unknown })?.code;
    return typeof code === 'string' ? code : JSON.stringify(args ?? {});
  }
  if (name === 'finish_from_js') {
    const expression = (args as { expression?: unknown })?.expression;
    return typeof expression === 'string' ? expression : JSON.stringify(args ?? {});
  }
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '[unserialisable tool arguments]';
  }
}

export interface PiApprovalControllerDeps {
  gate: ApprovalGate;
  redactor: Redactor;
  audit: AuditLog;
  /** True when every Pi tool call must be shown to a human first. */
  review: boolean;
  currentUrl: () => string;
}

export interface PiDenial {
  toolName: string;
  reason: string;
  risk: RiskAssessment;
}

/**
 * Owns the per-run state the hook needs. One instance is created per run and
 * its `hook` is handed to `BrowserUse.create`, because Pi takes the hook at
 * session creation rather than per `run()` call.
 */
export class PiApprovalController {
  /** Set while a fallback leg is in flight. */
  private active = false;
  /** Called on denial so the in-flight Pi run is cut off immediately. */
  private abort: (() => void) | undefined;
  readonly reviewed: { toolName: string; approved: boolean }[] = [];
  denial: PiDenial | undefined;

  constructor(private readonly deps: PiApprovalControllerDeps) {
    this.hook = this.hook.bind(this);
  }

  beginLeg(abort: () => void): void {
    this.active = true;
    this.abort = abort;
  }

  endLeg(): void {
    this.active = false;
    this.abort = undefined;
  }

  get isActive(): boolean {
    return this.active;
  }

  async hook(context: PiBeforeToolCallContext): Promise<PiBeforeToolCallResult> {
    const toolName = context.toolCall.name;
    const detail = describeToolCall(toolName, context.args);
    const url = this.deps.currentUrl();

    const assessment = assessRisk({
      operation: 'PI_FALLBACK',
      url,
      code: detail,
    });
    if (!DELIVERY_TOOLS.has(toolName) && HIGH_RISK_CODE.test(detail)) {
      assessment.risk = 'high';
      assessment.requiresApproval = true;
      if (!assessment.reasons.includes('fallback code matches a high-risk action pattern')) {
        assessment.reasons.push('fallback code matches a high-risk action pattern');
      }
    }

    const mustPrompt = this.deps.review || assessment.requiresApproval;
    this.deps.audit.write({
      type: 'risk',
      source: 'pi',
      tool: toolName,
      toolCallId: context.toolCall.id,
      risk: assessment.risk,
      reasons: assessment.reasons,
      prompted: mustPrompt,
      detail: this.deps.redactor.redact(detail.slice(0, 600)),
    });
    if (!mustPrompt) return undefined;

    const request = {
      url,
      source: 'pi' as const,
      operation: `PI_FALLBACK:${toolName}`,
      actionLabel: toolName === 'javascript' ? 'Pi JavaScript cell' : `Pi ${toolName}`,
      targetDescription: this.deps.redactor.redact(detail.slice(0, 600)),
      assessment,
    };

    let decision: ApprovalDecision;
    if (this.deps.review && this.deps.gate.review) decision = await this.deps.gate.review(request);
    else decision = await this.deps.gate.request(request);

    this.reviewed.push({ toolName, approved: decision.approved });
    this.deps.audit.write({
      type: 'approval',
      source: 'pi',
      tool: toolName,
      toolCallId: context.toolCall.id,
      risk: assessment.risk,
      approved: decision.approved,
      by: decision.by,
      reason: decision.reason,
    });

    if (decision.approved) return undefined;

    this.denial = { toolName, reason: decision.reason, risk: assessment };
    // Stop the leg outright. A blocked call alone would let the model try a
    // differently-worded action on the next turn.
    this.abort?.();
    return {
      block: true,
      terminate: true,
      reason: `Blocked by browser-use-jev-bridge approval policy: ${decision.reason}`,
    };
  }
}

export interface FallbackDependencies {
  session: PiSession;
  redactor: Redactor;
  budget: FallbackBudget;
  controller: PiApprovalController;
  /** The first leg of a session uses run(); later ones keep context with followUp(). */
  useFollowUp: boolean;
  signal?: AbortSignal;
}

export async function runFallback(
  context: HandoffContext,
  deps: FallbackDependencies,
): Promise<FallbackOutcome> {
  const started = Date.now();
  const leg = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, leg.signal]) : leg.signal;
  deps.controller.beginLeg(() => leg.abort());

  const options = {
    maxSteps: Math.max(1, Math.floor(deps.budget.maxSteps)),
    timeoutMs: Math.max(1, Math.floor(deps.budget.timeoutMs)),
    maxCostUsd: deps.budget.maxCostUsd,
    signal,
  };

  const prompt = renderHandoffPrompt(context);
  try {
    const result = deps.useFollowUp
      ? await deps.session.followUp(prompt, options)
      : await deps.session.run(prompt, options);
    return {
      status: result.status,
      text: deps.redactor.redact(result.text ?? ''),
      steps: result.steps,
      durationMs: Date.now() - started,
      costUsd: result.usage?.cost?.total ?? 0,
      blockedActions: deps.controller.reviewed.filter((entry) => !entry.approved).map((entry) => entry.toolName),
    };
  } catch (error) {
    // An abort raised by the approval denial is an expected control-flow exit.
    const message = error instanceof Error ? error.message : String(error);
    if (deps.controller.denial || leg.signal.aborted) {
      return {
        status: 'cancelled',
        text: deps.redactor.redact(message),
        steps: 1,
        durationMs: Date.now() - started,
        costUsd: 0,
        blockedActions: deps.controller.reviewed.filter((entry) => !entry.approved).map((entry) => entry.toolName),
      };
    }
    throw error;
  } finally {
    deps.controller.endLeg();
  }
}

/** Adapter that satisfies the router's FallbackRunner port. */
export class PiFallbackRunner {
  readonly available = true;
  private used = false;

  constructor(private readonly deps: Omit<FallbackDependencies, 'useFollowUp' | 'budget'>) {}

  async run(context: HandoffContext, budget: FallbackBudget): Promise<FallbackOutcome> {
    const outcome = await runFallback(context, { ...this.deps, budget, useFollowUp: this.used });
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
