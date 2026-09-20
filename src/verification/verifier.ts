/**
 * Independent result verification.
 *
 * `DONE` from the fast policy, or `completed` from Pi, is a *claim*. This
 * module decides whether the run may be reported as completed, and it does so
 * from evidence it collects itself:
 *
 *   1. a fresh observation taken after the claim, never the snapshot the
 *      decision was made on;
 *   2. deterministic checks that do not involve a model at all;
 *   3. a separate model call that is shown only the goal and the fresh page,
 *      never the agent's claim, its history of successes, or the decision
 *      heads' answers.
 *
 * If any layer is unavailable the run is reported as `unverified`. It is never
 * upgraded to `completed` because "the model said DONE".
 */

import type { ActionRecord, JevSnapshot, VerificationResult } from '../types.js';
import type { TypeSafeClient } from '../jev/policy.js';
import { validateChoice } from '../jev/policy.js';
import { VERDICT } from '../jev/questions.js';
import type { DomainPolicy } from '../safety/domains.js';

const VERDICTS = ['SATISFIED', 'NOT_SATISFIED', 'INSUFFICIENT_EVIDENCE'] as const;

export interface VerifierDependencies {
  client?: TypeSafeClient;
  model: string;
  domainPolicy: DomainPolicy;
  signal?: AbortSignal;
}

export function deterministicChecks(
  snapshot: JevSnapshot,
  history: ActionRecord[],
  domainPolicy: DomainPolicy,
): { name: string; passed: boolean; detail: string }[] {
  const checks: { name: string; passed: boolean; detail: string }[] = [];

  checks.push({
    name: 'fresh_observation',
    passed: Date.now() - snapshot.observedAt < 60_000,
    detail: `observation age ${Date.now() - snapshot.observedAt} ms`,
  });

  const verdict = domainPolicy.check(snapshot.url);
  checks.push({
    name: 'final_url_within_policy',
    passed: verdict.allowed,
    detail: verdict.reason,
  });

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
  const checks = deterministicChecks(snapshot, history, deps.domainPolicy);
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
      reasons: ['No verification model is configured, so completion cannot be confirmed independently.'],
      evidence,
      deterministicChecks: checks,
    };
  }

  const body = {
    model: deps.model,
    state: {
      page: {
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
      },
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

  let answerChoice: string;
  let confidence: number;
  try {
    const response = await deps.client.ask(body, deps.signal);
    const answer = validateChoice(response?.answers?.['verdict'], VERDICTS);
    answerChoice = answer.choice;
    confidence = answer.confidence;
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

  const verdict = answerChoice as (typeof VERDICTS)[number];
  return {
    verified: verdict === 'SATISFIED',
    verdict,
    confidence,
    reasons:
      verdict === 'SATISFIED'
        ? ['Independent check found visible evidence for every requirement.']
        : [`Independent check returned ${verdict}.`],
    evidence,
    deterministicChecks: checks,
  };
}
