import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridRouter, detectUnsupported } from '../src/router/hybrid-router.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';
import { Redactor } from '../src/safety/redaction.js';
import { DomainPolicy } from '../src/safety/domains.js';
import { DenyHighRiskGate, ScriptedApprovalGate } from '../src/safety/approval-policy.js';
import { MissingTextModelClient } from '../src/jev/text-helper.js';
import { StalePageError } from '../src/jev/freshness.js';
import { ScriptedTextModelClient, ScriptedTypeSafeClient, type ScriptedAnswer } from '../src/testing/harness.js';
import {
  FakeBackend,
  FakeExecutor,
  FakeFallback,
  NO_UNSUPPORTED,
  makeAction,
  makeSnapshot,
  testConfig,
} from './helpers.js';
import type { BridgeConfig } from '../src/config.js';
import type { JevSnapshot } from '../src/types.js';

function buildRouter(options: {
  snapshots: JevSnapshot[];
  script: ScriptedAnswer[];
  fallback?: FakeFallback | undefined;
  gate?: ConstructorParameters<typeof ScriptedApprovalGate>[0] | 'deny';
  config?: Partial<BridgeConfig>;
  text?: string[];
  withoutTypeSafe?: boolean;
}) {
  const executor = new FakeExecutor(options.snapshots);
  const audit = new MemoryAuditLog(new Redactor(), 'router-test');
  const typeSafe = new ScriptedTypeSafeClient(options.script);
  const fallback = options.fallback;
  const gate =
    options.gate === 'deny' || options.gate === undefined
      ? new DenyHighRiskGate()
      : new ScriptedApprovalGate(options.gate);
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    ...(options.withoutTypeSafe ? {} : { typeSafe }),
    textModel: options.text ? new ScriptedTextModelClient(options.text) : new MissingTextModelClient(),
    ...(fallback ? { fallback } : {}),
    gate,
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit,
    config: testConfig(options.config),
  });
  return { router, executor, audit, typeSafe, gate, fallback };
}

const CLICK_E1: ScriptedAnswer = { operation: { choice: 'CLICK' }, click_target: { choice: '1' } };
const DONE: ScriptedAnswer = { operation: { choice: 'DONE' } };
const BLOCKED: ScriptedAnswer = { operation: { choice: 'BLOCKED' } };
const SATISFIED: ScriptedAnswer = { verdict: { choice: 'SATISFIED' } };
const NOT_SATISFIED: ScriptedAnswer = { verdict: { choice: 'NOT_SATISFIED' } };

test('requirement 6 — three actions with no page change hand the task to Pi', async () => {
  const snapshot = makeSnapshot();
  const fallback = new FakeFallback();
  const { router, executor } = buildRouter({
    snapshots: [snapshot],
    script: [CLICK_E1, CLICK_E1, CLICK_E1, DONE, SATISFIED],
    fallback,
  });

  const outcome = await router.run('reach page two', 'https://example.com/list');

  assert.equal(executor.executed.length, 3, 'exactly three fast-path actions before the handoff');
  assert.equal(fallback.calls.length, 1);
  assert.match(fallback.calls[0]!.fallbackReason, /no observable page change/i);
  assert.deepEqual(outcome.fallbackReasons, ['no_progress']);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.piFallbacks, 1);
});

test('requirement 7 — BLOCKED hands the task to Pi instead of guessing', async () => {
  const fallback = new FakeFallback();
  const { router, executor } = buildRouter({
    snapshots: [makeSnapshot()],
    script: [BLOCKED, DONE, SATISFIED],
    fallback,
  });

  const outcome = await router.run('upload the contract', 'https://example.com/list');

  assert.equal(executor.executed.length, 0, 'nothing is executed on BLOCKED');
  assert.equal(fallback.calls.length, 1);
  assert.deepEqual(outcome.fallbackReasons, ['jev_blocked']);
  assert.equal(outcome.status, 'completed');
});

test('requirement 7 — BLOCKED with no fallback available stops instead of continuing', async () => {
  const { router, executor } = buildRouter({
    snapshots: [makeSnapshot()],
    script: [BLOCKED, NOT_SATISFIED],
    config: { mode: 'fast' },
  });
  const outcome = await router.run('upload the contract', 'https://example.com/list');
  assert.equal(outcome.status, 'blocked');
  assert.equal(executor.executed.length, 0);
  assert.equal(outcome.verification.verified, false);
});

