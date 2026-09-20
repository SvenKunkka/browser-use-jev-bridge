/**
 * `--timeout-ms` must mean the whole run.
 *
 * Every stage below is made to hang until the run's signal fires, and each
 * test asserts two things: the stage really received the abort, and the run
 * reports `timeout` rather than a generic error. The budgets here are tens of
 * milliseconds, so the suite does not spend real time proving it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridRouter } from '../src/router/hybrid-router.js';
import { BudgetTracker } from '../src/budget.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';
import { Redactor } from '../src/safety/redaction.js';
import { DomainPolicy } from '../src/safety/domains.js';
import { DenyHighRiskGate } from '../src/safety/approval-policy.js';
import { abortableDelay } from '../src/jev/policy.js';
import { RunAbortedError } from '../src/errors.js';
import type { TypeSafeClient } from '../src/jev/policy.js';
import type { TextModelClient, TextModelResult } from '../src/jev/text-helper.js';
import type { JevExecutorPort, ActOptions } from '../src/jev/executor.js';
import type { BrowserBackend, PageInfo } from '../src/pi/session.js';
import type { FallbackRunner } from '../src/router/hybrid-router.js';
import type { FallbackOutcome } from '../src/pi/fallback.js';
import type { HandoffContext, JevRawAction, JevSnapshot, TypeSafeResponse } from '../src/types.js';
import { makeAction, makeSnapshot, testConfig } from './helpers.js';

const TIMEOUT_MS = 60;

/**
 * Rejects only when the signal aborts; records that it saw it.
 *
 * `AbortSignal.timeout` does not hold the event loop open, so the hang keeps a
 * short guard timer alive. Without it Node would drain the loop and report the
 * pending promise instead of the abort.
 */
function hangUntilAborted(seen: { aborted: boolean }, signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('hang guard expired: no abort arrived')), 5_000);
    const settle = () => {
      clearTimeout(guard);
      seen.aborted = true;
      reject(new RunAbortedError('aborted'));
    };
    if (!signal) return;
    if (signal.aborted) return settle();
    signal.addEventListener('abort', settle, { once: true });
  });
}

class SignalBackend implements BrowserBackend {
  runSignal: AbortSignal | undefined;
  readonly seen = { aborted: false };
  hangOnEvaluate = false;
  setRunSignal(signal: AbortSignal | undefined): void {
    this.runSignal = signal;
  }
  async evaluateInPage<T>(): Promise<T> {
    if (this.hangOnEvaluate) await hangUntilAborted(this.seen, this.runSignal);
    return null as unknown as T;
  }
  async cdp(): Promise<unknown> {
    return null;
  }
  async cdpBatch(): Promise<void> {}
  async info(): Promise<PageInfo> {
    return { url: 'https://example.com/list', title: 'List' };
  }
  async goto(url: string): Promise<PageInfo> {
    return { url, title: 'List' };
  }
  async tabCount(): Promise<number> {
    return 1;
  }
}

class StageExecutor implements JevExecutorPort {
  readonly seen = { aborted: false };
  constructor(
    private readonly backend: SignalBackend,
    private readonly snapshot: JevSnapshot,
    private readonly hang: 'observe' | 'act' | 'none' = 'none',
  ) {}
  async observe(): Promise<JevSnapshot> {
    if (this.hang === 'observe') await hangUntilAborted(this.seen, this.backend.runSignal);
    return { ...this.snapshot, observedAt: Date.now() };
  }
  async isFresh(): Promise<boolean> {
    return true;
  }
  async isNodeFresh(): Promise<boolean> {
    return true;
  }
  async act(_action: JevRawAction, _snapshot: JevSnapshot, options: ActOptions = {}): Promise<void> {
    if (this.hang === 'act') {
      options.onPhase?.({ phase: 'dispatch_started', detail: 'hanging', effectPossible: true, at: Date.now() });
      await hangUntilAborted(this.seen, this.backend.runSignal);
    }
    options.onPhase?.({ phase: 'dispatched', detail: 'done', effectPossible: true, at: Date.now() });
  }
}

class StageTypeSafe implements TypeSafeClient {
  readonly description = 'stage typesafe';
  readonly seen = { aborted: false };
  private calls = 0;
  constructor(
    private readonly script: TypeSafeResponse[],
    private readonly hangOn: number | null = null,
  ) {}
  async ask(_body: unknown, signal?: AbortSignal): Promise<TypeSafeResponse> {
    const index = this.calls++;
    if (this.hangOn !== null && index === this.hangOn) await hangUntilAborted(this.seen, signal);
    const answer = this.script[index] ?? this.script[this.script.length - 1];
    if (!answer) throw new Error('no scripted answer');
    return answer;
  }
}

