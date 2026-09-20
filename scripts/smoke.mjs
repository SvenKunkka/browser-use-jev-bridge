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
 *   [mcp]      the real MCP stdio server: listTools, an approval round trip,
 *              a denial and an idempotent cancel, driven by the official SDK client
 *
 * Everything runs against a throwaway headless Chromium on file:// fixtures.
 * No network request leaves the machine and no paid endpoint is contacted.
 * Exit code 0 on success, 1 on failure, 2 when no browser is available.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

// --- [mcp] helpers ---------------------------------------------------------

const MCP_TEST_SERVER = resolve(process.cwd(), 'dist/testing/mcp-test-server.js');

/** A real MCP client attached to the real server over a real stdio transport. */
async function startMcp(plan, extraEnv = {}) {
  if (!existsSync(MCP_TEST_SERVER)) throw new Error(`build first: ${MCP_TEST_SERVER} is missing`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_TEST_SERVER],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BUJB_TEST_PLAN: JSON.stringify(plan),
      BUJB_CDP_URL: chrome.cdpUrl,
      BUJB_BROWSER: 'chrome',
      BUJB_WORKSPACE: workspace,
      BUJB_TELEMETRY: '0',
      BUJB_RECORD: '0',
      DO_NOT_TRACK: '1',
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bujb-smoke', version: '1' });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close().catch(() => {});
    },
  };
}

async function mcpCall(client, name, args = {}) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    // Schema violations are rejected by the SDK before the handler runs. That
    // is still a refusal, so report it the same way.
    return { isError: true, text: String(error), json: {} };
  }
  const text = result.content.map((entry) => entry.text).join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { isError: Boolean(result.isError), text, json };
}

async function mcpPoll(client, sessionId, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = (await mcpCall(client, 'browser_fast_status', { sessionId })).json;
    if (predicate(last)) return last;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for state; last = ${JSON.stringify(last).slice(0, 600)}`);
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

  // -- [mcp] ---------------------------------------------------------------
  // A real MCP stdio transport and the real SDK client against the real
  // server; only the two paid model endpoints are scripted.
  await step('mcp', 'initialize and listTools over a real stdio transport', async () => {
    const harness = await startMcp({});
    try {
      const listed = await harness.client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        'browser_fast_approve',
        'browser_fast_cancel',
        'browser_fast_doctor',
        'browser_fast_list_sessions',
        'browser_fast_start',
        'browser_fast_status',
        'browser_fast_verify',
      ]);
      const doctor = await mcpCall(harness.client, 'browser_fast_doctor', {});
      assert.equal(doctor.isError, false, doctor.text);
      assert.ok(typeof doctor.json.status === 'string');
    } finally {
      await harness.close();
    }
  });

  await step('mcp', 'start -> awaiting_approval -> approve -> completed', async () => {
    const harness = await startMcp({
      typeSafe: [
        { operation: 'CLICK', targetLabel: 'Place order' },
        { operation: 'DONE' },
        { verdict: 'SATISFIED' },
      ],
    });
    try {
      const started = await mcpCall(harness.client, 'browser_fast_start', {
        url: fixtureUrl('order.html'),
        goal: 'place the order',
        maxSteps: 6,
        timeoutMs: 60_000,
      });
      assert.equal(started.isError, false, started.text);
      const sessionId = started.json.sessionId;
      assert.ok(String(sessionId).startsWith('bfh_'));

      const waiting = await mcpPoll(harness.client, sessionId, (value) => value.state === 'awaiting_approval');
      const pending = waiting.pendingApproval;
      assert.equal(pending.risk, 'high');
      const approved = await mcpCall(harness.client, 'browser_fast_approve', {
        sessionId,
        approvalId: pending.approvalId,
        approved: true,
      });
      assert.equal(approved.isError, false, approved.text);

      const final = await mcpPoll(harness.client, sessionId, (value) =>
        ['completed', 'unverified', 'blocked', 'failed', 'timeout'].includes(value.state),
      );
      assert.equal(final.state, 'completed', JSON.stringify(final.notes));
      assert.equal(final.outcome.history.filter((entry) => entry.source === 'jev').length, 1);
    } finally {
      await harness.close();
    }
  });

  await step('mcp', 'declining stops the run and the declined action never executes', async () => {
    const harness = await startMcp({ typeSafe: [{ operation: 'CLICK', targetLabel: 'Place order' }] });
    try {
      const started = await mcpCall(harness.client, 'browser_fast_start', {
        url: fixtureUrl('order.html'),
        goal: 'place the order',
        maxSteps: 6,
        timeoutMs: 60_000,
      });
      const sessionId = started.json.sessionId;
      const waiting = await mcpPoll(harness.client, sessionId, (value) => value.state === 'awaiting_approval');
      const declined = await mcpCall(harness.client, 'browser_fast_approve', {
        sessionId,
        approvalId: waiting.pendingApproval.approvalId,
        approved: false,
        reason: 'smoke test declines high-risk actions',
      });
      assert.equal(declined.isError, false, declined.text);
      const replay = await mcpCall(harness.client, 'browser_fast_approve', {
        sessionId,
        approvalId: waiting.pendingApproval.approvalId,
        approved: true,
      });
      assert.equal(replay.isError, true, 'an approvalId is single-use');

      const final = await mcpPoll(harness.client, sessionId, (value) =>
        ['blocked', 'completed', 'unverified', 'failed'].includes(value.state),
      );
      assert.equal(final.state, 'blocked');
      assert.equal(final.outcomeStatus, 'stopped_by_approval');
      assert.equal(
        final.outcome.history.some((entry) => /Place order/.test(entry.label)),
        false,
        'the declined action has no execution record',
      );
    } finally {
      await harness.close();
    }
  });

  await step('mcp', 'cancel is idempotent and leaves nothing pending', async () => {
    const harness = await startMcp({ typeSafe: [{ operation: 'CLICK', targetLabel: 'Place order' }] });
    try {
      const started = await mcpCall(harness.client, 'browser_fast_start', {
        url: fixtureUrl('order.html'),
        goal: 'place the order',
        maxSteps: 4,
        timeoutMs: 60_000,
      });
      const sessionId = started.json.sessionId;
      await mcpPoll(harness.client, sessionId, (value) => value.state === 'awaiting_approval');
      assert.equal((await mcpCall(harness.client, 'browser_fast_cancel', { sessionId })).isError, false);
      assert.equal((await mcpCall(harness.client, 'browser_fast_cancel', { sessionId })).isError, false);
      const final = await mcpPoll(
        harness.client,
        sessionId,
        (value) => !['created', 'running', 'awaiting_approval'].includes(value.state),
      );
      assert.ok(['cancelled', 'blocked', 'failed'].includes(final.state), String(final.state));
      assert.equal(final.pendingApproval, null);
    } finally {
      await harness.close();
    }
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