test('two consecutive stale decisions hand the task to Pi', async () => {
  const snapshot = makeSnapshot();
  const fallback = new FakeFallback();
  const executor = new FakeExecutor([snapshot]);
  executor.actError = () => new StalePageError('Page changed since this decision. Observe again.');
  const audit = new MemoryAuditLog(new Redactor(), 'router-test');
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    typeSafe: new ScriptedTypeSafeClient([CLICK_E1, CLICK_E1, DONE, SATISFIED]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit,
    config: testConfig(),
  });

  const outcome = await router.run('reach page two', 'https://example.com/list');

  assert.equal(executor.executed.length, 0, 'a stale action never reaches the page');
  assert.equal(audit.entries.filter((entry) => entry['type'] === 'stale').length, 2);
  assert.deepEqual(outcome.fallbackReasons, ['stale_repeated']);
  assert.equal(fallback.calls.length, 1);
  assert.match(fallback.calls[0]!.fallbackReason, /changed underneath two consecutive decisions/i);
});

test('requirement 12 — control returns to Jev only through a fresh observation', async () => {
  const before = makeSnapshot({ text: 'before fallback' });
  const after = makeSnapshot({ text: 'after fallback' });
  const fallback = new FakeFallback();
  const executor = new FakeExecutor([before, after]);
  const audit = new MemoryAuditLog(new Redactor(), 'router-test');
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    typeSafe: new ScriptedTypeSafeClient([BLOCKED, DONE, SATISFIED]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit,
    config: testConfig(),
  });

  const outcome = await router.run('finish the form', 'https://example.com/list');

  const types = audit.entries.map((entry) => entry['type']);
  const fallbackEnd = types.lastIndexOf('fallback_end');
  const observationAfter = types.indexOf('observation', fallbackEnd);
  const decisionAfter = types.indexOf('decision', fallbackEnd);
  assert.ok(fallbackEnd >= 0, 'fallback ran');
  assert.ok(observationAfter > fallbackEnd, 'the page is re-observed after the fallback');
  assert.ok(decisionAfter === -1 || decisionAfter > observationAfter, 'no decision is taken before re-observing');

  const piRecord = outcome.history.find((record) => record.source === 'pi');
  assert.ok(piRecord, 'the fallback leg is recorded in history');
  assert.equal(piRecord!.fingerprintAfter, after.fingerprint);
  assert.equal(piRecord!.pageChanged, true);
});

test('requirement 13 — a DONE claim that fails verification is never reported as completed', async () => {
  const { router } = buildRouter({
    snapshots: [makeSnapshot()],
    script: [DONE, NOT_SATISFIED],
    fallback: new FakeFallback(),
  });
  const outcome = await router.run('buy a widget', 'https://example.com/list');
  assert.equal(outcome.status, 'unverified');
  assert.equal(outcome.verification.verified, false);
  assert.equal(outcome.verification.verdict, 'NOT_SATISFIED');
});

test('requirement 13 — with no verifier configured the run is unverified, not completed', async () => {
  const executor = new FakeExecutor([makeSnapshot()]);
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    textModel: new MissingTextModelClient(),
    fallback: new FakeFallback(),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'router-test'),
    config: testConfig({ mode: 'pi' }),
  });
  const outcome = await router.run('do the thing', 'https://example.com/list');
  assert.equal(outcome.verification.verdict, 'NOT_RUN');
  assert.notEqual(outcome.status, 'completed');
});

test('requirement 9 — an unapproved high-risk action stops the run before anything is dispatched', async () => {
  const snapshot = makeSnapshot({
    actions: [
      makeAction({ id: 'e1', kind: 'click', label: 'Place order', node: 1, role: 'button' }),
      makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    ],
  });
  const { router, executor, audit } = buildRouter({
    snapshots: [snapshot],
    script: [CLICK_E1, NOT_SATISFIED],
    fallback: new FakeFallback(),
  });

  const outcome = await router.run('order the widget', 'https://example.com/list');

  assert.equal(outcome.status, 'stopped_by_approval');
  assert.equal(executor.executed.length, 0, 'nothing reached the browser');
  const approval = audit.entries.find((entry) => entry['type'] === 'approval');
  assert.equal(approval?.['approved'], false);
  assert.equal(outcome.verification.verified, false);
});

