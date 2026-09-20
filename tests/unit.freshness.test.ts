import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StaleDecisionError,
  assertDecisionFresh,
  fingerprintSnapshot,
  guardMatches,
  stableStringify,
} from '../src/jev/freshness.js';
import type { Decision } from '../src/types.js';
import { makeAction, makeSnapshot } from './helpers.js';

test('requirement 4 — a page change produces a different fingerprint', () => {
  const first = makeSnapshot();
  const second = makeSnapshot({ text: 'Page two of results' });
  assert.notEqual(first.fingerprint, second.fingerprint);

  const reordered = fingerprintSnapshot({
    url: first.url,
    text: first.text,
    actions: first.actions,
    scroll: first.scroll,
  });
  assert.equal(reordered, first.fingerprint, 'fingerprinting must be deterministic');
});

test('requirement 4 — changing the action list alone invalidates the fingerprint', () => {
  const before = makeSnapshot();
  const after = makeSnapshot({
    actions: [
      makeAction({ id: 'e1', kind: 'click', label: 'Previous page', node: 1, role: 'button' }),
      makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    ],
  });
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test('requirement 5 — a decision made on an older page cannot be executed', () => {
  const before = makeSnapshot();
  const after = makeSnapshot({ text: 'Page two of results' });
  const decision = { choice: 'e1', fingerprint: before.fingerprint } as Decision;

  assert.equal(assertDecisionFresh(decision, before).choice, 'e1');
  assert.throws(() => assertDecisionFresh(decision, after), StaleDecisionError);
  assert.throws(() => assertDecisionFresh(null, after), StaleDecisionError);
});

test('node guards reject a changed control and a changed form-control page key', () => {
  const snapshot = makeSnapshot();
  assert.equal(guardMatches(snapshot, 1, [snapshot.pageKey, 'guard-1']), true);
  assert.equal(guardMatches(snapshot, 1, [snapshot.pageKey, 'guard-1-changed']), false);
  assert.equal(guardMatches(snapshot, 1, ['pagekey-changed', 'guard-1']), false);
  assert.equal(guardMatches(snapshot, 1, null), false, 'a vanished node is never fresh');
  assert.equal(guardMatches(snapshot, 42, [snapshot.pageKey, 'guard-42']), false, 'unknown node is never fresh');
});

test('stable stringify sorts keys so digests do not depend on property order', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
});
