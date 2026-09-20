import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetTracker } from '../src/budget.js';
import { HybridRouter } from '../src/router/hybrid-router.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';
import { Redactor } from '../src/safety/redaction.js';
import { DomainPolicy } from '../src/safety/domains.js';
import { DenyHighRiskGate } from '../src/safety/approval-policy.js';
import { MissingTextModelClient } from '../src/jev/text-helper.js';
import { ScriptedTypeSafeClient } from '../src/testing/harness.js';
import { FakeBackend, FakeExecutor, FakeFallback, makeSnapshot, testConfig } from './helpers.js';

const BLOCKED = { operation: { choice: 'BLOCKED' } };
const SATISFIED = { verdict: { choice: 'SATISFIED' } };
const CLICK_E1 = { operation: { choice: 'CLICK' }, click_target: { choice: '1' } };

test('regression — two Pi legs cannot each consume the full budget', () => {
  let clock = 1_000;
  const tracker = new BudgetTracker({ maxSteps: 10, timeoutMs: 60_000, maxCostUsd: 1 }, () => clock);

  tracker.recordJevStep();
  tracker.recordJevStep();
  assert.deepEqual(tracker.remaining().steps, 8);

  // First fallback leg: it is offered 8 steps and reports spending 5.
  const firstOffer = tracker.remaining();
  assert.equal(firstOffer.steps, 8);
  tracker.recordPiRun(5, 0.4);

  // Second leg is offered only what is left — not the original 10 / $1.
  const secondOffer = tracker.remaining();
  assert.equal(secondOffer.steps, 3, 'the second leg must not see a reset step budget');
  assert.ok(Math.abs(secondOffer.costUsd - 0.6) < 1e-9, 'the second leg must not see a reset cost budget');

  tracker.recordPiRun(3, 0.7);
  assert.equal(tracker.remaining().steps, 0);
  assert.equal(tracker.exhausted(), 'cost_limit', 'cost is exceeded before the step count reaches zero');

  const report = tracker.report();
  assert.equal(report.used.jevSteps, 2);
  assert.equal(report.used.piSteps, 8);
  assert.equal(report.used.steps, 10);
  assert.ok(Math.abs(report.used.costUsd - 1.1) < 1e-9);
});

test('the wall clock is a real deadline, not a loop-top check', () => {
  let clock = 0;
  const tracker = new BudgetTracker({ maxSteps: 50, timeoutMs: 5_000, maxCostUsd: 10 }, () => clock);
  assert.equal(tracker.exhausted(), null);
  clock = 4_999;
  assert.equal(tracker.exhausted(), null);
  clock = 5_000;
  assert.equal(tracker.exhausted(), 'timeout');
  assert.equal(tracker.canStartFallback(), false);
});

test('a step budget already spent by Jev is not handed to the fallback', async () => {
  const snapshot = makeSnapshot();
  const fallback = new FakeFallback();
  const executor = new FakeExecutor([snapshot]);
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    typeSafe: new ScriptedTypeSafeClient([CLICK_E1, CLICK_E1, CLICK_E1, SATISFIED]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'budget-test'),
    config: testConfig({ maxSteps: 9 }),
  });

  const outcome = await router.run('reach page two', 'https://example.com/list');

  assert.equal(fallback.budgets.length, 1);
  assert.equal(
    fallback.budgets[0]!.maxSteps,
    6,
    'three Jev steps were spent, so the fallback is offered the remaining six',
  );
  assert.ok(fallback.budgets[0]!.timeoutMs <= testConfig().timeoutMs);
  assert.equal(outcome.budget?.limits.maxSteps, 9);
  assert.equal(outcome.budget?.used.jevSteps, 3);
  assert.equal(outcome.budget?.used.piSteps, 1);
});

test('a run that starts with no budget left stops instead of calling Pi', async () => {
  const snapshot = makeSnapshot();
  const fallback = new FakeFallback();
  const spent = new BudgetTracker({ maxSteps: 1, timeoutMs: 300_000, maxCostUsd: 1 });
  spent.recordJevStep();
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor: new FakeExecutor([snapshot]),
    typeSafe: new ScriptedTypeSafeClient([BLOCKED, SATISFIED]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'budget-test'),
    config: testConfig(),
    budget: spent,
  });

  const outcome = await router.run('open the embedded report', 'https://example.com/list');
  assert.equal(fallback.calls.length, 0, 'no fallback is started without budget');
  assert.equal(outcome.status, 'step_limit');
});
