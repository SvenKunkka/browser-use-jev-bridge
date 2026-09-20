import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandoff, buildMustNotRepeat, renderHandoffPrompt } from '../src/router/handoff.js';
import type { ActionRecord } from '../src/types.js';
import { makeSnapshot } from './helpers.js';

function record(overrides: Partial<ActionRecord> & { step: number; label: string }): ActionRecord {
  return {
    source: 'jev',
    operation: 'CLICK',
    kind: 'click',
    actionId: `e${overrides.step}`,
    url: 'https://shop.test/cart',
    risk: 'low',
    pageChanged: true,
    fingerprintBefore: 'f0',
    startedAt: 0,
    finishedAt: 1,
    effectUncertain: true,
    ...overrides,
  } as ActionRecord;
}

test('requirement 8 — the handoff lists every action that may already have taken effect', () => {
  const history: ActionRecord[] = [
    record({ step: 1, label: 'Search', textSummary: undefined }),
    record({ step: 2, label: 'Submit order', pageChanged: false, risk: 'high' }),
    record({ step: 3, label: 'Wait', kind: 'wait', operation: 'WAIT', effectUncertain: false }),
    record({ step: 4, label: 'Scroll down', kind: 'scroll', operation: 'SCROLL_DOWN', effectUncertain: false }),
    record({ step: 5, label: 'Query', kind: 'fill', operation: 'TYPE_TEXT', textSummary: 'blue widgets' }),
  ];

  const mustNotRepeat = buildMustNotRepeat(history);
  assert.equal(mustNotRepeat.length, 3, 'wait and scroll are idempotent and excluded');
  assert.ok(mustNotRepeat.some((entry) => entry.includes('Submit order')));
  assert.ok(mustNotRepeat.some((entry) => entry.includes('no observable page change, but it was dispatched')));
  assert.ok(mustNotRepeat.some((entry) => entry.includes('entered: blue widgets')));

  const context = buildHandoff('buy one widget', makeSnapshot(), history, 'jev_blocked', 'stop when confirmed');
  assert.equal(context.goal, 'buy one widget');
  assert.equal(context.currentUrl, 'https://example.com/list');
  assert.equal(context.completedActions.length, 5);
  assert.deepEqual(context.mustNotRepeat, mustNotRepeat);
  assert.match(context.fallbackReason, /BLOCKED/);
  assert.equal(context.stopCondition, 'stop when confirmed');

  const prompt = renderHandoffPrompt(context);
  assert.match(prompt, /MUST NOT REPEAT/);
  assert.match(prompt, /Submit order/);
  assert.match(prompt, /never re-send, re-submit or re-click/i);
});

test('duplicate executions are listed once', () => {
  const history = [record({ step: 1, label: 'Submit order' }), record({ step: 2, label: 'Submit order' })];
  assert.equal(buildMustNotRepeat(history).length, 1);
});