test('an approved high-risk action does execute, and is recorded as high risk', async () => {
  const snapshot = makeSnapshot({
    actions: [
      makeAction({ id: 'e1', kind: 'click', label: 'Place order', node: 1, role: 'button' }),
      makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    ],
  });
  const { router, executor } = buildRouter({
    snapshots: [snapshot, makeSnapshot({ text: 'Order placed' })],
    script: [CLICK_E1, DONE, SATISFIED],
    fallback: new FakeFallback(),
    gate: [true],
  });
  const outcome = await router.run('order the widget', 'https://example.com/list');
  assert.equal(executor.executed.length, 1);
  assert.equal(outcome.history[0]!.risk, 'high');
  assert.equal(outcome.history[0]!.approved, true);
});

test('a credential-like field is never filled by the text model', async () => {
  const snapshot = makeSnapshot({
    actions: [
      makeAction({ id: 'e1', kind: 'fill', label: 'Verification code', node: 1, role: 'textbox', value: '' }),
      makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' }),
    ],
  });
  const text = new ScriptedTextModelClient(['123456']);
  const fallback = new FakeFallback();
  const executor = new FakeExecutor([snapshot]);
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    typeSafe: new ScriptedTypeSafeClient([
      { operation: { choice: 'TYPE_TEXT' }, type_text_target: { choice: '1' } },
      DONE,
      SATISFIED,
    ]),
    textModel: text,
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'router-test'),
    config: testConfig(),
  });

  await router.run('log in', 'https://example.com/list');
  assert.equal(text.contexts.length, 0, 'the text model was never asked for a credential');
  assert.equal(executor.executed.length, 0);
  assert.deepEqual(fallback.calls.length, 1);
  assert.match(fallback.calls[0]!.fallbackReason, /credential-like/i);
});

test('unsupported-page detection routes iframes, canvas, shadow DOM, popups and uploads to Pi', () => {
  const plain = makeSnapshot();
  assert.equal(detectUnsupported(plain, 'click next').unsupported, false);

  const iframeOnly = makeSnapshot({
    actions: [makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' })],
    unsupported: { ...NO_UNSUPPORTED, iframes: 1, crossOriginIframes: 1 },
  });
  assert.equal(detectUnsupported(iframeOnly, 'click the embedded button').unsupported, true);

  const canvasOnly = makeSnapshot({
    actions: [makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' })],
    unsupported: { ...NO_UNSUPPORTED, canvases: 1 },
  });
  assert.equal(detectUnsupported(canvasOnly).unsupported, true);

  const shadowOnly = makeSnapshot({
    actions: [makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' })],
    unsupported: { ...NO_UNSUPPORTED, shadowRoots: 3 },
  });
  assert.equal(detectUnsupported(shadowOnly).unsupported, true);

  const popup = makeSnapshot({ tabCount: 2 });
  assert.match(detectUnsupported(popup).reasons.join(' '), /popup or new tab/);
  assert.equal(detectUnsupported(popup, '', 2).unsupported, false, "the operator's pre-existing tabs are not a signal");

  const upload = makeSnapshot({ unsupported: { ...NO_UNSUPPORTED, fileInputs: 1 } });
  assert.equal(detectUnsupported(upload, 'upload my CV').unsupported, true);
  assert.equal(detectUnsupported(upload, 'read the page').unsupported, false);

  const dialog = makeSnapshot({
    actions: [makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' })],
    unsupported: { ...NO_UNSUPPORTED, openDialogs: 1 },
  });
  assert.equal(detectUnsupported(dialog).unsupported, true);
});

test('an unsupported page is handed over before any action is attempted', async () => {
  const unsupported = makeSnapshot({
    actions: [makeAction({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' })],
    unsupported: { ...NO_UNSUPPORTED, iframes: 1, crossOriginIframes: 1 },
  });
  const fallback = new FakeFallback();
  const executor = new FakeExecutor([unsupported, makeSnapshot({ text: 'done' })]);
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor,
    typeSafe: new ScriptedTypeSafeClient([DONE, SATISFIED]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'router-test'),
    config: testConfig(),
  });

  const outcome = await router.run('click the button inside the frame', 'https://example.com/list');
  assert.equal(executor.executed.length, 0);
  assert.deepEqual(outcome.fallbackReasons, ['unsupported_page']);
});
