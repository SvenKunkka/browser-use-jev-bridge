/**
 * The Jev fast policy: one TypeSafe request per step containing an operation
 * head and one target head per supported operation.
 *
 * Port of `choose()` / `validate_choice()` in jev_ultrafast/model.py (MIT).
 *
 * The transport is injected so the whole policy can be exercised offline, and
 * so a wrong or hostile response can be tested for rejection. Validation is
 * strict on purpose: an unparsable, incomplete or inconsistent answer raises
 * and *no action is executed*.
 */

import type {
  ActionRecord,
  ActionSpace,
  Decision,
  JevOperation,
  JevSnapshot,
  TypeSafeAnswer,
  TypeSafeResponse,
} from '../types.js';
import { RunAbortedError } from '../errors.js';
import { buildActionSpace } from './action-space.js';
import { NEXT_ACTION, TARGET } from './questions.js';

export interface TypeSafeRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}

export interface TypeSafeClient {
  readonly description: string;
  ask(body: TypeSafeRequest, signal?: AbortSignal): Promise<TypeSafeResponse>;
}

/**
 * A sleep that respects an AbortSignal. Retry backoff inside the run budget
 * must be interruptible, or `--timeout-ms` silently under-counts.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RunAbortedError('Aborted before the retry wait.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunAbortedError('Aborted during the retry wait.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class InvalidModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelResponseError';
  }
}

const OPERATION_LABELS: Partial<Record<JevOperation, string>> = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
};

/**
 * Upstream `validate_choice`, kept strict:
 *  - the chosen id must be one we offered;
 *  - probabilities must cover exactly the offered ids;
 *  - every number must be finite and within [0, 1];
 *  - probabilities must sum to 1 (±0.02);
 *  - the chosen id must be (one of) the arg-max.
 */
export function validateChoice(answer: unknown, ids: readonly string[]): TypeSafeAnswer {
  const invalid = (why: string): never => {
    throw new InvalidModelResponseError(`Invalid TypeSafe response (${why}); no action executed.`);
  };
  if (!answer || typeof answer !== 'object') return invalid('not an object');
  const candidate = answer as Partial<TypeSafeAnswer>;
  const probabilities = candidate.probabilities;
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
    return invalid('probabilities missing');
  }
  const keys = Object.keys(probabilities);
  const offered = new Set(ids);
  if (keys.length !== offered.size || !keys.every((key) => offered.has(key))) {
    return invalid('probabilities do not cover exactly the offered ids');
  }
  const numbers = [...Object.values(probabilities), candidate.confidence];
  for (const value of numbers) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return invalid('a probability or confidence is not a finite number in [0, 1]');
    }
  }
  const total = Object.values(probabilities).reduce((sum, value) => sum + (value as number), 0);
  if (Math.abs(total - 1) >= 0.02) return invalid('probabilities do not sum to 1');
  if (typeof candidate.choice !== 'string' || !offered.has(candidate.choice)) {
    return invalid('choice is not one of the offered ids');
  }
  const max = Math.max(...Object.values(probabilities as Record<string, number>));
  if ((probabilities as Record<string, number>)[candidate.choice]! < max - 1e-6) {
    return invalid('choice is not the most probable option');
  }
  return candidate as TypeSafeAnswer;
}

