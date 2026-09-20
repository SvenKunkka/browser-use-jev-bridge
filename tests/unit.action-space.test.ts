import assert from 'node:assert/strict';
import test from 'node:test';
import { buildActionSpace, operationChoices } from '../src/jev/action-space.js';
import { makeAction } from './helpers.js';

test('requirement 1 — dynamic action space is built from observed controls only', () => {
  const space = buildActionSpace([
    makeAction({ id: 'e1', kind: 'fill', label: 'Search query', node: 7, role: 'textbox', value: '' }),
    makeAction({ id: 'e2', kind: 'click', label: 'Open Search query', node: 7, role: 'textbox', value: '' }),
    makeAction({ id: 'e3', kind: 'click', label: 'Search', node: 8, role: 'button' }),
    makeAction({ id: 'e4', kind: 'select', label: 'Sort → Newest', node: 9, role: 'combobox', value: 'newest', current_value: 'Relevance' }),
    makeAction({ id: 'e5', kind: 'select', label: 'Sort → Oldest', node: 9, role: 'combobox', value: 'oldest', current_value: 'Relevance' }),
    makeAction({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 }),
    makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
  ]);

  // One index per element, not per action.
  assert.equal(space.elements.length, 3);
  assert.deepEqual(space.elements.map((element) => element.index), ['1', '2', '3']);

  // The textbox supports both TYPE_TEXT and CLICK; the button only CLICK.
  assert.deepEqual(space.elements[0]!.operations.sort(), ['CLICK', 'TYPE_TEXT']);
  assert.deepEqual(space.elements[1]!.operations, ['CLICK']);

  // Dropdown options become distinct SELECT targets under one element index.
  assert.deepEqual(Object.keys(space.targets.SELECT ?? {}), ['3:1', '3:2']);
  assert.equal(space.elements[2]!.options?.length, 2);
  assert.equal(space.elements[2]!.value, 'Relevance');

  // Scroll and wait are operations, not targets.
  assert.ok(space.controls.SCROLL_DOWN);
  assert.ok(space.controls.WAIT);
  assert.equal(space.targets.SCROLL_DOWN, undefined);

  assert.deepEqual(operationChoices(space).sort(), ['CLICK', 'DONE', 'BLOCKED', 'SELECT', 'SCROLL_DOWN', 'TYPE_TEXT', 'WAIT'].sort());
});

test('an element with no supported operation never enters the space', () => {
  const space = buildActionSpace([makeAction({ id: 'e1', kind: 'click', label: 'no node' })]);
  assert.equal(space.elements.length, 0);
  assert.equal(space.targets.CLICK, undefined);
});
