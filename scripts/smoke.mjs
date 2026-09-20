#!/usr/bin/env node
/**
 * Offline smoke test.
 *
 * Exercises the built artefact end to end against local fixtures, with four
 * clearly separated sections:
 *
 *   [jev]      the fast path filling a field and clicking through Pi's own page
 *   [verifier] the completion gate accepting a real result and rejecting a weak one
 *   [pi]       a genuine Browser Use Pi fallback leg, driven by a scripted
 *              streamFn, with its approval hook installed
 *   [approval] a high-risk Pi tool call refused by default, then allowed once approved
 *
 * Everything runs against a throwaway headless Chromium on file:// fixtures.
 * No network request leaves the machine and no paid endpoint is contacted.
 * Exit code 0 on success, 1 on failure, 2 when no browser is available.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JevExecutor } from '../dist/jev/executor.js';
import { HybridRouter } from '../dist/router/hybrid-router.js';
import { MemoryAuditLog } from '../dist/logging/audit-log.js';
import { Redactor } from '../dist/safety/redaction.js';
import { DomainPolicy } from '../dist/safety/domains.js';
import { DenyHighRiskGate, ScriptedApprovalGate } from '../dist/safety/approval-policy.js';
import { PiApprovalController, PiFallbackRunner } from '../dist/pi/fallback.js';
import { buildHandoff } from '../dist/router/handoff.js';
import {
  LabelDrivenTypeSafeClient,
  ScriptedTextModelClient,
  createOfflinePiSession,
  findChromeExecutable,
  fixtureUrl,
  launchTestChrome,
  scriptedPiStreamFn,
} from '../dist/testing/harness.js';

const started = Date.now();
const log = (line) => process.stdout.write(`${line}\n`);

if (!findChromeExecutable()) {
  log('SKIP  no Chrome/Chromium found; set BUJB_TEST_CHROME to run the smoke test');
  process.exit(2);
}

let chrome;
const workspace = mkdtempSync(join(tmpdir(), 'bujb-smoke-'));
let failures = 0;

async function step(section, name, run) {
  try {
    await run();
    log(`PASS  [${section}] ${name}`);
  } catch (error) {
    failures++;
    log(`FAIL  [${section}] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One Pi fallback leg on the order fixture, with the approval hook installed. */
async function piLeg({ gate, review, turns }) {
  const redactor = new Redactor();
  const audit = new MemoryAuditLog(redactor, 'smoke-pi');
  let controller;
  const offline = await createOfflinePiSession({
    cdpUrl: chrome.cdpUrl,
    workspace,
    beforeToolCall: async (context) => controller.hook(context),
    streamFn: scriptedPiStreamFn(turns),
  });
  controller = new PiApprovalController({
    gate,
    redactor,
    audit,
    review,
    currentUrl: () => fixtureUrl('order.html'),
  });
  try {
    await offline.session.goto(fixtureUrl('order.html'));
    const runner = new PiFallbackRunner({ session: offline.session, redactor, controller });
    const handoff = buildHandoff(
      'place the order on this page',
      { url: fixtureUrl('order.html'), fingerprint: 'smoke', text: '', title: '' },
      [],
      'jev_blocked',
      'stop when the order is placed',
    );
    const outcome = await runner.run(handoff, { maxSteps: 4, timeoutMs: 60_000, maxCostUsd: 1 });
    const result = await offline.session.evaluateInPage(
      "document.getElementById('result') ? document.getElementById('result').textContent : '(missing)'",
    );
    return { outcome, controller, result };
  } finally {
    await offline.close();
  }
}

