/** Shared builders for the offline unit tests. No browser, no network. */

import { loadConfig, type BridgeConfig } from '../src/config.js';
import { fingerprintSnapshot } from '../src/jev/freshness.js';
import type { ActOptions, JevExecutorPort } from '../src/jev/executor.js';
import type { BrowserBackend, PageInfo } from '../src/pi/session.js';
import type { FallbackRunner } from '../src/router/hybrid-router.js';
import type { FallbackBudget, FallbackOutcome } from '../src/pi/fallback.js';
import type { HandoffContext, JevRawAction, JevSnapshot, RiskAssessment, UnsupportedSignals } from '../src/types.js';

export const NO_UNSUPPORTED: UnsupportedSignals = {
  iframes: 0,
  crossOriginIframes: 0,
  fileInputs: 0,
  canvases: 0,
  shadowRoots: 0,
  openDialogs: 0,
  passwordFields: 0,
};

export function makeAction(overrides: Partial<JevRawAction> & { id: string }): JevRawAction {
  return {
    kind: 'click',
    label: overrides.label ?? overrides.id,
    ...overrides,
  } as JevRawAction;
}

export function makeSnapshot(overrides: Partial<JevSnapshot> = {}): JevSnapshot {
  const actions: JevRawAction[] = overrides.actions ?? [
    makeAction({ id: 'e1', kind: 'click', label: 'Next page', node: 1, role: 'button' }),
    makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
  ];
  const base = {
    url: overrides.url ?? 'https://example.com/list',
    title: overrides.title ?? 'List',
    w: 1120,
    h: 780,
    text: overrides.text ?? 'Page one of results',
    scroll: overrides.scroll ?? { y: 0, height: 780 },
    actions,
    marker: overrides.marker ?? 'marker-1',
    pageKey: overrides.pageKey ?? 'pagekey-1',
    guards: overrides.guards ?? Object.fromEntries(actions.filter((a) => a.node).map((a) => [String(a.node), `guard-${a.node}`])),
    omittedActions: 0,
    unsupported: overrides.unsupported ?? NO_UNSUPPORTED,
    tabCount: overrides.tabCount ?? 1,
  };
  return {
    ...base,
    fingerprint: overrides.fingerprint ?? fingerprintSnapshot(base),
    observedAt: overrides.observedAt ?? Date.now(),
  };
}

/** Replays a fixed list of observations; records every action it was asked to run. */
export class FakeExecutor implements JevExecutorPort {
  readonly executed: { action: JevRawAction; text?: string }[] = [];
  readonly observations: JevSnapshot[] = [];
  fresh = true;
  nodeFresh = true;
  actError: (() => Error) | undefined;
  /** When true, actError is reported as a preflight failure (nothing dispatched). */
  failBeforeDispatch = true;

  constructor(private readonly queue: JevSnapshot[]) {}

  async observe(): Promise<JevSnapshot> {
    const next = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
    // Stamp the observation like the real executor does, so freshness checks
    // that compare against a claim timestamp behave as they do in production.
    next.observedAt = Date.now();
    this.observations.push(next);
    return next;
  }
  async isFresh(): Promise<boolean> {
    return this.fresh;
  }
  async isNodeFresh(): Promise<boolean> {
    return this.nodeFresh;
  }
  async act(action: JevRawAction, _snapshot: JevSnapshot, options: ActOptions = {}): Promise<void> {
    const effectPossible = action.kind !== 'wait' && action.kind !== 'scroll';
    if (this.actError) {
      // A fake that fails "before dispatch" reports a preflight failure, so
      // the router can still treat it as safe to re-plan.
      if (this.failBeforeDispatch) {
        options.onPhase?.({ phase: 'preflight_failed', detail: 'fake preflight failure', effectPossible: false, at: Date.now() });
      } else {
        options.onPhase?.({ phase: 'dispatch_started', detail: 'fake dispatch', effectPossible, at: Date.now() });
        options.onPhase?.({ phase: 'effect_uncertain', detail: 'fake partial dispatch', effectPossible: true, at: Date.now() });
      }
      throw this.actError();
    }
    options.onPhase?.({ phase: 'dispatch_started', detail: 'fake dispatch', effectPossible, at: Date.now() });
    options.onPhase?.({ phase: 'dispatched', detail: 'fake dispatch complete', effectPossible, at: Date.now() });
    this.executed.push(options.text === undefined ? { action } : { action, text: options.text });
  }
}

export class FakeBackend implements BrowserBackend {
  readonly visited: string[] = [];
  constructor(private readonly page: PageInfo = { url: 'https://example.com/list', title: 'List' }) {}
  async evaluateInPage<T>(): Promise<T> {
    throw new Error('FakeBackend.evaluateInPage should not be reached in unit tests.');
  }
  async cdp(): Promise<unknown> {
    throw new Error('FakeBackend.cdp should not be reached in unit tests.');
  }
  async cdpBatch(): Promise<void> {
    throw new Error('FakeBackend.cdpBatch should not be reached in unit tests.');
  }
  async info(): Promise<PageInfo> {
    return this.page;
  }
  async goto(url: string): Promise<PageInfo> {
    this.visited.push(url);
    return { url, title: this.page.title };
  }
  async tabCount(): Promise<number> {
    return 1;
  }
}

export class FakeFallback implements FallbackRunner {
  readonly available = true;
  readonly calls: HandoffContext[] = [];
  readonly budgets: FallbackBudget[] = [];
  constructor(private readonly outcome: Partial<FallbackOutcome> = {}) {}
  async run(context: HandoffContext, budget: FallbackBudget): Promise<FallbackOutcome> {
    this.calls.push(context);
    this.budgets.push(budget);
    return {
      status: 'completed',
      text: 'fallback finished',
      steps: 1,
      durationMs: 5,
      costUsd: 0,
      blockedActions: [],
      ...this.outcome,
    };
  }
}

/** A controller stand-in that reports a denial the router must honour. */
export function deniedController(toolName = 'javascript', reason = 'operator declined') {
  return {
    denial: {
      toolName,
      reason,
      risk: { risk: 'high', reasons: ['test'], requiresApproval: true } as RiskAssessment,
    },
  };
}

export function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const config = loadConfig({ mode: 'hybrid', workspace: '/tmp/bujb-unit' }, {
    BUJB_TELEMETRY: '0',
    BUJB_RECORD: '0',
  } as NodeJS.ProcessEnv);
  return { ...config, ...overrides };
}
