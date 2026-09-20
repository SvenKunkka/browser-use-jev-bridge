import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainPolicy, DomainBlockedError, hostMatches } from '../src/safety/domains.js';
import { Redactor } from '../src/safety/redaction.js';
import { assessRisk, DenyHighRiskGate, ScriptedApprovalGate } from '../src/safety/approval-policy.js';
import { MemoryAuditLog } from '../src/logging/audit-log.js';

test('requirement 10 — domain allow and deny rules', () => {
  const policy = new DomainPolicy({
    allowedDomains: ['*.example.com', 'partner.test'],
    prohibitedDomains: ['evil.example.com'],
  });

  assert.equal(policy.check('https://example.com/a').allowed, true, 'apex is included by *.example.com');
  assert.equal(policy.check('https://docs.example.com/a').allowed, true);
  assert.equal(policy.check('https://partner.test/a').allowed, true);
  assert.equal(policy.check('https://evil.example.com/a').allowed, false, 'denial wins over allowance');
  assert.equal(policy.check('https://elsewhere.test/a').allowed, false);
  assert.equal(policy.check('file:///etc/passwd').allowed, false, 'non-http is refused when an allow list is set');
  assert.equal(policy.check('not a url').allowed, false);

  assert.throws(() => policy.assert('https://elsewhere.test/a'), DomainBlockedError);

  const denyOnly = new DomainPolicy({ prohibitedDomains: ['ads.test'] });
  assert.equal(denyOnly.check('https://anything.test/').allowed, true);
  assert.equal(denyOnly.check('https://ads.test/').allowed, false);

  const open = new DomainPolicy();
  assert.equal(open.isEnforcing, false);
  assert.equal(open.check('file:///tmp/x.html').allowed, true);

  assert.equal(hostMatches('*.a.com', 'a.com'), true);
  assert.equal(hostMatches('*.a.com', 'x.a.com'), true);
  assert.equal(hostMatches('*.a.com', 'xa.com'), false);
});

test('requirement 11 — secrets never survive into logs or error messages', () => {
  const redactor = new Redactor();
  redactor.register('TYPESAFE_API_KEY', 'ts-live-7f3a9b2c4d5e6f70');
  redactor.register('SECRET_DEMO_PASSWORD', 'hunter2-very-secret');

  const leaky =
    'POST failed for key ts-live-7f3a9b2c4d5e6f70 with header Authorization: Bearer abcd1234efgh5678 ' +
    'and body {"password":"hunter2-very-secret","token":"sk-proj-ABCDEFGHIJKLMNOP"} at https://u:p@host.test/x';
  const masked = redactor.redact(leaky);

  for (const secret of ['ts-live-7f3a9b2c4d5e6f70', 'hunter2-very-secret', 'abcd1234efgh5678', 'sk-proj-ABCDEFGHIJKLMNOP', 'u:p@']) {
    assert.equal(masked.includes(secret), false, `leaked: ${secret}`);
  }

  const log = new MemoryAuditLog(redactor, 'unit');
  log.write({ type: 'execution', note: leaky, nested: { deep: ['ts-live-7f3a9b2c4d5e6f70'] } });
  const serialized = JSON.stringify(log.entries);
  assert.equal(serialized.includes('ts-live-7f3a9b2c4d5e6f70'), false);
  assert.equal(serialized.includes('hunter2-very-secret'), false);

  assert.equal(redactor.summarizeTyped('hunter2-very-secret'), '«secret value, 19 chars»');
  assert.equal(redactor.summarizeTyped('blue widgets'), 'blue widgets');
});

test('requirement 9 — high-risk actions require human confirmation and are denied without one', async () => {
  const buy = assessRisk({ operation: 'CLICK', action: { label: 'Place order', kind: 'click' }, url: 'https://shop.test/cart' });
  assert.equal(buy.risk, 'high');
  assert.equal(buy.requiresApproval, true);

  for (const label of ['Send message', 'Delete account', 'Publish post', '立即购买', '提交审批', 'Upload résumé']) {
    const assessment = assessRisk({ operation: 'CLICK', action: { label, kind: 'click' }, url: 'https://x.test/' });
    assert.equal(assessment.requiresApproval, true, `${label} should require approval`);
  }
  for (const label of ['Next page', 'Sort by price', '下一页']) {
    const assessment = assessRisk({ operation: 'CLICK', action: { label, kind: 'click' }, url: 'https://x.test/' });
    assert.equal(assessment.requiresApproval, false, `${label} should not require approval`);
  }

  const credential = assessRisk({
    operation: 'TYPE_TEXT',
    action: { label: 'Verification code', kind: 'fill' },
    url: 'https://bank.test/',
  });
  assert.equal(credential.requiresApproval, true);

  const gate = new DenyHighRiskGate();
  const denied = await gate.request({
    url: 'https://shop.test/cart',
    source: 'jev',
    operation: 'CLICK',
    actionLabel: 'Place order',
    targetDescription: 'button — Place order',
    assessment: buy,
  });
  assert.equal(denied.approved, false);
  assert.match(denied.reason, /human confirmation/i);

  const allowed = await gate.request({
    url: 'https://shop.test/list',
    source: 'jev',
    operation: 'CLICK',
    actionLabel: 'Next page',
    targetDescription: 'button — Next page',
    assessment: assessRisk({ operation: 'CLICK', action: { label: 'Next page', kind: 'click' }, url: 'https://shop.test/list' }),
  });
  assert.equal(allowed.approved, true);

  const scripted = new ScriptedApprovalGate([true]);
  const approved = await scripted.request({
    url: 'https://shop.test/cart',
    source: 'jev',
    operation: 'CLICK',
    actionLabel: 'Place order',
    targetDescription: 'button — Place order',
    assessment: buy,
  });
  assert.equal(approved.approved, true);
  assert.equal(scripted.seen.length, 1);
});