try {
  chrome = await launchTestChrome();
  log(`INFO  chrome at ${chrome.cdpUrl}, workspace ${workspace}`);

  // -- [jev] ---------------------------------------------------------------
  await step('jev', 'fast path reaches a verified completion', async () => {
    const offline = await createOfflinePiSession({ cdpUrl: chrome.cdpUrl, workspace });
    try {
      const router = new HybridRouter({
        backend: offline.session,
        executor: new JevExecutor(offline.session),
        typeSafe: new LabelDrivenTypeSafeClient([
          { operation: 'TYPE_TEXT', targetLabel: 'Search query' },
          { operation: 'CLICK', targetLabel: 'Search' },
          { operation: 'DONE' },
          { verdict: 'SATISFIED' },
        ]),
        textModel: new ScriptedTextModelClient(['blue widgets']),
        gate: new DenyHighRiskGate(),
        redactor: new Redactor(),
        domainPolicy: new DomainPolicy(),
        audit: new MemoryAuditLog(new Redactor(), 'smoke'),
        config: offline.config,
      });
      const outcome = await router.run('search for blue widgets', fixtureUrl('form.html'));
      assert.equal(outcome.status, 'completed', `status was ${outcome.status}: ${outcome.notes.join('; ')}`);
      assert.equal(outcome.verification.verified, true);
      assert.equal(outcome.jevSteps, 2);
      assert.equal(outcome.budget.used.steps, 2, 'the budget counted both Jev steps');
      const result = await offline.session.evaluateInPage("document.getElementById('result').textContent");
      assert.match(result, /Results for: blue widgets sorted by relevance/);
    } finally {
      await offline.close();
    }
  });

  await step('jev', 'the occlusion guard stops a covered click in a real page', async () => {
    const offline = await createOfflinePiSession({ cdpUrl: chrome.cdpUrl, workspace });
    try {
      await offline.session.goto(fixtureUrl('form.html'));
      const jev = new JevExecutor(offline.session);
      const snapshot = await jev.observe();
      const covered = snapshot.actions.find((a) => a.label === 'Covered action' && a.kind === 'click');
      assert.ok(covered, 'covered button missing from the observation');
      await assert.rejects(() => jev.act(covered, snapshot), /covered|changed/i);
      const result = await offline.session.evaluateInPage("document.getElementById('result').textContent");
      assert.equal(result, '');
    } finally {
      await offline.close();
    }
  });

  // -- [verifier] ----------------------------------------------------------
  await step('verifier', 'a weak SATISFIED is not reported as completed', async () => {
    const offline = await createOfflinePiSession({ cdpUrl: chrome.cdpUrl, workspace });
    try {
      const router = new HybridRouter({
        backend: offline.session,
        executor: new JevExecutor(offline.session),
        typeSafe: new LabelDrivenTypeSafeClient([{ operation: 'DONE' }, { verdict: 'SATISFIED', confidence: 0.3 }]),
        textModel: new ScriptedTextModelClient([]),
        gate: new DenyHighRiskGate(),
        redactor: new Redactor(),
        domainPolicy: new DomainPolicy(),
        audit: new MemoryAuditLog(new Redactor(), 'smoke-weak'),
        config: offline.config,
      });
      const outcome = await router.run('search for blue widgets', fixtureUrl('form.html'));
      assert.equal(outcome.status, 'unverified', `status was ${outcome.status}`);
      assert.equal(outcome.verification.verdict, 'SATISFIED');
      assert.equal(outcome.verification.verified, false);
    } finally {
      await offline.close();
    }
  });

  // -- [pi] ----------------------------------------------------------------
  await step('pi', 'a real Pi fallback leg runs with its approval hook installed', async () => {
    const gate = new ScriptedApprovalGate([true, true, true]);
    const { outcome, controller, result } = await piLeg({
      gate,
      review: true,
      turns: [
        { toolCall: { name: 'javascript', arguments: { code: 'console.log(await page.info())' } } },
        { toolCall: { name: 'finish', arguments: { result: 'looked at the page' } } },
      ],
    });
    assert.ok(gate.seen.length >= 2, `review mode must see every tool call, saw ${gate.seen.length}`);
    assert.equal(controller.denial, undefined);
    assert.equal(result, '', 'a read-only cell changed nothing');
    assert.equal(outcome.status, 'completed');
  });

  // -- [approval] ----------------------------------------------------------
  await step('approval', 'a high-risk Pi tool call is refused and the page is untouched', async () => {
    const { outcome, controller, result } = await piLeg({
      gate: new DenyHighRiskGate(),
      review: false,
      turns: [
        {
          toolCall: {
            name: 'javascript',
            arguments: { code: "await page.evaluate(\"document.getElementById('placeOrder').click(), true\")" },
          },
        },
        { toolCall: { name: 'finish', arguments: { result: 'ordered' } } },
      ],
    });
    assert.ok(controller.denial, 'the denial must be recorded');
    assert.equal(result, '', 'the order button must not have been clicked');
    assert.ok(outcome.blockedActions.includes('javascript'));
  });

  await step('approval', 'the same call proceeds once a human approves it', async () => {
    const gate = new ScriptedApprovalGate([true]);
    const { controller, result } = await piLeg({
      gate,
      review: false,
      turns: [
        {
          toolCall: {
            name: 'javascript',
            arguments: { code: "await page.evaluate(\"document.getElementById('placeOrder').click(), true\")" },
          },
        },
        { toolCall: { name: 'finish', arguments: { result: 'ordered' } } },
      ],
    });
    assert.equal(gate.seen.length, 1);
    assert.equal(controller.denial, undefined);
    assert.equal(result, 'ORDER PLACED', 'the approved action really reached the page');
  });
} catch (error) {
  failures++;
  log(`FAIL  harness: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await chrome?.close();
  rmSync(workspace, { recursive: true, force: true });
}

log(`\nsmoke: ${failures === 0 ? 'ok' : `${failures} failure(s)`} in ${Date.now() - started} ms`);
process.exit(failures === 0 ? 0 : 1);