class StageTextModel implements TextModelClient {
  readonly description = 'stage text';
  readonly model = 'stage';
  readonly seen = { aborted: false };
  constructor(private readonly hang: boolean) {}
  async complete(_context: unknown, signal?: AbortSignal): Promise<TextModelResult> {
    if (this.hang) await hangUntilAborted(this.seen, signal);
    return { text: 'x', model: this.model, latencyMs: 1 };
  }
}

class StageFallback implements FallbackRunner {
  readonly available = true;
  readonly seen = { aborted: false };
  async run(_context: HandoffContext, _budget: unknown, signal?: AbortSignal): Promise<FallbackOutcome> {
    await hangUntilAborted(this.seen, signal).catch(() => {});
    return {
      status: 'aborted',
      text: 'aborted',
      steps: 1,
      durationMs: 1,
      costUsd: 0,
      blockedActions: [],
      aborted: 'deadline',
    };
  }
}

function decision(choice: string, ids: string[]): TypeSafeResponse {
  const others = ids.filter((id) => id !== choice);
  const remainder = others.length ? 0.2 / others.length : 0;
  return {
    answers: {
      operation: {
        choice,
        confidence: 0.9,
        probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? (others.length ? 0.8 : 1) : remainder])),
      },
      click_target: { choice: '1', confidence: 0.9, probabilities: { '1': 1 } },
      type_text_target: { choice: '1', confidence: 0.9, probabilities: { '1': 1 } },
    },
  };
}

const SNAPSHOT = makeSnapshot({
  actions: [
    makeAction({ id: 'e1', kind: 'click', label: 'Next page', node: 1, role: 'button' }),
    makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
  ],
});

const FILL_SNAPSHOT = makeSnapshot({
  actions: [
    makeAction({ id: 'e1', kind: 'fill', label: 'Query', node: 1, role: 'textbox', value: '' }),
    makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
  ],
});

interface Built {
  router: HybridRouter;
  backend: SignalBackend;
}

function build(options: {
  snapshot?: JevSnapshot;
  executorHang?: 'observe' | 'act' | 'none';
  typeSafe: TypeSafeClient;
  textModel: TextModelClient;
  fallback?: FallbackRunner;
  timeoutMs?: number;
}): Built {
  const backend = new SignalBackend();
  const snapshot = options.snapshot ?? SNAPSHOT;
  const executor = new StageExecutor(backend, snapshot, options.executorHang ?? 'none');
  const config = testConfig({ timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
  const router = new HybridRouter({
    backend,
    executor,
    typeSafe: options.typeSafe,
    textModel: options.textModel,
    ...(options.fallback ? { fallback: options.fallback } : {}),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'deadline'),
    config,
    budget: new BudgetTracker({
      maxSteps: config.maxSteps,
      timeoutMs: config.timeoutMs,
      maxCostUsd: config.maxCostUsd,
    }),
  });
  return { router, backend };
}

test('the deadline aborts a hanging browser observation and the run reports timeout', async () => {
  const backend = new SignalBackend();
  backend.hangOnEvaluate = true;
  const executor = new StageExecutor(backend, SNAPSHOT, 'observe');
  const config = testConfig({ timeoutMs: TIMEOUT_MS });
  const router = new HybridRouter({
    backend,
    executor,
    typeSafe: new StageTypeSafe([decision('DONE', ['CLICK', 'WAIT', 'DONE', 'BLOCKED'])]),
    textModel: new StageTextModel(false),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'deadline'),
    config,
    budget: new BudgetTracker({ maxSteps: 10, timeoutMs: TIMEOUT_MS, maxCostUsd: 1 }),
  });

  const started = Date.now();
  const outcome = await router.run('reach page two', 'https://example.com/list');
  assert.equal(outcome.status, 'timeout', JSON.stringify(outcome.error));
  assert.equal(executor.seen.aborted, true, 'the observation saw the abort');
  assert.ok(Date.now() - started < 3_000, 'the run ended promptly');
});

test('the deadline aborts a hanging TypeSafe request', async () => {
  const typeSafe = new StageTypeSafe([], 0);
  const { router } = build({ typeSafe, textModel: new StageTextModel(false) });
  const outcome = await router.run('reach page two', 'https://example.com/list');
  assert.equal((typeSafe as StageTypeSafe).seen.aborted, true, 'the decision call saw the abort');
  assert.equal(outcome.status, 'timeout');
});

test('the deadline aborts a hanging text-model request', async () => {
  const textModel = new StageTextModel(true);
  const { router } = build({
    snapshot: FILL_SNAPSHOT,
    // FILL_SNAPSHOT offers no clickable control, so CLICK is not an option.
    typeSafe: new StageTypeSafe([decision('TYPE_TEXT', ['TYPE_TEXT', 'WAIT', 'DONE', 'BLOCKED'])]),
    textModel,
  });
  const outcome = await router.run('type something', 'https://example.com/list');
  assert.equal(textModel.seen.aborted, true, 'the text helper saw the abort');
  assert.equal(outcome.status, 'timeout');
});

