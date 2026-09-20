#!/usr/bin/env node
/**
 * bu-fast — command line entry point.
 *
 * Exit codes (stable; scripts and Codex depend on them):
 *   0  success — for `run`, the goal was reached AND independently verified
 *   1  the run finished without verified success (unverified, blocked, error)
 *   2  usage error
 *   3  stopped because an action was not approved
 *   4  environment/configuration problem (doctor not_ready, or startup failure)
 *
 * No flag accepts a credential. Every secret comes from the environment, or
 * from the project's `.env`, which this CLI loads explicitly at startup.
 */

import { accessSync, constants, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform, release } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyDotEnv,
  loadConfig,
  describeConfig,
  providerCredential,
  registerSecrets,
  type BridgeMode,
  type ConfigOverrides,
  type DotEnvResult,
} from './config.js';
import { runTask } from './index.js';
import { DenyHighRiskGate, TerminalApprovalGate, assessRisk } from './safety/approval-policy.js';
import { Redactor } from './safety/redaction.js';
import { DomainPolicy } from './safety/domains.js';
import { BudgetTracker } from './budget.js';
import { buildActionSpace } from './jev/action-space.js';
import { validateChoice } from './jev/policy.js';
import { assertDecisionFresh, fingerprintSnapshot, StaleDecisionError } from './jev/freshness.js';
import { buildMustNotRepeat } from './router/handoff.js';
import { parseFieldValue, TextHelperUnavailableError } from './jev/text-helper.js';
import type { ActionRecord, Decision, JevRawAction, JevSnapshot, RunOutcome } from './types.js';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_APPROVED = 3;
const EXIT_ENVIRONMENT = 4;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type FlagKind = 'boolean' | 'string' | 'positive-number';

interface FlagSpec {
  kind: FlagKind;
  repeatable?: boolean;
}

const COMMON_FLAGS: Record<string, FlagSpec> = { json: { kind: 'boolean' } };

const FLAG_SPECS: Record<string, Record<string, FlagSpec>> = {
  run: {
    ...COMMON_FLAGS,
    url: { kind: 'string' },
    goal: { kind: 'string' },
    mode: { kind: 'string' },
    review: { kind: 'boolean' },
    record: { kind: 'boolean' },
    'allowed-domain': { kind: 'string', repeatable: true },
    'prohibited-domain': { kind: 'string', repeatable: true },
    'max-steps': { kind: 'positive-number' },
    'timeout-ms': { kind: 'positive-number' },
    'max-cost-usd': { kind: 'positive-number' },
    'cdp-url': { kind: 'string' },
    workspace: { kind: 'string' },
  },
  verify: { ...COMMON_FLAGS, audit: { kind: 'string' } },
  doctor: { ...COMMON_FLAGS, mode: { kind: 'string' } },
};

export interface ParsedArguments {
  command: string;
  values: Map<string, string[]>;
  errors: string[];
}

/**
 * Strict parser. An unknown flag, a missing value, a repeated single-valued
 * flag or a non-positive number is a usage error, not something to ignore:
 * silently dropping `--max-setps 5` would run with the default budget.
 */
export function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] ?? '';
  const values = new Map<string, string[]>();
  const errors: string[] = [];
  const specs = FLAG_SPECS[command];

  for (let index = 1; index < argv.length; index++) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      errors.push(`Unexpected argument "${token}". Values must be attached to a flag.`);
      continue;
    }
    const body = token.slice(2);
    if (!body) {
      errors.push('Empty flag "--".');
      continue;
    }
    const equals = body.indexOf('=');
    const name = equals >= 0 ? body.slice(0, equals) : body;
    const inline = equals >= 0 ? body.slice(equals + 1) : undefined;

    if (!specs || !Object.hasOwn(specs, name)) {
      errors.push(`Unknown flag "--${name}".`);
      if (inline === undefined) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) index++;
      }
      continue;
    }
    const spec = specs[name] as FlagSpec;

    let raw: string;
    if (spec.kind === 'boolean') {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') {
        errors.push(`Flag "--${name}" is a switch and does not take the value "${inline}".`);
        continue;
      }
      raw = inline ?? 'true';
    } else if (inline !== undefined) {
      raw = inline;
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`Flag "--${name}" requires a value.`);
        continue;
      }
      raw = next;
      index++;
    }

    if (raw.trim() === '' && spec.kind !== 'boolean') {
      errors.push(`Flag "--${name}" requires a non-empty value.`);
      continue;
    }
    if (spec.kind === 'positive-number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.push(`Flag "--${name}" must be a positive number (got "${raw}").`);
        continue;
      }
    }

    const existing = values.get(name);
    if (existing && !spec.repeatable) {
      errors.push(`Flag "--${name}" was given more than once.`);
      continue;
    }
    values.set(name, [...(existing ?? []), raw]);
  }

  return { command, values, errors };
}

