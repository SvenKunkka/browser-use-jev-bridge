/**
 * Freshness: everything that stops a decision from being applied to a page it
 * was not made on.
 *
 * Three independent layers, all of them from upstream Jev:
 *   1. fingerprint      — host-side sha256 over (url, text, actions, scroll).
 *                         Binds a Decision to one observation.
 *   2. marker           — in-page digest of identity + meaning. Cheap re-check
 *                         before DONE/BLOCKED and before text generation.
 *   3. node guard       — per-element tuple (role, name, value, disabled,
 *                         aria-*, scope text) plus the form-control page key.
 *                         Checked immediately before CLICK / SELECT.
 *
 * Layer 3 is checked again, in-page, at the instant of input by
 * `actTargetSource` (visibility, disabled, occlusion, viewport). A decision
 * therefore has to survive four checks between being produced and taking
 * effect, and any failure aborts without retrying.
 */

import { createHash } from 'node:crypto';
import type { Decision, JevSnapshot } from '../types.js';

export class StalePageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StalePageError';
  }
}

export class StaleDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleDecisionError';
  }
}

/** Deterministic JSON with sorted object keys, so digests are stable. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Upstream `fingerprint()`: sha256 over url, text, actions and scroll. */
export function fingerprintSnapshot(
  snapshot: Pick<JevSnapshot, 'url' | 'text' | 'actions' | 'scroll'>,
): string {
  const content = {
    url: snapshot.url,
    text: snapshot.text,
    actions: snapshot.actions,
    scroll: snapshot.scroll,
  };
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

/**
 * A Decision may only be applied to the snapshot it was produced from.
 * Callers consume a decision exactly once; see HybridRouter.
 */
export function assertDecisionFresh(decision: Decision | null, snapshot: JevSnapshot): Decision {
  if (!decision) throw new StaleDecisionError('No decision is pending. Observe and choose before acting.');
  if (decision.fingerprint !== snapshot.fingerprint) {
    throw new StaleDecisionError(
      'Decision was made on a different page state and cannot be executed. Observe and choose again.',
    );
  }
  return decision;
}

/** Layer 3 comparison. Both halves must match the values captured at observation. */
export function guardMatches(
  snapshot: JevSnapshot,
  node: number,
  current: [string, string | null] | null,
): boolean {
  if (current === null) return false;
  const [pageKey, guard] = current;
  if (pageKey !== snapshot.pageKey) return false;
  const expected = snapshot.guards[String(node)];
  if (expected === undefined || expected === null) return false;
  return guard === expected;
}
