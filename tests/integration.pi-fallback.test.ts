/**
 * Real Browser Use Pi fallback tests.
 *
 * These drive the *actual* Pi agent loop — its tool registry, its
 * `beforeToolCall` plumbing, its persistent V8 cell and its CDP path —
 * against a real headless Chromium on a local file:// fixture. Only the
 * provider request is replaced, by a scripted `streamFn`, so nothing reaches
 * the network and nothing is billed.
 *
 * What they prove:
 *   - the approval hook is actually installed, and receives Pi 0.1.0's real
 *     context shape (`toolCall.name`, `args`);
 *   - a high-risk Pi tool call is refused by default and the page is unchanged;
 *   - the same call goes through once a human approves it;
 *   - --review-style gating sees every tool call, not just risky ones;
 *   - the leg runs in the same Pi session and on the same target;
 *   - the fallback is terminal.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PiApprovalController,
  PiFallbackRunner,
  type PiBeforeToolCallContext,
} from '../src/pi/fallback.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';
import { Redactor } from '../src/safety/redaction.js';
import { DenyHighRiskGate, ScriptedApprovalGate, type ApprovalGate } from '../src/safety/approval-policy.js';
import { buildHandoff } from '../src/router/handoff.js';
import {
  createOfflinePiSession,
  findChromeExecutable,
  fixtureUrl,
  launchTestChrome,
  scriptedPiStreamFn,
  type ScriptedPiTurn,
  type TestChrome,
} from '../src/testing/harness.js';
import { makeSnapshot } from './helpers.js';

const chromeFound = Boolean(findChromeExecutable());
const skip = chromeFound ? false : 'no Chrome/Chromium found (set BUJB_TEST_CHROME)';

const ORDER_CLICK = "await page.evaluate(\"document.getElementById('placeOrder').click(), true\")";
const READ_RESULT = "await page.evaluate(\"document.getElementById('result').textContent\")";

let chrome: TestChrome | undefined;
let workspace: string | undefined;

before(async () => {
  if (!chromeFound) return;
  workspace = mkdtempSync(join(tmpdir(), 'bujb-pi-'));
  chrome = await launchTestChrome();
});

after(async () => {
  await chrome?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

interface Leg {
  seen: PiBeforeToolCallContext[];
  controller: PiApprovalController;
  outcome: Awaited<ReturnType<PiFallbackRunner['run']>>;
  resultText: string;
  targetBefore: string;
  targetAfter: string;
}

/** Run one complete Pi fallback leg against the order fixture. */
async function runLeg(options: { gate: ApprovalGate; review: boolean; turns: ScriptedPiTurn[] }): Promise<Leg> {
  const seen: PiBeforeToolCallContext[] = [];
  const redactor = new Redactor();
  const audit = new MemoryAuditLog(redactor, 'pi-leg');
  let controller!: PiApprovalController;

  const hook = async (context: PiBeforeToolCallContext) => {
    seen.push(context);
    return controller.hook(context);
  };

  const offline = await createOfflinePiSession({
    cdpUrl: chrome!.cdpUrl,
    workspace: workspace!,
    beforeToolCall: hook,
    streamFn: scriptedPiStreamFn(options.turns),
  });

  controller = new PiApprovalController({
    gate: options.gate,
    redactor,
    audit,
    review: options.review,
    currentUrl: () => fixtureUrl('order.html'),
  });

  try {
    await offline.session.goto(fixtureUrl('order.html'));
    const targetInfo = (await offline.session.cdp('Target.getTargetInfo')) as {
      targetInfo?: { targetId?: string };
    };
    const targetBefore = targetInfo.targetInfo?.targetId ?? '';

    const runner = new PiFallbackRunner({ session: offline.session, redactor, controller });
    const handoff = buildHandoff(
      'place the order on this page',
      makeSnapshot({ url: fixtureUrl('order.html') }),
      [],
      'jev_blocked',
      'stop when the order is placed',
    );
    const outcome = await runner.run(handoff, { maxSteps: 4, timeoutMs: 60_000, maxCostUsd: 1 });

    const resultText = await offline.session.evaluateInPage<string>(
      "document.getElementById('result') ? document.getElementById('result').textContent : '(no page)'",
    );
    const after = (await offline.session.cdp('Target.getTargetInfo')) as {
      targetInfo?: { targetId?: string };
    };
    return { seen, controller, outcome, resultText, targetBefore, targetAfter: after.targetInfo?.targetId ?? '' };
  } finally {
    await offline.close();
  }
}

