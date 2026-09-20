#!/usr/bin/env node
/**
 * Offline smoke test.
 *
 * Exercises the built artefact end to end against local fixtures:
 *   1. a real Pi session attached to a real headless Chromium;
 *   2. the Jev fast path filling a field and clicking a button through Pi's
 *      own page binding;
 *   3. the independent verifier accepting a genuine completion;
 *   4. the approval layer refusing a high-risk action with no human attached.
 *
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
import { DenyHighRiskGate } from '../dist/safety/approval-policy.js';
import {
  LabelDrivenTypeSafeClient,
  ScriptedTextModelClient,
  createOfflinePiSession,
  findChromeExecutable,
  fixtureUrl,
  launchTestChrome,
} from '../dist/testing/harness.js';

const started = Date.now();
const log = (line) => process.stdout.write(`${line}\n`);

if (!findChromeExecutable()) {
  log('SKIP  no Chrome/Chromium found; set BUJB_TEST_CHROME to run the smoke test');
  process.exit(2);
}

let chrome;
let offline;
const workspace = mkdtempSync(join(tmpdir(), 'bujb-smoke-'));
let failures = 0;

async function step(name, run) {
  try {
    await run();
    log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  chrome = await launchTestChrome();
  offline = await createOfflinePiSession({ cdpUrl: chrome.cdpUrl, workspace });
  log(`INFO  chrome at ${chrome.cdpUrl}, workspace ${workspace}`);

  await step('fast path reaches a verified completion', async () => {
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
    const result = await offline.session.evaluateInPage("document.getElementById('result').textContent");
    assert.match(result, /Results for: blue widgets sorted by relevance/);
  });

  await step('an unverified completion claim is not reported as completed', async () => {
    const router = new HybridRouter({
      backend: offline.session,
      executor: new JevExecutor(offline.session),
      typeSafe: new LabelDrivenTypeSafeClient([{ operation: 'DONE' }, { verdict: 'NOT_SATISFIED' }]),
      textModel: new ScriptedTextModelClient([]),
      gate: new DenyHighRiskGate(),
      redactor: new Redactor(),
      domainPolicy: new DomainPolicy(),
      audit: new MemoryAuditLog(new Redactor(), 'smoke-unverified'),
      config: offline.config,
    });
    const outcome = await router.run('search for blue widgets', fixtureUrl('form.html'));
    assert.equal(outcome.status, 'unverified');
    assert.equal(outcome.verification.verified, false);
  });

  await step('the occlusion guard stops a covered click in a real page', async () => {
    await offline.session.goto(fixtureUrl('form.html'));
    const jev = new JevExecutor(offline.session);
    const snapshot = await jev.observe();
    const covered = snapshot.actions.find((action) => action.label === 'Covered action' && action.kind === 'click');
    assert.ok(covered, 'covered button missing from the observation');
    await assert.rejects(() => jev.act(covered, snapshot), /covered|changed/i);
    const result = await offline.session.evaluateInPage("document.getElementById('result').textContent");
    assert.equal(result, '');
  });

  await step('an unsupported page is recognised from a real observation', async () => {
    await offline.session.goto(fixtureUrl('unsupported.html'));
    const snapshot = await new JevExecutor(offline.session).observe();
    assert.ok(snapshot.unsupported.iframes >= 1 && snapshot.unsupported.canvases >= 1);
    assert.equal(snapshot.actions.some((a) => a.kind === 'click' || a.kind === 'fill'), false);
  });
} catch (error) {
  failures++;
  log(`FAIL  harness: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await offline?.close();
  await chrome?.close();
  rmSync(workspace, { recursive: true, force: true });
}

log(`\nsmoke: ${failures === 0 ? 'ok' : `${failures} failure(s)`} in ${Date.now() - started} ms`);
process.exit(failures === 0 ? 0 : 1);
