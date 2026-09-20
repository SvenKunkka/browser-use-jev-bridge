/**
 * Final result verification.
 *
 * `DONE` from the fast policy, or `completed` from Pi, is a *claim*. This
 * module decides whether the run may be reported as completed, from evidence
 * it collects itself:
 *
 *   1. a fresh observation taken strictly after the claim — not the snapshot
 *      the claim was made on;
 *   2. deterministic checks that involve no model at all;
 *   3. a separate, independent *call* that is shown only the goal and the
 *      fresh page — never the agent's claim, its history of successes, or the
 *      decision heads' answers.
 *
 * Point 3 is a new request, not a new model: it currently goes to the same
 * TypeSafe provider and model id as the decision heads. That is a real
 * limitation — a systematic bias in that model is shared by both — and it is
 * stated rather than dressed up as an independent judge.
 *
 * A run is reported `completed` only when the verdict is SATISFIED, every
 * deterministic check passed, and both the answer's confidence and the
 * probability mass it puts on SATISFIED clear the configured thresholds.
 */

import type { ActionRecord, JevSnapshot, VerificationResult } from '../types.js';
import type { TypeSafeClient } from '../jev/policy.js';
import { validateChoice } from '../jev/policy.js';
import { VERDICT } from '../jev/questions.js';
import type { DomainPolicy } from '../safety/domains.js';

const VERDICTS = ['SATISFIED', 'NOT_SATISFIED', 'INSUFFICIENT_EVIDENCE'] as const;

export interface VerifierThresholds {
  minConfidence: number;
  minProbability: number;
}

export interface VerifierDependencies {
  client?: TypeSafeClient;
  model: string;
  domainPolicy: DomainPolicy;
  thresholds: VerifierThresholds;
  /**
   * Timestamp of the completion claim. The observation handed to the verifier
   * must have been taken after it, or verification fails closed.
   */
  claimedAt?: number;
  signal?: AbortSignal;
}

export function deterministicChecks(
  snapshot: JevSnapshot,
  history: ActionRecord[],
  domainPolicy: DomainPolicy,
  claimedAt?: number,
): { name: string; passed: boolean; detail: string }[] {
  const checks: { name: string; passed: boolean; detail: string }[] = [];

  checks.push({
    name: 'fresh_observation',
    passed: Date.now() - snapshot.observedAt < 60_000,
    detail: `observation age ${Date.now() - snapshot.observedAt} ms`,
  });

  if (claimedAt !== undefined) {
    const after = snapshot.observedAt >= claimedAt;
    checks.push({
      name: 'observation_after_claim',
      passed: after,
      detail: after
        ? `observation taken ${snapshot.observedAt - claimedAt} ms after the completion claim`
        : 'the observation predates the completion claim, so it cannot confirm it',
    });
  }

  const verdict = domainPolicy.check(snapshot.url);
  checks.push({ name: 'final_url_within_policy', passed: verdict.allowed, detail: verdict.reason });

  const rendered = snapshot.text.trim().length > 0 || snapshot.actions.length > 1;
  checks.push({
    name: 'page_rendered',
    passed: rendered,
    detail: rendered ? 'page exposes text or controls' : 'page exposes neither text nor controls',
  });

  const unresolved = history.filter((record) => record.effectUncertain && record.pageChanged === null);
  checks.push({
    name: 'no_unresolved_actions',
    passed: unresolved.length === 0,
    detail:
      unresolved.length === 0
        ? 'every executed action has a post-action observation'
        : `${unresolved.length} action(s) executed without a confirmed post-action observation`,
  });

  return checks;
}

export async function verifyOutcome(
  goal: string,
  snapshot: JevSnapshot,
  history: ActionRecord[],
  deps: VerifierDependencies,
): Promise<VerificationResult> {
  const checks = deterministicChecks(snapshot, history, deps.domainPolicy, deps.claimedAt);
  const evidence = {
    url: snapshot.url,
    title: snapshot.title,
    fingerprint: snapshot.fingerprint,
    textExcerpt: snapshot.text.slice(0, 2000),
    observedAt: snapshot.observedAt,
  };
  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    return {
      verified: false,
      verdict: 'NOT_SATISFIED',
      confidence: null,
      reasons: failed.map((check) => `${check.name}: ${check.detail}`),
      evidence,
      deterministicChecks: checks,
    };
  }

  if (!deps.client) {
    return {
      verified: false,
      verdict: 'NOT_RUN',
      confidence: null,
      reasons: ['No verification endpoint is configured, so completion cannot be confirmed.'],
      evidence,
      deterministicChecks: checks,
    };
  }

  const body = {
    model: deps.model,
    state: {
      page: { url: snapshot.url, title: snapshot.title, text: snapshot.text },
      visible_controls: snapshot.actions
        .filter((action) => action.kind !== 'wait' && action.kind !== 'scroll')
        .slice(0, 120)
        .map((action) => ({ label: action.label, role: action.role, value: action.value ?? '' })),
    },
    questions: {
      verdict: {
        type: 'choice',
        criteria: {
          SATISFIED: 'The supplied page state visibly demonstrates every requirement of the goal.',
          NOT_SATISFIED: 'The supplied page state shows at least one requirement is not met.',
          INSUFFICIENT_EVIDENCE: 'The supplied page state does not show whether the goal is met.',
        },
        instructions: { goal, rules: VERDICT },
      },
    },
  };

  let verdict: (typeof VERDICTS)[number];
  let confidence: number;
  let satisfiedProbability: number;
  try {
    const response = await deps.client.ask(body, deps.signal);
    const answer = validateChoice(response?.answers?.['verdict'], VERDICTS);
    verdict = answer.choice as (typeof VERDICTS)[number];
    confidence = answer.confidence;
    satisfiedProbability = answer.probabilities['SATISFIED'] ?? 0;
  } catch (error) {
    return {
      verified: false,
      verdict: 'NOT_RUN',
      confidence: null,
      reasons: [
        `Independent verification could not be completed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      evidence,
      deterministicChecks: checks,
    };
  }

  const reasons: string[] = [];
  if (verdict !== 'SATISFIED') reasons.push(`Independent check returned ${verdict}.`);
  if (confidence < deps.thresholds.minConfidence) {
    reasons.push(
      `Confidence ${confidence.toFixed(3)} is below the required ${deps.thresholds.minConfidence}.`,
    );
  }
  if (satisfiedProbability < deps.thresholds.minProbability) {
    reasons.push(
      `Probability of SATISFIED ${satisfiedProbability.toFixed(3)} is below the required ${deps.thresholds.minProbability}.`,
    );
  }

  const verified = reasons.length === 0;
  if (verified) reasons.push('Independent check found visible evidence for every requirement.');

  return {
    verified,
    verdict,
    confidence,
    satisfiedProbability,
    reasons,
    evidence,
    deterministicChecks: checks,
  };
}