const one = (parsed: ParsedArguments, name: string): string | undefined => parsed.values.get(name)?.[0];
const many = (parsed: ParsedArguments, name: string): string[] => parsed.values.get(name) ?? [];
const bool = (parsed: ParsedArguments, name: string): boolean => one(parsed, name) === 'true';
const num = (parsed: ParsedArguments, name: string): number | undefined => {
  const raw = one(parsed, name);
  return raw === undefined ? undefined : Number(raw);
};

const USAGE = `bu-fast — hybrid browser tool (Jev fast policy + Browser Use Pi fallback)

Usage:
  bu-fast run --url URL --goal "GOAL" [options]
  bu-fast run --url URL --goal "GOAL" --review
  bu-fast verify [--audit PATH] [--json]
  bu-fast doctor [--mode fast|hybrid|pi] [--json]

Run options:
  --mode fast|hybrid|pi     policy selection (default: hybrid)
  --review                  show every action, on both legs, and ask first
  --allowed-domain HOST     repeatable; exact host or *.example.com
  --prohibited-domain HOST  repeatable; denials always win
  --max-steps N             total executed steps, Jev + Pi (default 40)
  --timeout-ms N            wall-clock budget for the whole run (default 300000)
  --max-cost-usd N          model spend cap for the whole run (default 1)
  --record                  enable Pi screen recording (OFF by default)
  --cdp-url URL             attach to an already-running Chrome
  --workspace DIR           where the audit log and Pi workspace live
  --json                    machine-readable result on stdout

The Browser Use Pi fallback is terminal: once it takes over, the run finishes
there and control does not return to the fast path.

Credentials come from the environment or from ./.env (loaded by this CLI only).
Exit codes: 0 verified success · 1 not verified · 2 usage · 3 not approved · 4 environment.
`;

