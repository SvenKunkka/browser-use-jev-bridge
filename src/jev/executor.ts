/**
 * Observation and input execution for the fast path.
 *
 * Ported from jev_ultrafast/browser.py (MIT, see LICENSES/), retargeted from
 * Browser Harness onto the Pi cell backend so that a single Pi-owned tab
 * carries both policies.
 *
 * Ordering rules that must not be relaxed:
 *   - a CLICK or SELECT re-checks the node guard *and* the form-control page
 *     key before anything is dispatched;
 *   - after that, the in-page `actTargetSource` re-checks connectivity,
 *     visibility, disabled state, read-only state, viewport bounds and
 *     occlusion, and resolves geometry at that instant;
 *   - a failure at either layer aborts. Nothing is retried, because a click
 *     that failed its guard may still have partially taken effect.
 */

import type { JevRawAction, JevSnapshot } from '../types.js';
import type { BrowserBackend } from '../pi/session.js';
import {
  MARKER_SOURCE,
  SNAPSHOT_SOURCE,
  actTargetSource,
  guardSource,
  settleSource,
} from './snapshot.js';
import { StalePageError, fingerprintSnapshot, guardMatches } from './freshness.js';

const OBSERVE_ATTEMPTS = 10;

/** The surface the router uses. Kept narrow so it can be faked in unit tests. */
export interface JevExecutorPort {
  observe(): Promise<JevSnapshot>;
  isFresh(snapshot: JevSnapshot): Promise<boolean>;
  isNodeFresh(snapshot: JevSnapshot, action: JevRawAction): Promise<boolean>;
  act(action: JevRawAction, snapshot: JevSnapshot, text?: string): Promise<void>;
}

export class UnsafeActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeActionError';
  }
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
      // Read-only, and already after the action was logged: a navigation that
      // interrupts this must never erase the record of what was executed.
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
   * Execute one observed action. Returns only after input has been dispatched.
   * Throws StalePageError instead of adapting when the page moved.
   */
  async act(action: JevRawAction, snapshot: JevSnapshot, text?: string): Promise<void> {
    await this.assertFreshFor(snapshot, action);

    if (action.kind === 'wait') {
      await delay(100);
      this.afterInput = undefined;
      return;
    }

    if (action.kind === 'scroll') {
      await this.backend.cdp('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(snapshot.w / 2),
        y: Math.round(snapshot.h / 2),
        deltaX: 0,
        deltaY: action.delta ?? 560,
      });
      this.afterInput = action;
      return;
    }

    if (typeof action.node !== 'number') throw new UnsafeActionError('Invalid observed node');
    if (action.kind === 'fill' && typeof text !== 'string') {
      throw new UnsafeActionError('TYPE_TEXT reached the executor without a generated value.');
    }

    // Code-owned node ids refer to actual observed elements, never to a
    // model-generated selector. Geometry and occlusion are resolved here.
    const target = await this.backend.evaluateInPage<{ x: number; y: number } | null>(
      actTargetSource(action),
    );
    if (target === null) {
      if (action.kind === 'select') {
        throw new UnsafeActionError('Dropdown execution was not confirmed; inspect before retrying.');
      }
      throw new StalePageError('Target changed or is covered. Observe again.');
    }

    if (action.kind === 'select') {
      // The in-page step already applied the value and fired input/change.
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
        { method: 'Input.insertText', params: { text } },
      );
    }
    await this.backend.cdpBatch(calls);
    this.afterInput = action;
  }
}
