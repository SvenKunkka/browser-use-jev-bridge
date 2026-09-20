import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidModelResponseError, choose, validateChoice } from '../src/jev/policy.js';
import { RawTypeSafeClient, ScriptedTypeSafeClient } from '../src/testing/harness.js';
import { makeAction, makeSnapshot } from './helpers.js';

const OFFERED = ['CLICK', 'WAIT', 'DONE', 'BLOCKED'];

test('requirement 2 — a well-formed TypeSafe answer is accepted', () => {
  const answer = validateChoice(
    { choice: 'CLICK', confidence: 0.82, probabilities: { CLICK: 0.7, WAIT: 0.1, DONE: 0.1, BLOCKED: 0.1 } },
    OFFERED,
  );
  assert.equal(answer.choice, 'CLICK');
});

test('requirement 3 — malformed or illegal answers are rejected and nothing executes', () => {
  const rejected: string[] = [];
  const cases: [string, unknown][] = [
    ['unknown choice', { choice: 'LOGIN', confidence: 1, probabilities: { CLICK: 1, WAIT: 0, DONE: 0, BLOCKED: 0 } }],
    ['probability keys do not match offered ids', { choice: 'CLICK', confidence: 1, probabilities: { CLICK: 1 } }],
    ['probabilities do not sum to 1', { choice: 'CLICK', confidence: 1, probabilities: { CLICK: 0.5, WAIT: 0.1, DONE: 0.1, BLOCKED: 0.1 } }],
    ['choice is not the arg-max', { choice: 'CLICK', confidence: 1, probabilities: { CLICK: 0.1, WAIT: 0.7, DONE: 0.1, BLOCKED: 0.1 } }],
    ['confidence out of range', { choice: 'CLICK', confidence: 4, probabilities: { CLICK: 0.7, WAIT: 0.1, DONE: 0.1, BLOCKED: 0.1 } }],
    ['non-finite probability', { choice: 'CLICK', confidence: 1, probabilities: { CLICK: Number.NaN, WAIT: 0.1, DONE: 0.1, BLOCKED: 0.1 } }],
    ['null answer', null],
  ];
  for (const [name, answer] of cases) {
    assert.throws(() => validateChoice(answer, OFFERED), InvalidModelResponseError, name);
    rejected.push(name);
  }
  assert.equal(rejected.length, cases.length);
});

test('requirement 3 — a target head naming an element that was not offered is refused', async () => {
  const snapshot = makeSnapshot({
    actions: [
      makeAction({ id: 'e1', kind: 'click', label: 'Next page', node: 1, role: 'button' }),
      makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    ],
  });
  const client = new RawTypeSafeClient({
    answers: {
      operation: { choice: 'CLICK', confidence: 0.9, probabilities: { CLICK: 0.7, WAIT: 0.1, DONE: 0.1, BLOCKED: 0.1 } },
      click_target: { choice: '99', confidence: 0.9, probabilities: { '99': 1 } },
    },
  });
  await assert.rejects(
    () => choose(snapshot, 'go to page two', [], { client, model: 'test' }),
    InvalidModelResponseError,
  );
});

test('the operation head decides which target head is validated', async () => {
  const snapshot = makeSnapshot({
    actions: [
      makeAction({ id: 'e1', kind: 'click', label: 'Next page', node: 1, role: 'button' }),
      makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    ],
  });
  // An unused, deliberately invalid target head must not block a WAIT decision.
  const client = new RawTypeSafeClient({
    answers: {
      operation: { choice: 'WAIT', confidence: 0.9, probabilities: { CLICK: 0.1, WAIT: 0.7, DONE: 0.1, BLOCKED: 0.1 } },
      click_target: { choice: 'nonsense', confidence: 3, probabilities: {} },
    },
  });
  const { decision } = await choose(snapshot, 'wait for results', [], { client, model: 'test' });
  assert.equal(decision.operation, 'WAIT');
  assert.equal(decision.choice, 'wait');
  assert.equal(decision.target, null);
});

test('the request carries one question per supported operation and never a raw DOM dump', async () => {
  const snapshot = makeSnapshot({
    actions: [
      makeAction({ id: 'e1', kind: 'fill', label: 'Query', node: 1, role: 'textbox', value: '' }),
      makeAction({ id: 'e2', kind: 'click', label: 'Search', node: 2, role: 'button' }),
      makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    ],
  });
  const client = new ScriptedTypeSafeClient([{ operation: { choice: 'CLICK' }, click_target: { choice: '2' } }]);
  const { decision } = await choose(snapshot, 'search for pears', [], { client, model: 'test' });
  assert.equal(decision.choice, 'e2');
  const body = client.requests[0]!;
  assert.deepEqual(Object.keys(body.questions).sort(), ['click_target', 'operation', 'type_text_target']);
  assert.equal(JSON.stringify(body).includes('<html'), false);
});
