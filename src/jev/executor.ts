/**
 * Observation and input execution for the fast path.
 *
 * Ported from jev_ultrafast/browser.py (MIT, see LICENSES/), retargeted from
 * Browser Harness onto the Pi cell backend so that a single Pi-owned tab
 * carries both policies.
 *
 * ## Execution phases
 *
 * The executor tells the caller, through a typed callback, exactly how far an
 * action got — because "the call threw" is not the same as "nothing
 * happened". Three cases used to be indistinguishable and are now explicit:
 *
 *  - `SELECT` applies the value *inside* `actTargetSource`, before any CDP
 *    input. If the change handler navigates, the evaluation can fail after the
 *    value was already set and `change` already fired.
 *  - A click or a fill is several CDP calls in one cell. The mouse press can
 *    land and `Input.insertText` can then fail.
 *  - A run-level deadline can fire between those calls.
 *
 * In all three the action is `effect_uncertain` and must be treated as
 * executed: recorded, never retried, and carried into `mustNotRepeat`.
 *
 * Ordering rules that must not be relaxed:
 *   - a CLICK or SELECT re-checks the node guard *and* the form-control page
 *     key before anything is dispatched;
 *   - `actTargetSource` then re-checks connectivity, visibility, disabled and
 *     read-only state, viewport bounds and occlusion, and resolves geometry at
 *     that instant;
 *   - a failure before any side effect is `preflight_failed` and is safe to
 *     re-plan. Anything after that is not.
 */

import type { ExecutionPhase, ExecutionPhaseEvent, JevRawAction, JevSnapshot } from '../types.js';
import type { BrowserBackend } from '../pi/session.js';
import {
  MARKER_SOURCE,
  SNAPSHOT_SOURCE,
  actTargetSource,
  guardSource,
  settleSource,
} from './snapshot.js';
import { StalePageError, fingerprintSnapshot, guardMatches } from './freshness.js';

export { RunAbortedError } from '../errors.js';

const OBSERVE_ATTEMPTS = 10;

export class UnsafeActionError extends Error {
  constructor(
    message: string,
    /** True when the action may already have taken effect. */
    readonly effectUncertain = false,
  ) {
    super(message);
    this.name = 'UnsafeActionError';
  }
}

export type PhaseListener = (event: ExecutionPhaseEvent) => void;

export interface ActOptions {
  text?: string;
  /** Called synchronously on every phase transition, before the next step. */
  onPhase?: PhaseListener;
}

/** The surface the router uses. Kept narrow so it can be faked in unit tests. */
export interface JevExecutorPort {
  observe(): Promise<JevSnapshot>;
  isFresh(snapshot: JevSnapshot): Promise<boolean>;
  isNodeFresh(snapshot: JevSnapshot, action: JevRawAction): Promise<boolean>;
  act(action: JevRawAction, snapshot: JevSnapshot, options?: ActOptions): Promise<void>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class JevExecutor implements JevExecutorPort {
  private macLike: boolean | undefined;
  /** Set after input so the next observation waits for the page to settle. */
  private afterInput: JevRawAction | undefined;

  constructor(private readonly backend: BrowserBackend) {}

  private async isMacLike(): Promise<boolean> {
    if (this.macLike === undefined) {
      this.macLike = await this.backend.evaluateInPage<boolean>(
        "/mac|iphone|ipad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '')",
      );
    }
    return this.macLike;
  }

  async observe(): Promise<JevSnapshot> {
    if (this.afterInput) {
      const action = this.afterInput;
      this.afterInput = undefined;
      // Read-only, and already after the action was recorded: a navigation
      // that interrupts this must never erase what was executed.
      try {
        await this.backend.evaluateInPage<boolean>(settleSource(action));
      } catch {
        /* settling is best effort */
      }
    }
    type RawSnapshot = Omit<JevSnapshot, 'fingerprint' | 'observedAt' | 'tabCount'>;
    for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt++) {
      let raw: RawSnapshot | null = null;
      try {
        raw = await this.backend.evaluateInPage<RawSnapshot | null>(SNAPSHOT_SOURCE);
      } catch (error) {
        if (!(error instanceof StalePageError) || attempt === OBSERVE_ATTEMPTS - 1) throw error;
      }
      if (raw) {
        const snapshot: JevSnapshot = {
          ...raw,
          fingerprint: fingerprintSnapshot(raw),
          observedAt: Date.now(),
        };
        try {
          snapshot.tabCount = await this.backend.tabCount();
        } catch {
          /* tab enumeration is advisory */
        }
        return snapshot;
      }
      await delay(20);
    }
    throw new StalePageError('Page did not settle');
  }

  /** Whole-page freshness (upstream MARKER check). */
  async isFresh(snapshot: JevSnapshot): Promise<boolean> {
    try {
      const marker = await this.backend.evaluateInPage<string | null>(MARKER_SOURCE);
      return marker === snapshot.marker;
    } catch (error) {
      if (error instanceof StalePageError) return false;
      throw error;
    }
  }

  /** Node-scoped freshness (upstream guard check) for CLICK / SELECT. */
  async isNodeFresh(snapshot: JevSnapshot, action: JevRawAction): Promise<boolean> {
    if (typeof action.node !== 'number') return false;
    try {
      const current = await this.backend.evaluateInPage<[string, string | null] | null>(
        guardSource(action.node),
      );
      return guardMatches(snapshot, action.node, current);
    } catch (error) {
      if (error instanceof StalePageError) return false;
      throw error;
    }
  }