export function buildDecisionRequest(
  snapshot: JevSnapshot,
  goal: string,
  history: ActionRecord[],
  space: ActionSpace,
  model: string,
): { body: TypeSafeRequest; operations: Record<string, string> } {
  const operations: Record<string, string> = {};
  for (const operation of Object.keys(space.targets) as JevOperation[]) {
    operations[operation] = OPERATION_LABELS[operation] ?? operation;
  }
  for (const [operation, action] of Object.entries(space.controls)) {
    if (action) operations[operation] = action.label;
  }
  operations['DONE'] = 'Every requirement is visibly satisfied.';
  operations['BLOCKED'] = 'No supported operation can progress.';

  const questions: Record<string, unknown> = {
    operation: {
      type: 'choice',
      criteria: operations,
      instructions: { goal, rules: NEXT_ACTION },
    },
  };

  for (const [operation, candidates] of Object.entries(space.targets)) {
    if (!candidates) continue;
    const criteria: Record<string, unknown> = {};
    for (const [index, action] of Object.entries(candidates)) {
      const entry: Record<string, unknown> = {
        element: `[${index}] ${action.label}`,
        current_value: action.current_value ?? action.value ?? '',
      };
      for (const key of ['role', 'checked', 'selected', 'expanded'] as const) {
        if (action[key] !== undefined) entry[key] = action[key];
      }
      criteria[index] = entry;
    }
    questions[`${operation.toLowerCase()}_target`] = {
      type: 'choice',
      criteria,
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }

  const body: TypeSafeRequest = {
    model,
    state: {
      page: { url: snapshot.url, title: snapshot.title, text: snapshot.text },
      elements: space.elements,
      recent_actions: history.slice(-10).map((record) => ({
        action: record.label,
        kind: record.kind,
        text: record.textSummary ?? null,
        page_changed: record.pageChanged,
      })),
    },
    questions,
  };
  return { body, operations };
}

export interface ChooseDependencies {
  client: TypeSafeClient;
  model: string;
  signal?: AbortSignal;
  now?: () => number;
}

/** One model call, two validated heads, one executable decision. */
export async function choose(
  snapshot: JevSnapshot,
  goal: string,
  history: ActionRecord[],
  deps: ChooseDependencies,
): Promise<{ decision: Decision; space: ActionSpace }> {
  const now = deps.now ?? (() => Date.now());
  const space = buildActionSpace(snapshot.actions);
  const { body, operations } = buildDecisionRequest(snapshot, goal, history, space, deps.model);

  const started = now();
  const response = await deps.client.ask(body, deps.signal);
  if (!response || typeof response !== 'object' || !response.answers) {
    throw new InvalidModelResponseError('TypeSafe response had no answers; no action executed.');
  }

  const operationAnswer = validateChoice(response.answers['operation'], Object.keys(operations));
  const operation = operationAnswer.choice as JevOperation;

  let target: string | null = null;
  let choice: string;
  let probabilities: Record<string, number> = {};
  let targetAnswer: TypeSafeAnswer | undefined;

  const candidates = space.targets[operation];
  if (candidates) {
    // Unused target heads cannot cause an action; only validate the selected head.
    targetAnswer = validateChoice(response.answers[`${operation.toLowerCase()}_target`], Object.keys(candidates));
    target = targetAnswer.choice;
    const action = candidates[target];
    if (!action) throw new InvalidModelResponseError('Target is not an offered element; no action executed.');
    choice = action.id;
    probabilities = Object.fromEntries(
      Object.entries(candidates).map(([index, offered]) => [offered.id, targetAnswer!.probabilities[index] ?? 0]),
    );
  } else {
    const control = space.controls[operation];
    choice = control ? control.id : operation;
    probabilities = { [choice]: operationAnswer.probabilities[operation] ?? 0 };
  }

  const decision: Decision = {
    choice,
    operation,
    target,
    confidence: operationAnswer.confidence,
    probabilities,
    operationProbabilities: operationAnswer.probabilities,
    targetProbabilities: targetAnswer?.probabilities ?? {},
    latencyMs: Math.round(now() - started),
    fingerprint: snapshot.fingerprint,
  };
  if (response.model !== undefined) decision.model = response.model;
  if (response.usage !== undefined) decision.usage = response.usage;

  return { decision, space };
}

/** Production transport. Retries only on 429/503/529, and never after a send. */
export class HttpTypeSafeClient implements TypeSafeClient {
  readonly description: string;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 25_000,
  ) {
    this.description = `TypeSafe @ ${baseUrl}`;
  }

  async ask(body: TypeSafeRequest, signal?: AbortSignal): Promise<TypeSafeResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: composite,
        });
      } catch (error) {
        if (signal?.aborted || composite.aborted) {
          throw new RunAbortedError('The run was aborted during a TypeSafe request.');
        }
        if (error instanceof RunAbortedError) throw error;
        throw new Error('Model connection failed; no action executed.');
      }
      if ([429, 503, 529].includes(response.status) && attempt < 2) {
        // The wait is part of the run budget: a deadline during backoff must
        // abort, not sleep through.
        await abortableDelay(500 * 2 ** attempt, signal);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Model provider returned HTTP ${response.status}; no action executed.`);
      }
      return (await response.json()) as TypeSafeResponse;
    }
    throw new Error('Model unavailable; no action executed.');
  }
}
