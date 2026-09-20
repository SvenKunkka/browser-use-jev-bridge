/**
 * Execution phases: the difference between "definitely not executed" and
 * "we cannot prove it did not happen".
 *
 * These use a fake browser backend so each failure point can be hit exactly:
 * a guard failure before anything is dispatched, a SELECT whose in-page
 * mutation is interrupted, and a click whose CDP batch fails part-way.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { JevExecutor, UnsafeActionError } from '../src/jev/executor.js';
import { StalePageError } from '../src/jev/freshness.js';
import { HybridRouter } from '../src/router/hybrid-router.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';
import { Redactor } from '../src/safety/redaction.js';
import { DomainPolicy } from '../src/safety/domains.js';
import { DenyHighRiskGate } from '../src/safety/approval-policy.js';
import { MissingTextModelClient } from '../src/jev/text-helper.js';
import { ScriptedTypeSafeClient } from '../src/testing/harness.js';
import type { BrowserBackend, PageInfo } from '../src/pi/session.js';
import type { ExecutionPhaseEvent, JevRawAction } from '../src/types.js';
import { FakeBackend, FakeExecutor, FakeFallback, makeAction, makeSnapshot, testConfig } from './helpers.js';

/** A backend whose calls can be made to fail at a chosen point. */
class ScriptedBackend implements BrowserBackend {
  evaluateFails: ((expression: string) => Error | undefined) | undefined;
  cdpBatchFails: (() => Error) | undefined;
  readonly cdpBatches: unknown[][] = [];
  guardFresh = true;

  setRunSignal(): void {}