  private async assertFreshFor(snapshot: JevSnapshot, action: JevRawAction): Promise<void> {
    const fresh =
      action.kind === 'click' || action.kind === 'select'
        ? await this.isNodeFresh(snapshot, action)
        : await this.isFresh(snapshot);
    if (!fresh) throw new StalePageError('Page changed since this decision. Observe again.');
  }

  /**
   * Execute one observed action, reporting every phase transition.
   * Throws instead of adapting when the page moved; the thrown error and the
   * phases already reported together tell the caller whether a side effect is
   * possible.
   */
  async act(action: JevRawAction, snapshot: JevSnapshot, options: ActOptions = {}): Promise<void> {
    const emit = (phase: ExecutionPhase, detail: string, effectPossible: boolean): void => {
      options.onPhase?.({ phase, detail, effectPossible, at: Date.now() });
    };
    const failPreflight = (detail: string): never => {
      emit('preflight_failed', detail, false);
      throw new StalePageError(detail);
    };

    try {
      await this.assertFreshFor(snapshot, action);
    } catch (error) {
      return failPreflight(error instanceof Error ? error.message : String(error));
    }

    if (action.kind === 'wait') {
      emit('dispatch_started', 'waiting; no input is sent', false);
      await delay(100);
      emit('dispatched', 'wait completed', false);
      this.afterInput = undefined;
      return;
    }

    if (action.kind === 'scroll') {
      emit('dispatch_started', 'dispatching a scroll wheel event', false);
      try {
        await this.backend.cdp('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(snapshot.w / 2),
          y: Math.round(snapshot.h / 2),
          deltaX: 0,
          deltaY: action.delta ?? 560,
        });
      } catch (error) {
        // Scrolling is idempotent, so a failure here is not "uncertain" in the
        // dangerous sense, but it did reach the browser.
        emit('effect_uncertain', `scroll dispatch failed: ${message(error)}`, false);
        this.afterInput = action;
        throw error;
      }
      emit('dispatched', 'scroll dispatched', false);
      this.afterInput = action;
      return;
    }

    if (typeof action.node !== 'number') {
      emit('preflight_failed', 'invalid observed node', false);
      throw new UnsafeActionError('Invalid observed node', false);
    }
    if (action.kind === 'fill' && typeof options.text !== 'string') {
      emit('preflight_failed', 'TYPE_TEXT reached the executor without a value', false);
      throw new UnsafeActionError('TYPE_TEXT reached the executor without a generated value.', false);
    }

    // SELECT applies the value inside this evaluation, so the side effect
    // starts here, not at the CDP call. CLICK and TYPE_TEXT only read.
    const selectMutates = action.kind === 'select';
    if (selectMutates) {
      emit('dispatch_started', 'applying the dropdown value in the page and firing input/change', true);
    }

    let target: { x: number; y: number } | null;
    try {
      target = await this.backend.evaluateInPage<{ x: number; y: number } | null>(
        actTargetSource(action),
      );
    } catch (error) {
      if (selectMutates) {
        emit(
          'effect_uncertain',
          `the dropdown evaluation failed after it may have applied the value: ${message(error)}`,
          true,
        );
        this.afterInput = action;
        throw new UnsafeActionError(
          'Dropdown execution was interrupted; the value may already have been applied. Inspect before retrying.',
          true,
        );
      }
      return failPreflight(`target resolution failed before any input: ${message(error)}`);
    }

    if (target === null) {
      if (selectMutates) {
        // Upstream treats this as "not confirmed"; we cannot prove the value
        // was not applied before the script bailed out.
        emit('effect_uncertain', 'the dropdown did not confirm; the value may have been applied', true);
        this.afterInput = action;
        throw new UnsafeActionError(
          'Dropdown execution was not confirmed; inspect before retrying.',
          true,
        );
      }
      return failPreflight('Target changed or is covered. Observe again.');
    }

    if (selectMutates) {
      emit('dispatched', 'dropdown value applied and input/change fired', true);
      this.afterInput = action;
      return;
    }

    const modifiers = (await this.isMacLike()) ? 4 : 2;
    const calls: { method: string; params: Record<string, unknown> }[] = [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 } },
    ];
    if (action.kind === 'fill') {
      calls.push(
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', modifiers, commands: ['selectAll'] } },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', modifiers } },
        { method: 'Input.insertText', params: { text: options.text } },
      );
    }

    emit(
      'dispatch_started',
      `dispatching ${calls.length} CDP input call(s) for ${action.kind}`,
      true,
    );
    try {
      await this.backend.cdpBatch(calls);
    } catch (error) {
      // One cell, several CDP calls: an earlier one may have landed.
      emit('effect_uncertain', `input dispatch failed part-way: ${message(error)}`, true);
      this.afterInput = action;
      throw new UnsafeActionError(
        `Input dispatch failed part-way and may have partially taken effect: ${message(error)}`,
        true,
      );
    }
    emit('dispatched', `${action.kind} input dispatched`, true);
    this.afterInput = action;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
