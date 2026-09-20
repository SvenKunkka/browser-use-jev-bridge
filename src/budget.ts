/**
 * One budget for the whole run.
 *
 * Before this existed, each Pi fallback leg was handed the *initial* step,
 * time and cost limits, so two fallbacks could legally spend twice the budget
 * the operator set. The tracker below is the single accounting point: the Jev
 * fast path reports each executed step, every Pi leg reports the steps and
 * cost it actually consumed, and a fallback is only ever offered what is left.
 *
 * Cost accounting covers the Browser Use Pi legs, because `RunResult.usage`
 * reports `usage.cost.total`. The Jev fast path's TypeSafe and text-model
 * calls do not return a price, so they consume steps and time but contribute
 * 0 to the cost total. That is a real gap and it is documented rather than
 * papered over.
 */

export type BudgetExhaustion = 'step_limit' | 'timeout' | 'cost_limit';

export interface BudgetLimits {
  maxSteps: number;
  timeoutMs: number;
  maxCostUsd: number;
}

export interface BudgetRemaining {
  steps: number;
  timeMs: number;
  costUsd: number;
}

export interface BudgetReport {
  limits: BudgetLimits;
  used: { steps: number; jevSteps: number; piSteps: number; elapsedMs: number; costUsd: number };
  remaining: BudgetRemaining;
  exhausted: BudgetExhaustion | null;
}

export class BudgetTracker {
  private jevSteps = 0;
  private piSteps = 0;
  private costUsd = 0;
  private readonly startedAt: number;

  constructor(
    readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get deadline(): number {
    return this.startedAt + this.limits.timeoutMs;
  }

  get usedSteps(): number {
    return this.jevSteps + this.piSteps;
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  get spentUsd(): number {
    return this.costUsd;
  }

  recordJevStep(count = 1): void {
    this.jevSteps += count;
  }

  /** A Pi leg reports what it actually consumed, not what it was offered. */
  recordPiRun(steps: number, costUsd = 0): void {
    this.piSteps += Number.isFinite(steps) && steps > 0 ? steps : 1;
    if (Number.isFinite(costUsd) && costUsd > 0) this.costUsd += costUsd;
  }

  remaining(): BudgetRemaining {
    return {
      steps: Math.max(0, this.limits.maxSteps - this.usedSteps),
      timeMs: Math.max(0, this.deadline - this.now()),
      costUsd: Math.max(0, this.limits.maxCostUsd - this.costUsd),
    };
  }

  exhausted(): BudgetExhaustion | null {
    const remaining = this.remaining();
    if (remaining.timeMs <= 0) return 'timeout';
    if (remaining.costUsd <= 0) return 'cost_limit';
    if (remaining.steps <= 0) return 'step_limit';
    return null;
  }

  /** True when there is enough left for a fallback leg to be worth starting. */
  canStartFallback(): boolean {
    const remaining = this.remaining();
    return remaining.steps >= 1 && remaining.timeMs > 1_000 && remaining.costUsd > 0;
  }

  report(): BudgetReport {
    return {
      limits: this.limits,
      used: {
        steps: this.usedSteps,
        jevSteps: this.jevSteps,
        piSteps: this.piSteps,
        elapsedMs: this.elapsedMs,
        costUsd: Number(this.costUsd.toFixed(6)),
      },
      remaining: this.remaining(),
      exhausted: this.exhausted(),
    };
  }

  /**
   * A signal that fires when the run's wall-clock deadline passes, so an
   * in-flight Pi run is cut off rather than only being noticed at the top of
   * the next loop iteration.
   */
  deadlineSignal(extra?: AbortSignal): AbortSignal {
    const remaining = Math.max(1, this.remaining().timeMs);
    const timeout = AbortSignal.timeout(remaining);
    return extra ? AbortSignal.any([extra, timeout]) : timeout;
  }
}
