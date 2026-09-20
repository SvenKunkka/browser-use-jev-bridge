import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyOutcome } from '../src/verification/verifier.js';
import { DomainPolicy } from '../src/safety/domains.js';
import type { TypeSafeClient } from '../src/jev/policy.js';
import type { TypeSafeResponse } from '../src/types.js';
import { makeSnapshot } from './helpers.js';

const THRESHOLDS = { minConfidence: 0.8, minProbability: 0.8 };

function verdictClient(choice: string, confidence: number, probabilities: Record<string, number>): TypeSafeClient {
  return {
    description: 'verdict stub',
    async ask(): Promise<TypeSafeResponse> {
      return { answers: { verdict: { choice, confidence, probabilities } } };
    },
  };
}

const SATISFIED_STRONG = verdictClient('SATISFIED', 0.95, {
  SATISFIED: 0.9,
  NOT_SATISFIED: 0.05,
  INSUFFICIENT_EVIDENCE: 0.05,
});

test('every threshold satisfied — the run may be reported completed', async () => {
  const snapshot = makeSnapshot({ observedAt: Date.now() });
  const result = await verifyOutcome('find the widget', snapshot, [], {
    client: SATISFIED_STRONG,
    model: 'test',
    domainPolicy: new DomainPolicy(),
    thresholds: THRESHOLDS,
    claimedAt: snapshot.observedAt - 10,
  });
  assert.equal(result.verified, true);
  assert.equal(result.verdict, 'SATISFIED');
  assert.equal(result.satisfiedProbability, 0.9);
});

test('SATISFIED with low confidence is not verified', async () => {
  const snapshot = makeSnapshot({ observedAt: Date.now() });
  const result = await verifyOutcome('find the widget', snapshot, [], {
    client: verdictClient('SATISFIED', 0.42, { SATISFIED: 0.9, NOT_SATISFIED: 0.05, INSUFFICIENT_EVIDENCE: 0.05 }),
    model: 'test',
    domainPolicy: new DomainPolicy(),
    thresholds: THRESHOLDS,
    claimedAt: snapshot.observedAt - 10,
  });
  assert.equal(result.verified, false);
  assert.equal(result.verdict, 'SATISFIED', 'the verdict is reported honestly even though it was not accepted');
  assert.ok(result.reasons.some((reason) => /Confidence 0\.420 is below/.test(reason)));
});

test('SATISFIED with low probability mass is not verified', async () => {
  const snapshot = makeSnapshot({ observedAt: Date.now() });
  const result = await verifyOutcome('find the widget', snapshot, [], {
    client: verdictClient('SATISFIED', 0.99, { SATISFIED: 0.5, NOT_SATISFIED: 0.3, INSUFFICIENT_EVIDENCE: 0.2 }),
    model: 'test',
    domainPolicy: new DomainPolicy(),
    thresholds: THRESHOLDS,
    claimedAt: snapshot.observedAt - 10,
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.some((reason) => /Probability of SATISFIED 0\.500 is below/.test(reason)));
});

test('high confidence cannot rescue a failed deterministic check', async () => {
  const snapshot = makeSnapshot({ observedAt: Date.now(), url: 'https://elsewhere.test/x' });
  const result = await verifyOutcome('find the widget', snapshot, [], {
    client: SATISFIED_STRONG,
    model: 'test',
    domainPolicy: new DomainPolicy({ allowedDomains: ['example.com'] }),
    thresholds: THRESHOLDS,
    claimedAt: snapshot.observedAt - 10,
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.some((reason) => /final_url_within_policy/.test(reason)));
  assert.equal(
    result.deterministicChecks.some((check) => check.name === 'final_url_within_policy' && !check.passed),
    true,
  );
});

test('an observation taken before the completion claim cannot confirm it', async () => {
  const snapshot = makeSnapshot({ observedAt: Date.now() - 5_000 });
  const result = await verifyOutcome('find the widget', snapshot, [], {
    client: SATISFIED_STRONG,
    model: 'test',
    domainPolicy: new DomainPolicy(),
    thresholds: THRESHOLDS,
    claimedAt: Date.now(),
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.some((reason) => /observation_after_claim/.test(reason)));
});

test('a verifier that cannot be reached leaves the run unverified, never completed', async () => {
  const snapshot = makeSnapshot({ observedAt: Date.now() });
  const result = await verifyOutcome('find the widget', snapshot, [], {
    client: {
      description: 'broken',
      async ask() {
        throw new Error('network down');
      },
    },
    model: 'test',
    domainPolicy: new DomainPolicy(),
    thresholds: THRESHOLDS,
  });
  assert.equal(result.verified, false);
  assert.equal(result.verdict, 'NOT_RUN');
});