test('pi — the hook is installed and receives Pi 0.1.0’s real context shape', { skip }, async () => {
  const leg = await runLeg({
    gate: new DenyHighRiskGate(),
    review: false,
    turns: [
      { toolCall: { name: 'javascript', arguments: { code: `console.log(${READ_RESULT})` } } },
      { toolCall: { name: 'finish', arguments: { result: 'read the page' } } },
    ],
  });

  assert.ok(leg.seen.length >= 1, 'beforeToolCall was actually called by Pi');
  const first = leg.seen[0]!;
  assert.equal(first.toolCall.name, 'javascript', 'the tool name lives on toolCall.name');
  assert.equal(typeof (first.args as { code?: unknown }).code, 'string', 'validated arguments live on args');
  assert.equal(
    (first as unknown as Record<string, unknown>)['toolName'],
    undefined,
    'there is no toolName field — the old hook read a property that never existed',
  );
  assert.equal(
    (first as unknown as Record<string, unknown>)['arguments'],
    undefined,
    'there is no arguments field on the context',
  );
  assert.ok(first.assistantMessage, 'the context carries the assistant message');
  assert.equal(leg.targetBefore, leg.targetAfter, 'the leg stayed on one Pi-owned target');
  assert.ok(leg.targetBefore.length > 0);
});

test('pi — a high-risk tool call is refused by default and the page is untouched', { skip }, async () => {
  const leg = await runLeg({
    gate: new DenyHighRiskGate(),
    review: false,
    turns: [
      { toolCall: { name: 'javascript', arguments: { code: ORDER_CLICK } } },
      { toolCall: { name: 'finish', arguments: { result: 'ordered' } } },
    ],
  });

  assert.ok(leg.controller.denial, 'the denial was recorded');
  assert.equal(leg.controller.denial!.toolName, 'javascript');
  assert.equal(leg.resultText, '', 'the order button was never clicked');
  assert.ok(
    leg.outcome.blockedActions.includes('javascript'),
    'the blocked call is reported back to the router',
  );
});

test('pi — the same high-risk call executes once a human approves it', { skip }, async () => {
  const gate = new ScriptedApprovalGate([true]);
  const leg = await runLeg({
    gate,
    review: false,
    turns: [
      { toolCall: { name: 'javascript', arguments: { code: ORDER_CLICK } } },
      { toolCall: { name: 'finish', arguments: { result: 'ordered' } } },
    ],
  });

  assert.equal(gate.seen.length, 1, 'exactly one approval was requested');
  assert.equal(leg.controller.denial, undefined);
  assert.equal(leg.resultText, 'ORDER PLACED', 'the approved action really reached the page');
  assert.equal(leg.outcome.status, 'completed');
});

test('pi — review mode sees every tool call, including the delivery call', { skip }, async () => {
  const gate = new ScriptedApprovalGate([true, true, true]);
  const leg = await runLeg({
    gate,
    review: true,
    turns: [
      { toolCall: { name: 'javascript', arguments: { code: `console.log(${READ_RESULT})` } } },
      { toolCall: { name: 'finish', arguments: { result: 'read the page' } } },
    ],
  });

  assert.ok(gate.seen.length >= 2, `expected every tool call to be reviewed, saw ${gate.seen.length}`);
  assert.ok(gate.seen.some((request) => request.operation === 'PI_FALLBACK:javascript'));
  assert.ok(gate.seen.some((request) => request.operation === 'PI_FALLBACK:finish'));
  assert.equal(leg.resultText, '', 'the read-only cell changed nothing');
});

test('pi — a declined call in review mode stops the leg and changes nothing', { skip }, async () => {
  const gate = new ScriptedApprovalGate([false]);
  const leg = await runLeg({
    gate,
    review: true,
    turns: [
      { toolCall: { name: 'javascript', arguments: { code: ORDER_CLICK } } },
      { toolCall: { name: 'javascript', arguments: { code: ORDER_CLICK } } },
      { toolCall: { name: 'finish', arguments: { result: 'ordered' } } },
    ],
  });

  assert.equal(leg.resultText, '', 'nothing reached the page');
  assert.ok(leg.controller.denial);
  assert.equal(gate.seen.length, 1, 'the leg stopped at the first refusal instead of trying again');
});