  async evaluateInPage<T>(expression: string): Promise<T> {
    const failure = this.evaluateFails?.(expression);
    if (failure) throw failure;
    // Node-guard probe: [pageKey, guardDigest]. `c.guardDigest(` only appears
    // in guardSource; the snapshot script spells it `cache.guardDigest(`.
    if (expression.includes('c.guardDigest(')) {
      return (this.guardFresh ? ['pagekey-1', 'guard-1'] : ['pagekey-1', 'changed']) as unknown as T;
    }
    if (expression.includes('state?.marker')) return 'marker-1' as unknown as T;
    if (expression.includes('navigator')) return false as unknown as T;
    // actTargetSource returns coordinates
    return { x: 10, y: 20 } as unknown as T;
  }
  async cdp(): Promise<unknown> {
    return null;
  }
  async cdpBatch(calls: { method: string; params?: Record<string, unknown> }[]): Promise<void> {
    this.cdpBatches.push(calls);
    const failure = this.cdpBatchFails?.();
    if (failure) throw failure;
  }
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

const CLICK = makeAction({ id: 'e1', kind: 'click', label: 'Next page', node: 1, role: 'button' });
const SELECT = makeAction({
  id: 'e2',
  kind: 'select',
  label: 'Sort → Newest',
  node: 1,
  role: 'combobox',
  value: 'newest',
});

function record(events: ExecutionPhaseEvent[]) {
  return (event: ExecutionPhaseEvent) => events.push(event);
}

test('a guard failure is a preflight failure — nothing was dispatched', async () => {
  const backend = new ScriptedBackend();
  backend.guardFresh = false;
  const executor = new JevExecutor(backend);
  const events: ExecutionPhaseEvent[] = [];

  await assert.rejects(
    () => executor.act(CLICK, makeSnapshot(), { onPhase: record(events) }),
    StalePageError,
  );
  assert.deepEqual(events.map((event) => event.phase), ['preflight_failed']);
  assert.equal(events.every((event) => event.effectPossible === false), true);
  assert.equal(backend.cdpBatches.length, 0, 'no CDP input was sent');
});

test('a SELECT interrupted mid-mutation is effect_uncertain, not "not executed"', async () => {
  const backend = new ScriptedBackend();
  backend.evaluateFails = (expression) =>
    expression.includes('dispatchEvent')
      ? new StalePageError('Document changed during evaluation')
      : undefined;
  const executor = new JevExecutor(backend);
  const events: ExecutionPhaseEvent[] = [];

  await assert.rejects(
    () => executor.act(SELECT, makeSnapshot(), { onPhase: record(events) }),
    (error: unknown) => error instanceof UnsafeActionError && error.effectUncertain,
  );
  assert.deepEqual(events.map((event) => event.phase), ['dispatch_started', 'effect_uncertain']);
  assert.equal(events[0]!.effectPossible, true, 'the side effect starts before the evaluation returns');
});

test('a SELECT that cannot confirm is effect_uncertain', async () => {
  const backend = new ScriptedBackend();
  // actTargetSource returning null: the script may have applied the value first.
  backend.evaluateFails = undefined;
  const nullBackend = new ScriptedBackend();
  nullBackend.evaluateInPage = (async (expression: string) => {
    if (expression.includes('c.guardDigest(')) return ['pagekey-1', 'guard-1'];
    if (expression.includes('dispatchEvent')) return null;
    return { x: 1, y: 1 };
  }) as ScriptedBackend['evaluateInPage'];
  const executor = new JevExecutor(nullBackend);
  const events: ExecutionPhaseEvent[] = [];

  await assert.rejects(
    () => executor.act(SELECT, makeSnapshot(), { onPhase: record(events) }),
    (error: unknown) => error instanceof UnsafeActionError && error.effectUncertain,
  );
  assert.deepEqual(events.map((event) => event.phase), ['dispatch_started', 'effect_uncertain']);
});

test('a click whose CDP batch fails part-way is effect_uncertain', async () => {
  const backend = new ScriptedBackend();
  backend.cdpBatchFails = () => new Error('Input.insertText failed: target closed');
  const executor = new JevExecutor(backend);
  const events: ExecutionPhaseEvent[] = [];

  await assert.rejects(
    () => executor.act(CLICK, makeSnapshot(), { onPhase: record(events) }),
    (error: unknown) => error instanceof UnsafeActionError && error.effectUncertain,
  );
  assert.deepEqual(events.map((event) => event.phase), ['dispatch_started', 'effect_uncertain']);
  assert.equal(backend.cdpBatches.length, 1, 'the batch really was attempted');
});

test('a successful click reports dispatch_started then dispatched', async () => {
  const backend = new ScriptedBackend();
  const executor = new JevExecutor(backend);
  const events: ExecutionPhaseEvent[] = [];
  await executor.act(CLICK, makeSnapshot(), { onPhase: record(events) });
  assert.deepEqual(events.map((event) => event.phase), ['dispatch_started', 'dispatched']);
});

test('wait and scroll report phases but never claim a possible side effect', async () => {
  const backend = new ScriptedBackend();
  const executor = new JevExecutor(backend);
  for (const action of [
    makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    makeAction({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 }),
  ] as JevRawAction[]) {
    const events: ExecutionPhaseEvent[] = [];
    await executor.act(action, makeSnapshot(), { onPhase: record(events) });
    assert.deepEqual(events.map((event) => event.phase), ['dispatch_started', 'dispatched']);
    assert.equal(events.every((event) => event.effectPossible === false), true, action.kind);
  }
});

// ---------------------------------------------------------------------------
// Router behaviour around an uncertain action
// ---------------------------------------------------------------------------

test('regression — an uncertain action lands in history and audit, and is never re-planned', async () => {
  const snapshot = makeSnapshot({
    actions: [CLICK, makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' })],
  });
  const executor = new FakeExecutor([snapshot]);
  executor.failBeforeDispatch = false; // fail AFTER dispatch started
  executor.actError = () => new UnsafeActionError('input dispatch failed part-way', true);
  const fallback = new FakeFallback();
  const audit = new MemoryAuditLog(new Redactor(), 'phase-test');

  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    typeSafe: new ScriptedTypeSafeClient([
      { operation: { choice: 'CLICK' }, click_target: { choice: '1' } },
      { verdict: { choice: 'SATISFIED' } },
    ]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit,
    config: testConfig(),
  });

  const outcome = await router.run('reach page two', 'https://example.com/list');

  const uncertain = outcome.history.filter((entry) => entry.source === 'jev' && entry.effectUncertain);
  assert.equal(uncertain.length, 1, 'the possibly-executed action is in history');
  assert.equal(uncertain[0]!.label, 'Next page');
  assert.ok(
    ['effect_uncertain', 'observed'].includes(uncertain[0]!.executionPhase),
    `unexpected phase ${uncertain[0]!.executionPhase}`,
  );
  assert.ok(
    uncertain[0]!.phases.some((phase) => phase.phase === 'effect_uncertain'),
    'the phase trail records the uncertainty',
  );

  const phaseRecords = audit.entries.filter((entry) => entry['type'] === 'execution_phase');
  assert.ok(phaseRecords.length >= 2, 'phase transitions are audited');
  assert.ok(
    audit.entries.some((entry) => entry['type'] === 'error' && entry['effectUncertain'] === true),
    'the failure is audited as uncertain',
  );

  // It must hand over rather than plan another fast-path step.
  assert.deepEqual(outcome.fallbackReasons, ['uncertain_effect']);
  assert.equal(executor.executed.length, 0);
  assert.ok(fallback.calls.length === 1, 'the run handed over instead of re-planning');
  assert.ok(
    fallback.calls[0]!.mustNotRepeat.some((entry) => entry.includes('Next page')),
    'the uncertain action is in mustNotRepeat',
  );
});

test('a preflight failure is still safe to re-plan', async () => {
  const snapshot = makeSnapshot();
  const executor = new FakeExecutor([snapshot]);
  executor.failBeforeDispatch = true;
  executor.actError = () => new StalePageError('Page changed since this decision. Observe again.');
  const fallback = new FakeFallback();

  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    typeSafe: new ScriptedTypeSafeClient([
      { operation: { choice: 'CLICK' }, click_target: { choice: '1' } },
      { operation: { choice: 'CLICK' }, click_target: { choice: '1' } },
      { verdict: { choice: 'SATISFIED' } },
    ]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'phase-test'),
    config: testConfig(),
  });

  const outcome = await router.run('reach page two', 'https://example.com/list');
  assert.equal(
    outcome.history.filter((entry) => entry.source === 'jev').length,
    0,
    'nothing reached the browser, so no fast-path action is in history',
  );
  assert.deepEqual(outcome.fallbackReasons, ['stale_repeated'], 'it re-planned, then handed over on the second stale');
});