test('the deadline aborts a hanging Jev action, and the action is treated as uncertain', async () => {
  const backend = new SignalBackend();
  const executor = new StageExecutor(backend, SNAPSHOT, 'act');
  const config = testConfig({ timeoutMs: TIMEOUT_MS });
  const router = new HybridRouter({
    backend,
    executor,
    typeSafe: new StageTypeSafe([decision('CLICK', ['CLICK', 'WAIT', 'DONE', 'BLOCKED'])]),
    textModel: new StageTextModel(false),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'deadline'),
    config,
    budget: new BudgetTracker({ maxSteps: 10, timeoutMs: TIMEOUT_MS, maxCostUsd: 1 }),
  });

  const outcome = await router.run('reach page two', 'https://example.com/list');
  assert.equal(executor.seen.aborted, true, 'the action saw the abort');
  assert.equal(outcome.status, 'timeout');
  const uncertain = outcome.history.filter((entry) => entry.effectUncertain);
  assert.equal(uncertain.length, 1, 'an action interrupted by the deadline is recorded as uncertain');
});

test('the deadline aborts a hanging Pi fallback leg', async () => {
  const fallback = new StageFallback();
  // The leg is only offered a budget when more than a second remains, so this
  // one gets a slightly larger deadline than the other stages.
  const { router } = build({
    typeSafe: new StageTypeSafe([decision('BLOCKED', ['CLICK', 'WAIT', 'DONE', 'BLOCKED'])]),
    textModel: new StageTextModel(false),
    fallback,
    timeoutMs: 1_500,
  });
  const outcome = await router.run('open the embedded report', 'https://example.com/list');
  assert.equal(fallback.seen.aborted, true, 'the fallback leg saw the abort');
  assert.equal(outcome.status, 'timeout');
});

test('the deadline aborts a hanging verifier', async () => {
  // First call answers DONE, the second (the verifier) hangs.
  const typeSafe = new StageTypeSafe([decision('DONE', ['CLICK', 'WAIT', 'DONE', 'BLOCKED'])], 1);
  const { router } = build({ typeSafe, textModel: new StageTextModel(false) });
  const outcome = await router.run('reach page two', 'https://example.com/list');
  assert.equal(typeSafe.seen.aborted, true, 'the verification call saw the abort');
  assert.notEqual(outcome.status, 'completed');
  assert.equal(outcome.verification.verified, false);
});

test('caller cancellation is reported as cancelled, not timeout', async () => {
  const backend = new SignalBackend();
  backend.hangOnEvaluate = true;
  const executor = new StageExecutor(backend, SNAPSHOT, 'observe');
  const controller = new AbortController();
  const config = testConfig({ timeoutMs: 30_000 });
  const router = new HybridRouter({
    backend,
    executor,
    typeSafe: new StageTypeSafe([decision('DONE', ['CLICK', 'WAIT', 'DONE', 'BLOCKED'])]),
    textModel: new StageTextModel(false),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'deadline'),
    config,
    budget: new BudgetTracker({ maxSteps: 10, timeoutMs: 30_000, maxCostUsd: 1 }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  const outcome = await router.run('reach page two', 'https://example.com/list');
  assert.equal(outcome.status, 'cancelled', 'a caller abort is not a budget timeout');
});

test('retry backoff is interruptible', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => abortableDelay(5_000, controller.signal), RunAbortedError);
  assert.ok(Date.now() - started < 1_000, 'it did not sleep through the abort');
  // And it still resolves normally when nothing aborts.
  await abortableDelay(1);
});

test('an unhandled failure still produces a structured outcome with run_end', async () => {
  const audit = new MemoryAuditLog(new Redactor(), 'deadline');
  const backend = new SignalBackend();
  const exploding: JevExecutorPort = {
    async observe() {
      return { ...SNAPSHOT, observedAt: Date.now() };
    },
    async isFresh() {
      return true;
    },
    async isNodeFresh() {
      return true;
    },
    async act() {
      throw new TypeError('something completely unexpected');
    },
  };
  const router = new HybridRouter({
    backend,
    executor: exploding,
    typeSafe: new StageTypeSafe([decision('CLICK', ['CLICK', 'WAIT', 'DONE', 'BLOCKED'])]),
    textModel: new StageTextModel(false),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit,
    config: testConfig(),
  });

  const outcome = await router.run('reach page two', 'https://example.com/list');
  assert.equal(outcome.status, 'error');
  assert.match(String(outcome.error), /unexpected/);
  assert.ok(
    audit.entries.some((entry) => entry['type'] === 'run_end'),
    'run_end is written even for an unhandled failure',
  );
});
