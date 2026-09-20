/**
 * Dynamic action space.
 *
 * Port of `action_space()` in jev_ultrafast/model.py (MIT, see LICENSES/).
 *
 * One index per observed *element*; each operation gets its own target set, so
 * an operation head can only ever be paired with targets that actually support
 * it. Scroll/wait become their own operations rather than targets, and DONE /
 * BLOCKED are added by the policy. The model can therefore never name an
 * element that was not observed, nor an operation that element cannot perform.
 */

import type { ActionSpace, ActionSpaceElement, JevOperation, JevRawAction } from '../types.js';

const KIND_TO_OPERATION: Record<string, JevOperation> = {
  click: 'CLICK',
  fill: 'TYPE_TEXT',
  select: 'SELECT',
};

const CONTROL_IDS: Record<string, JevOperation> = {
  scroll_down: 'SCROLL_DOWN',
  scroll_up: 'SCROLL_UP',
  wait: 'WAIT',
};

export function buildActionSpace(actions: JevRawAction[]): ActionSpace {
  const elements: ActionSpaceElement[] = [];
  const indices = new Map<number, string>();
  const targets: ActionSpace['targets'] = {};
  const controls: ActionSpace['controls'] = {};

  for (const action of actions) {
    const operation = KIND_TO_OPERATION[action.kind];
    if (!operation) {
      const control = CONTROL_IDS[action.id];
      if (control) controls[control] = action;
      continue;
    }
    const node = action.node;
    if (typeof node !== 'number') continue;

    if (!indices.has(node)) {
      const index = String(elements.length + 1);
      indices.set(node, index);
      const element: ActionSpaceElement = {
        index,
        label: (action.label ?? '').split(' → ')[0] ?? '',
        operations: [],
      };
      if (action.role !== undefined) element.role = action.role;
      if (action.value !== undefined) element.value = action.value;
      if (action.checked !== undefined) element.checked = action.checked;
      if (action.selected !== undefined) element.selected = action.selected;
      if (action.expanded !== undefined) element.expanded = action.expanded;
      if (action.kind === 'select') {
        element.value = action.current_value ?? '';
        element.options = [];
      }
      elements.push(element);
    }

    const index = indices.get(node) as string;
    const element = elements[Number(index) - 1] as ActionSpaceElement;
    if (!element.operations.includes(operation)) element.operations.push(operation);

    const group = (targets[operation] ??= {});
    let target = index;
    if (action.kind === 'select') {
      element.options ??= [];
      target = `${index}:${element.options.length + 1}`;
      element.options.push({ index: target, label: action.label, value: action.value ?? '' });
    }
    group[target] = action;
  }

  return { elements, targets, controls };
}

/** Every identifier the model is allowed to return for the operation head. */
export function operationChoices(space: ActionSpace): JevOperation[] {
  const fromTargets = Object.keys(space.targets) as JevOperation[];
  const fromControls = Object.keys(space.controls) as JevOperation[];
  return [...fromTargets, ...fromControls, 'DONE', 'BLOCKED'];
}
