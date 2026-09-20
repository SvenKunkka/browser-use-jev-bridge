/**
 * Fixture integration tests.
 *
 * These run a REAL Browser Use Pi session against a REAL headless Chromium on
 * local file:// fixtures. No network request leaves the machine, no model
 * provider is contacted (Pi's transport is replaced by one that throws), and
 * the two paid Jev endpoints are replaced by deterministic scripts.
 *
 * They are skipped, not failed, when no Chrome/Chromium is installed.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JevExecutor } from '../src/jev/executor.js';
import { StalePageError } from '../src/jev/freshness.js';
import { HybridRouter, detectUnsupported } from '../src/router/hybrid-router.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';
import { Redactor } from '../src/safety/redaction.js';
import { DomainPolicy } from '../src/safety/domains.js';
import { DenyHighRiskGate } from '../src/safety/approval-policy.js';
import {
  LabelDrivenTypeSafeClient,
  ScriptedTextModelClient,
  createOfflinePiSession,
  findChromeExecutable,
  fixtureUrl,
  launchTestChrome,
  type OfflineSession,
  type TestChrome,
} from '../src/testing/harness.js';
import type { JevRawAction, JevSnapshot } from '../src/types.js';

const chromeFound = Boolean(findChromeExecutable());
const skip = chromeFound ? false : 'no Chrome/Chromium found (set BUJB_TEST_CHROME)';

let chrome: TestChrome | undefined;
let offline: OfflineSession | undefined;
let workspace: string | undefined;

before(async () => {
  if (!chromeFound) return;
  workspace = mkdtempSync(join(tmpdir(), 'bujb-work-'));
  chrome = await launchTestChrome();
  offline = await createOfflinePiSession({ cdpUrl: chrome.cdpUrl, workspace });
});

after(async () => {
  await offline?.close();
  await chrome?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function executor(): JevExecutor {
  return new JevExecutor(offline!.session);
}

function byLabel(snapshot: JevSnapshot, label: string, kind?: string): JevRawAction {
  const action = snapshot.actions.find((a) => a.label === label && (!kind || a.kind === kind));
  assert.ok(action, `no ${kind ?? 'action'} labelled "${label}" in ${JSON.stringify(snapshot.actions.map((a) => [a.kind, a.label]))}`);
  return action;
}

async function openForm(): Promise<{ jev: JevExecutor; snapshot: JevSnapshot }> {
  await offline!.session.goto(fixtureUrl('form.html'));
  const jev = executor();
  return { jev, snapshot: await jev.observe() };
}

test('fixture — the snapshot exposes usable controls and hides disabled ones', { skip }, async () => {
  const { snapshot } = await openForm();
  assert.equal(snapshot.title, 'Fixture Form');
  assert.match(snapshot.url, /form\.html$/);

  byLabel(snapshot, 'Search', 'click');
  byLabel(snapshot, 'Search query', 'fill');
  byLabel(snapshot, 'Sort order → Newest', 'select');

  assert.equal(
    snapshot.actions.some((action) => action.label === 'Disabled action'),
    false,
    'a disabled control must never enter the action space',
  );
  assert.ok(snapshot.guards[String(byLabel(snapshot, 'Search', 'click').node)], 'guards are captured per node');
  assert.equal(snapshot.unsupported.iframes, 0);
});

test('fixture — clicking a button changes the page and the fingerprint', { skip }, async () => {
  const { jev, snapshot } = await openForm();
  await jev.act(byLabel(snapshot, 'Search', 'click'), snapshot);
  const after = await jev.observe();

  assert.notEqual(after.fingerprint, snapshot.fingerprint, 'a real page change must change the fingerprint');
  assert.match(after.text, /Results for: \(empty\) sorted by relevance/);
});

test('fixture — typing replaces the field value', { skip }, async () => {
  const { jev, snapshot } = await openForm();
  await jev.act(byLabel(snapshot, 'Search query', 'fill'), snapshot, { text: 'blue widgets' });
  const value = await offline!.session.evaluateInPage<string>("document.getElementById('query').value");
  assert.equal(value, 'blue widgets');
});

test('fixture — selecting a dropdown option applies it in the page', { skip }, async () => {
  const { jev, snapshot } = await openForm();
  await jev.act(byLabel(snapshot, 'Sort order → Oldest', 'select'), snapshot);
  const value = await offline!.session.evaluateInPage<string>("document.getElementById('sort').value");
  assert.equal(value, 'oldest');
});

test('fixture — an occluded control is refused at the last instant', { skip }, async () => {
  const { jev, snapshot } = await openForm();
  const covered = byLabel(snapshot, 'Covered action', 'click');
  await assert.rejects(() => jev.act(covered, snapshot), StalePageError);
  const result = await offline!.session.evaluateInPage<string>("document.getElementById('result').textContent");
  assert.equal(result, '', 'the covered button must not have been clicked');
});

test('fixture — a node whose guard changed cannot be clicked', { skip }, async () => {
  const { jev, snapshot } = await openForm();
  const search = byLabel(snapshot, 'Search', 'click');
  await offline!.session.evaluateInPage("(document.getElementById('search').textContent = 'Search now', true)");
  await assert.rejects(() => jev.act(search, snapshot), StalePageError);
  const result = await offline!.session.evaluateInPage<string>("document.getElementById('result').textContent");
  assert.equal(result, '', 'the stale click must not have reached the page');
});

test('fixture — a whole-page change invalidates a pending fill', { skip }, async () => {
  const { jev, snapshot } = await openForm();
  const fill = byLabel(snapshot, 'Search query', 'fill');
  await offline!.session.evaluateInPage("(document.getElementById('intro').textContent = 'mutated', true)");
  assert.equal(await jev.isFresh(snapshot), false);
  await assert.rejects(() => jev.act(fill, snapshot, { text: 'pears' }), StalePageError);
  const value = await offline!.session.evaluateInPage<string>("document.getElementById('query').value");
  assert.equal(value, '', 'nothing was typed after the page moved');
});

test('fixture — an unsupported page is detected from a real observation', { skip }, async () => {
  await offline!.session.goto(fixtureUrl('unsupported.html'));
  const snapshot = await executor().observe();
  assert.ok(snapshot.unsupported.iframes >= 1);
  assert.ok(snapshot.unsupported.canvases >= 1);
  assert.ok(snapshot.unsupported.fileInputs >= 1);
  assert.ok(snapshot.unsupported.shadowRoots >= 1);
  assert.equal(
    snapshot.actions.some((action) => action.kind === 'click' || action.kind === 'fill'),
    false,
    'nothing on this page is modelled by the fast policy',
  );
  const verdict = detectUnsupported(snapshot, 'press the button inside the frame');
  assert.equal(verdict.unsupported, true);
  assert.ok(verdict.reasons.length > 0);
});

test('fixture — a full scripted fast-path run reaches a verified completion', { skip }, async () => {
  const audit = new MemoryAuditLog(new Redactor(), 'integration');
  const typeSafe = new LabelDrivenTypeSafeClient([
    { operation: 'TYPE_TEXT', targetLabel: 'Search query' },
    { operation: 'CLICK', targetLabel: 'Search' },
    { operation: 'DONE' },
    { verdict: 'SATISFIED' },
  ]);
  const router = new HybridRouter({
    backend: offline!.session,
    executor: executor(),
    typeSafe,
    textModel: new ScriptedTextModelClient(['blue widgets']),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit,
    config: offline!.config,
  });

  const outcome = await router.run('search for blue widgets', fixtureUrl('form.html'));

  assert.equal(outcome.status, 'completed', JSON.stringify(outcome.notes));
  assert.equal(outcome.verification.verified, true);
  assert.equal(outcome.jevSteps, 2);
  assert.equal(outcome.piFallbacks, 0);
  assert.deepEqual(outcome.history.map((record) => record.operation), ['TYPE_TEXT', 'CLICK']);
  assert.equal(outcome.history[0]!.textSummary, 'blue widgets');
  assert.equal(outcome.history[1]!.pageChanged, true);

  const result = await offline!.session.evaluateInPage<string>("document.getElementById('result').textContent");
  assert.match(result, /Results for: blue widgets/);
});

test('fixture — the domain policy stops a run before the browser is touched', { skip }, async () => {
  const audit = new MemoryAuditLog(new Redactor(), 'integration-domain');
  const router = new HybridRouter({
    backend: offline!.session,
    executor: executor(),
    typeSafe: new LabelDrivenTypeSafeClient([]),
    textModel: new ScriptedTextModelClient([]),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy({ allowedDomains: ['example.com'] }),
    audit,
    config: offline!.config,
  });
  const outcome = await router.run('open the fixture', fixtureUrl('form.html'));
  assert.equal(outcome.status, 'error');
  assert.match(String(outcome.error), /domain policy/i);
});