let dotenv: DotEnvResult | undefined;

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (['', 'help', '--help', '-h'].includes(parsed.command)) {
    process.stdout.write(USAGE);
    return parsed.command === '' ? EXIT_USAGE : EXIT_OK;
  }
  if (!Object.hasOwn(FLAG_SPECS, parsed.command)) {
    process.stderr.write(`Unknown command "${parsed.command}".\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.errors.length) {
    for (const error of parsed.errors) process.stderr.write(`error: ${error}\n`);
    process.stderr.write(`\n${USAGE}`);
    return EXIT_USAGE;
  }

  // Explicit, documented: the CLI loads ./.env; the library entry point does not.
  dotenv = applyDotEnv();

  switch (parsed.command) {
    case 'run':
      return commandRun(parsed);
    case 'verify':
      return commandVerify(parsed);
    case 'doctor':
      return commandDoctor(parsed);
    default:
      process.stderr.write(USAGE);
      return EXIT_USAGE;
  }
}

// ---------------------------------------------------------------------------

async function commandRun(parsed: ParsedArguments): Promise<number> {
  const url = one(parsed, 'url');
  const goal = one(parsed, 'goal');
  if (!url || !goal) {
    process.stderr.write(`error: run requires --url and --goal.\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const target = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(target.protocol)) {
      process.stderr.write(`error: --url must be http(s) or file (got "${target.protocol}").\n`);
      return EXIT_USAGE;
    }
  } catch {
    process.stderr.write(`error: --url is not a valid URL: "${url}".\n`);
    return EXIT_USAGE;
  }

  const mode = (one(parsed, 'mode') ?? 'hybrid') as BridgeMode;
  if (!['fast', 'hybrid', 'pi'].includes(mode)) {
    process.stderr.write(`error: --mode must be one of fast|hybrid|pi (got "${mode}").\n`);
    return EXIT_USAGE;
  }

  const json = bool(parsed, 'json');
  const review = bool(parsed, 'review');
  const overrides: ConfigOverrides = { mode, review, json };
  const allowed = many(parsed, 'allowed-domain');
  const prohibited = many(parsed, 'prohibited-domain');
  if (allowed.length) overrides.allowedDomains = allowed;
  if (prohibited.length) overrides.prohibitedDomains = prohibited;
  const maxSteps = num(parsed, 'max-steps');
  if (maxSteps !== undefined) overrides.maxSteps = maxSteps;
  const timeoutMs = num(parsed, 'timeout-ms');
  if (timeoutMs !== undefined) overrides.timeoutMs = timeoutMs;
  const maxCostUsd = num(parsed, 'max-cost-usd');
  if (maxCostUsd !== undefined) overrides.maxCostUsd = maxCostUsd;
  if (bool(parsed, 'record')) overrides.record = true;
  const cdpUrl = one(parsed, 'cdp-url');
  if (cdpUrl) overrides.cdpUrl = cdpUrl;
  const workspace = one(parsed, 'workspace');
  if (workspace) overrides.workspace = workspace;

  const config = loadConfig(overrides);
  const redactor = new Redactor();
  registerSecrets(config, redactor);

  const interactive = Boolean(process.stdin.isTTY) && !json;
  if (review && !interactive) {
    process.stderr.write(
      'error: --review needs an interactive terminal (and is incompatible with --json). Nothing was executed.\n',
    );
    return EXIT_USAGE;
  }
  const gate = interactive ? new TerminalApprovalGate(redactor) : new DenyHighRiskGate();

  if (!json) {
    process.stderr.write(
      `mode=${config.mode} review=${config.review} telemetry=${config.telemetry ? 'on' : 'off'} ` +
        `recording=${config.recording ? 'on' : 'off'} approval=${gate.name} ` +
        `budget=${config.maxSteps} steps/${config.timeoutMs} ms/$${config.maxCostUsd}\n`,
    );
  }

  let outcome: RunOutcome;
  try {
    outcome = await runTask({ config, goal, url, gate });
  } catch (error) {
    const message = redactor.redact(error instanceof Error ? error.message : String(error));
    if (json) process.stdout.write(`${JSON.stringify({ status: 'error', error: message }, null, 2)}\n`);
    else process.stderr.write(`Run failed: ${message}\n`);
    return EXIT_ENVIRONMENT;
  }

  if (json) process.stdout.write(`${JSON.stringify(redactor.redactValue(outcome), null, 2)}\n`);
  else process.stdout.write(renderOutcome(outcome));

  return exitCodeForOutcome(outcome);
}

/**
 * The single place that turns a run outcome into a process exit code.
 * Exported so the mapping is unit-tested rather than asserted in prose.
 */
export function exitCodeForOutcome(outcome: Pick<RunOutcome, 'status' | 'verification'>): number {
  if (outcome.status === 'stopped_by_approval') return EXIT_NOT_APPROVED;
  return outcome.status === 'completed' && outcome.verification.verified ? EXIT_OK : EXIT_FAILED;
}

