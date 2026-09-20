import assert from 'node:assert/strict';
import test from 'node:test';
import { PiApprovalController, describeToolCall } from '../src/pi/fallback.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';
import { Redactor } from '../src/safety/redaction.js';
import { DenyHighRiskGate, ScriptedApprovalGate } from '../src/safety/approval-policy.js';
import { makePiToolCallContext, ScriptedTypeSafeClient } from '../src/testing/harness.js';
import { HybridRouter } from '../src/router/hybrid-router.js';
import { DomainPolicy } from '../src/safety/domains.js';
import { MissingTextModelClient } from '../src/jev/text-helper.js';
import { FakeBackend, FakeExecutor, FakeFallback, deniedController, makeSnapshot, testConfig } from './helpers.js';

function controller(options: { review: boolean; gate: ConstructorParameters<typeof ScriptedApprovalGate>[0] | 'deny' }) {
  const redactor = new Redactor();
  const audit = new MemoryAuditLog(redactor, 'pi-approval');
  const gate = options.gate === 'deny' ? new DenyHighRiskGate() : new ScriptedApprovalGate(options.gate);
  const instance = new PiApprovalController({
    gate,
    redactor,
    audit,
    review: options.review,
    currentUrl: () => 'https://shop.test/cart',
  });
  return { instance, audit, gate };
}

test('the hook reads the real Pi context shape (toolCall.name and args)', async () => {
  const { instance } = controller({ review: false, gate: 'deny' });
  const context = makePiToolCallContext('javascript', { code: "await page.evaluate('1')" });
  assert.equal(context.toolCall.name, 'javascript');
  assert.deepEqual(context.args, { code: "await page.evaluate('1')" });
  assert.equal(describeToolCall(context.toolCall.name, context.args), "await page.evaluate('1')");
  // A benign cell passes without a prompt in default mode.
  assert.equal(await instance.hook(context), undefined);
});

test('a high-risk Pi cell is blocked when nobody can approve it', async () => {
  const { instance, audit } = controller({ review: false, gate: 'deny' });
  const context = makePiToolCallContext('javascript', {
    code: "await page.evaluate('document.querySelector(\\'#place-order\\').click()')",
  });
  const result = await instance.hook(context);
  assert.ok(result, 'the hook must return a blocking result');
  assert.equal(result!.block, true);
  assert.equal(result!.terminate, true);
  assert.match(String(result!.reason), /approval policy/i);
  assert.ok(instance.denial, 'the denial is recorded for the router');
  assert.equal(instance.denial!.toolName, 'javascript');
  const approval = audit.entries.find((entry) => entry['type'] === 'approval' && entry['source'] === 'pi');
  assert.equal(approval?.['approved'], false);
});

test('review mode gates every Pi tool call, not just the risky-looking ones', async () => {
  const { instance, gate } = controller({ review: true, gate: [true, true, true] });
  await instance.hook(makePiToolCallContext('javascript', { code: 'await page.info()' }, 'a'));
  await instance.hook(makePiToolCallContext('javascript', { code: 'await snapshot()' }, 'b'));
  await instance.hook(makePiToolCallContext('finish', { result: 'done' }, 'c'));
  assert.equal((gate as ScriptedApprovalGate).seen.length, 3, 'all three calls were reviewed');
  assert.deepEqual(
    (gate as ScriptedApprovalGate).seen.map((request) => request.operation),
    ['PI_FALLBACK:javascript', 'PI_FALLBACK:javascript', 'PI_FALLBACK:finish'],
  );
});

test('an approved high-risk Pi cell proceeds', async () => {
  const { instance } = controller({ review: false, gate: [true] });
  const result = await instance.hook(
    makePiToolCallContext('javascript', { code: "document.querySelector('#submit').click()" }),
  );
  assert.equal(result, undefined);
  assert.equal(instance.denial, undefined);
});

test('a denied Pi tool call ends the run as stopped_by_approval', async () => {
  const snapshot = makeSnapshot();
  const fallback = new FakeFallback({ status: 'cancelled', steps: 1 });
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor: new FakeExecutor([snapshot]),
    typeSafe: new ScriptedTypeSafeClient([{ operation: { choice: 'BLOCKED' } }]),
    textModel: new MissingTextModelClient(),
    fallback,
    piController: deniedController('javascript', 'operator declined'),
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'pi-approval'),
    config: testConfig(),
  });

  const outcome = await router.run('open the embedded report', 'https://example.com/list');
  assert.equal(outcome.status, 'stopped_by_approval');
  assert.match(String(outcome.error), /not approved/i);
  assert.equal(outcome.verification.verified, false);
});

test('a consequential goal needs approval before Pi is even started', async () => {
  const snapshot = makeSnapshot();
  const fallback = new FakeFallback();
  const router = new HybridRouter({
    backend: new FakeBackend(),
    executor: new FakeExecutor([snapshot]),
    typeSafe: new ScriptedTypeSafeClient([{ operation: { choice: 'BLOCKED' } }]),
    textModel: new MissingTextModelClient(),
    fallback,
    gate: new DenyHighRiskGate(),
    redactor: new Redactor(),
    domainPolicy: new DomainPolicy(),
    audit: new MemoryAuditLog(new Redactor(), 'pi-approval'),
    config: testConfig(),
  });

  const outcome = await router.run('buy one widget and pay with the saved card', 'https://example.com/list');
  assert.equal(fallback.calls.length, 0, 'Pi is never started for an unapproved consequential goal');
  assert.equal(outcome.status, 'stopped_by_approval');
});