function renderOutcome(outcome: RunOutcome): string {
  const budget = outcome.budget;
  const lines = [
    '',
    `Status        : ${outcome.status}`,
    `Verified      : ${outcome.verification.verified} (${outcome.verification.verdict}` +
      `${outcome.verification.confidence === null ? '' : `, confidence ${outcome.verification.confidence}`}` +
      `${outcome.verification.satisfiedProbability === undefined ? '' : `, P(SATISFIED) ${outcome.verification.satisfiedProbability}`})`,
    `Steps         : ${outcome.steps} records (jev ${outcome.jevSteps}, pi legs ${outcome.piFallbacks})`,
    `Final URL     : ${outcome.finalUrl}`,
    `Duration      : ${outcome.durationMs} ms`,
    `Audit log     : ${outcome.auditLogPath ?? '(none)'}`,
  ];
  if (budget) {
    lines.push(
      `Budget        : steps ${budget.used.steps}/${budget.limits.maxSteps} · ` +
        `time ${budget.used.elapsedMs}/${budget.limits.timeoutMs} ms · ` +
        `cost $${budget.used.costUsd}/$${budget.limits.maxCostUsd}`,
    );
  }
  if (outcome.fallbackReasons.length) lines.push(`Fallbacks     : ${outcome.fallbackReasons.join(', ')}`);
  if (outcome.verification.reasons.length) {
    lines.push('Verification  :');
    for (const reason of outcome.verification.reasons) lines.push(`  - ${reason}`);
  }
  if (outcome.notes.length) {
    lines.push('Notes         :');
    for (const note of outcome.notes) lines.push(`  - ${note}`);
  }
  if (outcome.error) lines.push(`Error         : ${outcome.error}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

interface Check {
  name: string;
  passed: boolean;
  detail: string;
  required: boolean;
}

/** Offline invariant self-check. Contacts nothing and costs nothing. */
export function selfCheck(): Check[] {
  const checks: Check[] = [];
  const add = (name: string, required: boolean, run: () => string) => {
    try {
      checks.push({ name, passed: true, detail: run(), required });
    } catch (error) {
      checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error), required });
    }
  };

  const actions: JevRawAction[] = [
    { id: 'e1', kind: 'click', label: 'Search', node: 1, role: 'button' },
    { id: 'e2', kind: 'fill', label: 'Query', node: 2, role: 'textbox', value: '' },
    { id: 'e3', kind: 'select', label: 'Sort \u2192 Newest', node: 3, role: 'combobox', value: 'new', current_value: 'Relevance' },
    { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
  ];

  add('dynamic action space', true, () => {
    const space = buildActionSpace(actions);
    if (space.elements.length !== 3) throw new Error('expected three elements');
    if (!space.targets.CLICK || !space.targets.TYPE_TEXT || !space.targets.SELECT) {
      throw new Error('expected one target group per operation');
    }
    if (!space.controls.WAIT) throw new Error('expected a WAIT control');
    return '3 elements, CLICK/TYPE_TEXT/SELECT target groups, WAIT control';
  });

  add('TypeSafe response validation', true, () => {
    validateChoice({ choice: 'CLICK', confidence: 0.9, probabilities: { CLICK: 0.8, DONE: 0.2 } }, ['CLICK', 'DONE']);
    const bad: unknown[] = [
      { choice: 'NOPE', confidence: 1, probabilities: { CLICK: 1, DONE: 0 } },
      { choice: 'CLICK', confidence: 1, probabilities: { CLICK: 0.4, DONE: 0.2 } },
      { choice: 'CLICK', confidence: 1, probabilities: { CLICK: 0.2, DONE: 0.8 } },
      { choice: 'CLICK', confidence: 5, probabilities: { CLICK: 1, DONE: 0 } },
      null,
    ];
    let rejected = 0;
    for (const answer of bad) {
      try {
        validateChoice(answer, ['CLICK', 'DONE']);
      } catch {
        rejected++;
      }
    }
    if (rejected !== bad.length) throw new Error(`only ${rejected}/${bad.length} invalid responses rejected`);
    return `1 valid accepted, ${rejected} invalid rejected`;
  });

  add('stale decision cannot execute', true, () => {
    const base = { url: 'https://example.com/', text: 'a', actions, scroll: { y: 0, height: 900 } };
    const first = fingerprintSnapshot(base);
    const second = fingerprintSnapshot({ ...base, text: 'b' });
    if (first === second) throw new Error('fingerprint did not change with page content');
    try {
      assertDecisionFresh({ fingerprint: first } as Decision, { fingerprint: second } as JevSnapshot);
    } catch (error) {
      if (error instanceof StaleDecisionError) return 'fingerprint change invalidates the pending decision';
      throw error;
    }
    throw new Error('stale decision was accepted');
  });

  add('high-risk actions require approval', true, () => {
    const risky = assessRisk({ operation: 'CLICK', action: { label: 'Place order', kind: 'click' }, url: 'https://shop.example/' });
    const safe = assessRisk({ operation: 'CLICK', action: { label: 'Next page', kind: 'click' }, url: 'https://shop.example/' });
    if (!risky.requiresApproval) throw new Error('"Place order" was not treated as high risk');
    if (safe.requiresApproval) throw new Error('"Next page" was treated as high risk');
    const zh = assessRisk({ operation: 'CLICK', action: { label: '立即购买', kind: 'click' }, url: 'https://shop.example/' });
    if (!zh.requiresApproval) throw new Error('Chinese purchase label was not treated as high risk');
    const intent = assessRisk({ operation: 'PI_FALLBACK', url: 'https://shop.example/', intent: 'buy one widget' });
    if (!intent.requiresApproval) throw new Error('a purchase intent was not treated as high risk');
    return 'purchase/submit labels and purchase intents gated; navigation labels not';
  });

  add('domain allow/deny rules', true, () => {
    const policy = new DomainPolicy({ allowedDomains: ['*.example.com'], prohibitedDomains: ['evil.example.com'] });
    if (!policy.check('https://docs.example.com/x').allowed) throw new Error('subdomain should be allowed');
    if (!policy.check('https://example.com/x').allowed) throw new Error('apex should be allowed');
    if (policy.check('https://evil.example.com/x').allowed) throw new Error('denial must win');
    if (policy.check('https://other.test/x').allowed) throw new Error('host outside the allow list must be refused');
    return 'apex + wildcard allowed, denial wins, others refused';
  });

  add('secret redaction', true, () => {
    const redactor = new Redactor();
    redactor.register('DEMO', 'super-secret-value-123');
    const masked = redactor.redact('token=super-secret-value-123 and Authorization: Bearer abcdefgh12345678');
    if (masked.includes('super-secret-value-123')) throw new Error('registered secret leaked');
    if (masked.includes('abcdefgh12345678')) throw new Error('bearer token leaked');
    return 'registered values and bearer tokens masked';
  });

  add('text helper output validation', true, () => {
    if (parseFieldValue('{"text":"hello"}') !== 'hello') throw new Error('valid payload rejected');
    let rejected = 0;
    for (const bad of ['{"text":null}', '{"text":"" }', '{"text":"x","extra":1}', 'not json']) {
      try {
        parseFieldValue(bad);
      } catch (error) {
        if (error instanceof TextHelperUnavailableError) rejected++;
      }
    }
    if (rejected !== 4) throw new Error(`only ${rejected}/4 invalid text payloads rejected`);
    return '1 valid accepted, 4 invalid rejected';
  });

  add('handoff carries mustNotRepeat', true, () => {
    const history: ActionRecord[] = [
      {
        step: 1, source: 'jev', operation: 'CLICK', kind: 'click', actionId: 'e1', label: 'Submit order',
        url: 'https://shop.example/cart', risk: 'high', pageChanged: false,
        fingerprintBefore: 'a', startedAt: 0, finishedAt: 1, effectUncertain: true,
      },
      {
        step: 2, source: 'jev', operation: 'WAIT', kind: 'wait', actionId: 'wait', label: 'Wait',
        url: 'https://shop.example/cart', risk: 'low', pageChanged: false,
        fingerprintBefore: 'a', startedAt: 1, finishedAt: 2, effectUncertain: false,
      },
    ];
    const entries = buildMustNotRepeat(history);
    if (entries.length !== 1 || !entries[0]?.includes('Submit order')) {
      throw new Error('executed action missing from mustNotRepeat');
    }
    return 'Jev actions listed once; idempotent actions excluded (Pi-internal actions are not enumerated)';
  });

  add('budget is not reset between fallbacks', true, () => {
    let clock = 0;
    const tracker = new BudgetTracker({ maxSteps: 10, timeoutMs: 60_000, maxCostUsd: 1 }, () => clock);
    tracker.recordJevStep();
    tracker.recordPiRun(4, 0.3);
    const afterFirst = tracker.remaining();
    if (afterFirst.steps !== 5) throw new Error(`expected 5 steps left, got ${afterFirst.steps}`);
    tracker.recordPiRun(4, 0.3);
    const afterSecond = tracker.remaining();
    if (afterSecond.steps !== 1) throw new Error(`expected 1 step left, got ${afterSecond.steps}`);
    if (Math.abs(afterSecond.costUsd - 0.4) > 1e-9) throw new Error(`expected $0.40 left, got ${afterSecond.costUsd}`);
    clock = 60_001;
    if (tracker.exhausted() !== 'timeout') throw new Error('deadline was not detected');
    return 'two fallbacks consume one budget; the deadline is enforced';
  });

  return checks;
}

function commandVerify(parsed: ParsedArguments): number {
  const auditPath = one(parsed, 'audit');
  const json = bool(parsed, 'json');
  const checks = selfCheck();
  if (auditPath) checks.push(...auditChecks(auditPath));

  const failed = checks.filter((check) => !check.passed);
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: failed.length ? 'fail' : 'pass', checks }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
    }
    process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  }
  return failed.length ? EXIT_FAILED : EXIT_OK;
}

/** Re-checks a recorded run: a `completed` claim must carry a verified result. */
function auditChecks(path: string): Check[] {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const end = records.findLast((record) => record['type'] === 'run_end');
    if (!end) return [{ name: 'audit run_end present', passed: false, detail: 'no run_end record', required: true }];
    const claimed = end['status'] === 'completed';
    const verified = end['verified'] === true;
    return [
      {
        name: 'audit completion is backed by verification',
        passed: !claimed || verified,
        detail: claimed
          ? verified
            ? 'completed and independently verified'
            : 'completed was claimed without a verified result'
          : `status ${String(end['status'])} (no completion claimed)`,
        required: true,
      },
      {
        name: 'audit contains no obvious secret material',
        passed: !/sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(lines.join('\n')),
        detail: 'scanned for provider key and bearer shapes',
        required: true,
      },
    ];
  } catch (error) {
    return [
      { name: 'audit file readable', passed: false, detail: error instanceof Error ? error.message : String(error), required: true },
    ];
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export type Readiness = 'ready' | 'partial' | 'not_ready';

/** The worst of a set of readiness values. */
export function worstReadiness(values: Readiness[]): Readiness {
  if (values.includes('not_ready')) return 'not_ready';
  if (values.includes('partial')) return 'partial';
  return 'ready';
}

async function commandDoctor(parsed: ParsedArguments): Promise<number> {
  const json = bool(parsed, 'json');
  const mode = (one(parsed, 'mode') ?? 'hybrid') as BridgeMode;
  if (!['fast', 'hybrid', 'pi'].includes(mode)) {
    process.stderr.write(`error: --mode must be one of fast|hybrid|pi (got "${mode}").\n`);
    return EXIT_USAGE;
  }

  const config = loadConfig({ mode });
  const redactor = new Redactor();
  registerSecrets(config, redactor);
  const checks: Check[] = [];
  const readiness: Readiness[] = [];
  const blockers: string[] = [];

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 19);
  checks.push({ name: 'node version', passed: nodeOk, detail: `${process.version} (@browser_use/pi requires >= 22.19)`, required: true });
  if (!nodeOk) {
    readiness.push('not_ready');
    blockers.push(`Node ${process.version} is older than the required 22.19.`);
  }

  // Resolve the installed package from this file's location, not from the
  // working directory: `bu-fast` is normally run from somewhere else. Note
  // that @browser_use/pi's `exports` map has no `require` condition and does
  // not expose ./package.json, so neither `require.resolve` nor
  // `import.meta.resolve('@browser_use/pi/package.json')` can find it — the
  // manifest has to be located on disk.
  let piVersion = 'not installed';
  let piOk = false;
  {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      const manifestPath = join(directory, 'node_modules', '@browser_use', 'pi', 'package.json');
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
          piVersion = manifest.version ?? 'unknown';
          piOk = true;
        } catch {
          piOk = false;
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  checks.push({ name: 'pi package', passed: piOk, detail: `@browser_use/pi ${piVersion}`, required: true });
  if (!piOk) {
    readiness.push('not_ready');
    blockers.push('@browser_use/pi is not installed; run npm ci.');
  }

  // --- browser ------------------------------------------------------------
  const candidates = [
    ...(config.browser.executablePath ? [config.browser.executablePath] : []),
    ...(CHROME_CANDIDATES[platform()] ?? []),
  ];
  const chrome = candidates.find((candidate) => existsSync(candidate));
  const browserRequired = config.browser.kind !== 'cloud';
  checks.push({
    name: 'chrome available',
    passed: Boolean(chrome) || !browserRequired,
    detail: chrome ? `found ${chrome}` : `no Chrome/Chromium at known paths for ${platform()} ${release()}`,
    required: browserRequired,
  });
  if (browserRequired && !chrome) {
    readiness.push('not_ready');
    blockers.push('No Chrome/Chromium was found; set BUJB_CHROME_EXECUTABLE or install one.');
  }

  const cdpUrl = config.browser.cdpUrl;
  if (cdpUrl) {
    let detail = 'not reachable';
    let ok = false;
    try {
      const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        const info = (await response.json()) as Record<string, string>;
        detail = `${info['Browser'] ?? 'unknown build'} at ${cdpUrl}`;
        ok = true;
      } else detail = `HTTP ${response.status} from ${cdpUrl}`;
    } catch (error) {
      detail = `${cdpUrl}: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ name: 'chrome remote debugging', passed: ok, detail, required: config.browser.kind === 'chrome' });
    if (!ok && config.browser.kind === 'chrome') {
      readiness.push('not_ready');
      blockers.push(`BUJB_CDP_URL is set to ${cdpUrl} but nothing answered there.`);
    }
  } else {
    checks.push({
      name: 'chrome remote debugging',
      passed: true,
      // Not "verified": nothing was contacted, so do not imply a successful probe.
      detail: 'not configured (no BUJB_CDP_URL); Pi would launch or attach at run time — NOT verified here',
      required: false,
    });
    readiness.push('partial');
  }

  // --- credentials, per mode ----------------------------------------------
  const typeSafeKey = Boolean(config.typesafe.apiKey);
  const textKey = Boolean(config.textModel.apiKey);
  const piCredential = providerCredential(config.pi.model);
  const piKey = piCredential.present.length > 0;
  const cloudKey = Boolean(config.browser.cloudApiKey);

  const fastReady: Readiness = !typeSafeKey ? 'not_ready' : textKey ? 'ready' : 'partial';
  const piReady: Readiness = (() => {
    if (!piKey) return 'not_ready';
    if (config.browser.kind === 'cloud' && !cloudKey) return 'not_ready';
    return 'ready';
  })();

  checks.push({
    name: 'fast path credentials',
    passed: fastReady !== 'not_ready',
    detail:
      `TYPESAFE_API_KEY ${typeSafeKey ? 'set' : 'unset'}; TEXT_MODEL_API_KEY ${textKey ? 'set' : 'unset'}` +
      (typeSafeKey ? '' : ' — the Jev fast path cannot make a decision without TypeSafe') +
      (typeSafeKey && !textKey ? ' — TYPE_TEXT cannot run without a text model' : ''),
    required: mode !== 'pi',
  });
  checks.push({
    name: 'pi fallback credentials',
    passed: piReady !== 'not_ready',
    detail:
      `model ${config.pi.model} → provider "${piCredential.provider}"${piCredential.known ? '' : ' (unknown provider; env var name is a guess)'}; ` +
      `candidates ${piCredential.candidates.join(', ')}; ${piKey ? 'set' : 'unset'}` +
      (config.browser.kind === 'cloud' ? `; BROWSER_USE_API_KEY ${cloudKey ? 'set' : 'unset'}` : ''),
    required: mode !== 'fast',
  });

  if (mode === 'fast') {
    readiness.push(fastReady);
    if (fastReady === 'not_ready') blockers.push('TYPESAFE_API_KEY is unset, so --mode fast cannot run.');
    if (fastReady === 'partial') blockers.push('TEXT_MODEL_API_KEY is unset: TYPE_TEXT steps will fail.');
  } else if (mode === 'pi') {
    readiness.push(piReady);
    if (piReady === 'not_ready') {
      blockers.push(
        `No credential for the Pi model's provider "${piCredential.provider}" (${piCredential.candidates.join(' or ')}).`,
      );
    }
  } else {
    // hybrid: both legs are checked separately; neither usable means not_ready.
    if (fastReady === 'not_ready' && piReady === 'not_ready') {
      readiness.push('not_ready');
      blockers.push('Neither the Jev fast path nor the Pi fallback has usable credentials.');
    } else if (fastReady !== 'ready' || piReady !== 'ready') {
      readiness.push('partial');
      if (fastReady === 'not_ready') blockers.push('The Jev fast path is unusable: TYPESAFE_API_KEY is unset.');
      if (fastReady === 'partial') blockers.push('TYPE_TEXT is unusable: TEXT_MODEL_API_KEY is unset.');
      if (piReady === 'not_ready') blockers.push(`The Pi fallback is unusable: no ${piCredential.candidates.join('/')}.`);
    } else readiness.push('ready');
  }

  for (const [name, present] of [
    ['TYPESAFE_API_KEY', typeSafeKey],
    ['TEXT_MODEL_API_KEY', textKey],
    ['BROWSER_USE_API_KEY', cloudKey],
    ...piCredential.candidates.map((candidate) => [candidate, Boolean(process.env[candidate])] as [string, boolean]),
  ] as [string, boolean][]) {
    // Only ever "set" or "unset" — never a prefix, length or fingerprint.
    checks.push({ name: `env ${name}`, passed: present, detail: present ? 'set' : 'unset', required: false });
  }

  checks.push({
    name: 'typesafe endpoint',
    passed: Boolean(config.typesafe.baseUrl),
    detail: `${config.typesafe.baseUrl} (model ${config.typesafe.model}, key ${typeSafeKey ? 'set' : 'unset'}) — not contacted`,
    required: false,
  });
  checks.push({
    name: 'text model endpoint',
    passed: Boolean(config.textModel.baseUrl),
    detail: `${config.textModel.baseUrl} (model ${config.textModel.model}, key ${textKey ? 'set' : 'unset'}) — not contacted`,
    required: false,
  });

  // --- workspace, privacy, .env -------------------------------------------
  let workspaceOk = false;
  let workspaceDetail = '';
  try {
    mkdirSync(config.workspace, { recursive: true });
    accessSync(config.workspace, constants.W_OK);
    const probe = join(config.workspace, `.bujb-write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
    workspaceOk = true;
    workspaceDetail = `${config.workspace} is writable`;
  } catch (error) {
    workspaceDetail = `${config.workspace}: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({ name: 'workspace writable', passed: workspaceOk, detail: workspaceDetail, required: true });
  if (!workspaceOk) {
    readiness.push('not_ready');
    blockers.push('The workspace directory is not writable.');
  }

  checks.push({
    name: 'dotenv',
    passed: true,
    detail: dotenv?.found
      ? `${dotenv.path}: applied ${dotenv.applied.length} name(s) [${dotenv.applied.join(', ') || 'none'}], ` +
        `${dotenv.skipped.length} already set in the environment` +
        (dotenv.malformedLines.length ? `, malformed lines ${dotenv.malformedLines.join(', ')}` : '')
      : `${dotenv?.path ?? join(process.cwd(), '.env')}: not present`,
    required: false,
  });
  checks.push({
    name: 'telemetry',
    passed: true,
    detail: config.telemetry
      ? 'ENABLED — explicitly opted in via BUJB_TELEMETRY'
      : `disabled (default); DO_NOT_TRACK=${process.env['DO_NOT_TRACK'] ? 'set' : 'unset'}`,
    required: false,
  });
  checks.push({
    name: 'recording',
    passed: true,
    detail: config.recording ? 'ENABLED — explicitly opted in' : 'disabled (default)',
    required: false,
  });
  checks.push({
    name: 'verification thresholds',
    passed: true,
    detail: `minConfidence ${config.verification.minConfidence}, minProbability ${config.verification.minProbability}`,
    required: false,
  });

  const status = worstReadiness(readiness.length ? readiness : ['ready']);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status,
          mode,
          platform: `${platform()} ${release()}`,
          node: process.version,
          legs: { fast: fastReady, pi: piReady },
          blockers,
          checks,
          config: describeConfig(config),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const check of checks) {
      const mark = check.passed ? 'PASS' : check.required ? 'FAIL' : 'WARN';
      process.stdout.write(`${mark}  ${check.name}: ${check.detail}\n`);
    }
    process.stdout.write(`\nmode=${mode} fast=${fastReady} pi=${piReady}\ndoctor: ${status}\n`);
    for (const blocker of blockers) process.stdout.write(`  - ${blocker}\n`);
  }
  return status === 'not_ready' ? EXIT_ENVIRONMENT : EXIT_OK;
}

/**
 * Only run when this file is the process entry point. Without the guard, a
 * test that imports `parseArguments` would execute the whole CLI.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const redactor = new Redactor();
      redactor.registerEnvironment();
      process.stderr.write(
        `${redactor.redact(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
      );
      process.exitCode = EXIT_ENVIRONMENT;
    });
}
