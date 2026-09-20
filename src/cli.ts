#!/usr/bin/env node
/**
 * bu-fast — command line entry point.
 *
 * Exit codes (stable; scripts and Codex depend on them):
 *   0  success — for `run`, the goal was reached AND independently verified
 *   1  the run finished without verified success (unverified, blocked, error)
 *   2  usage error
 *   3  stopped because a high-risk action was not approved
 *   4  environment/configuration problem (doctor, or startup failure)
 *
 * No flag accepts a credential. Every secret comes from the environment.
 */

import { accessSync, constants, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { platform, release } from 'node:os';
import { loadConfig, describeConfig, registerSecrets, type BridgeMode, type ConfigOverrides } from './config.js';
import { runTask } from './index.js';
import { DenyHighRiskGate, TerminalApprovalGate, assessRisk } from './safety/approval-policy.js';
import { Redactor } from './safety/redaction.js';
import { DomainPolicy } from './safety/domains.js';
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

interface ParsedArguments {
  command: string;
  flags: Map<string, string[]>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] ?? '';
  const flags = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) continue;
    const [name, inline] = token.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[index + 1];
    let value: string;
    if (inline !== undefined) value = inline;
    else if (next !== undefined && !next.startsWith('--')) {
      value = next;
      index++;
    } else value = 'true';
    const bucket = flags.get(name) ?? [];
    bucket.push(value);
    flags.set(name, bucket);
  }
  return { command, flags };
}

const one = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.[0];
const many = (flags: Map<string, string[]>, name: string): string[] => flags.get(name) ?? [];
const bool = (flags: Map<string, string[]>, name: string): boolean => {
  const value = one(flags, name);
  return value !== undefined && value !== 'false';
};
const int = (flags: Map<string, string[]>, name: string): number | undefined => {
  const value = one(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const USAGE = `bu-fast — hybrid browser tool (Jev fast policy + Browser Use Pi fallback)

Usage:
  bu-fast run --url URL --goal "GOAL" [options]
  bu-fast run --url URL --goal "GOAL" --review
  bu-fast verify [--audit PATH] [--json]
  bu-fast doctor [--json]

Run options:
  --mode fast|hybrid|pi     policy selection (default: hybrid)
  --review                  show every action and ask before executing it
  --allowed-domain HOST     repeatable; exact host or *.example.com
  --prohibited-domain HOST  repeatable; denials always win
  --max-steps N             total executed actions (default 40)
  --timeout-ms N            wall-clock budget for the whole run (default 300000)
  --max-cost-usd N          model spend cap handed to Pi (default 1)
  --record                  enable Pi screen recording (OFF by default)
  --cdp-url URL             attach to an already-running Chrome
  --workspace DIR           where the audit log and Pi workspace live
  --json                    machine-readable result on stdout

Credentials are read from the environment only; see .env.example.
Exit codes: 0 verified success · 1 not verified · 2 usage · 3 not approved · 4 environment.
`;

async function main(): Promise<number> {
  const { command, flags } = parseArguments(process.argv.slice(2));
  switch (command) {
    case 'run':
      return commandRun(flags);
    case 'verify':
      return commandVerify(flags);
    case 'doctor':
      return commandDoctor(flags);
    case '':
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return command === '' ? EXIT_USAGE : EXIT_OK;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}

// ---------------------------------------------------------------------------

async function commandRun(flags: Map<string, string[]>): Promise<number> {
  const url = one(flags, 'url');
  const goal = one(flags, 'goal');
  if (!url || !goal || url === 'true' || goal === 'true') {
    process.stderr.write(`run requires --url and --goal.\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const mode = (one(flags, 'mode') ?? 'hybrid') as BridgeMode;
  if (!['fast', 'hybrid', 'pi'].includes(mode)) {
    process.stderr.write(`--mode must be one of fast|hybrid|pi.\n`);
    return EXIT_USAGE;
  }

  const json = bool(flags, 'json');
  const review = bool(flags, 'review');
  const overrides: ConfigOverrides = { mode, review, json };
  const allowed = many(flags, 'allowed-domain').filter((value) => value !== 'true');
  const prohibited = many(flags, 'prohibited-domain').filter((value) => value !== 'true');
  if (allowed.length) overrides.allowedDomains = allowed;
  if (prohibited.length) overrides.prohibitedDomains = prohibited;
  const maxSteps = int(flags, 'max-steps');
  if (maxSteps !== undefined) overrides.maxSteps = maxSteps;
  const timeoutMs = int(flags, 'timeout-ms');
  if (timeoutMs !== undefined) overrides.timeoutMs = timeoutMs;
  const maxCostUsd = int(flags, 'max-cost-usd');
  if (maxCostUsd !== undefined) overrides.maxCostUsd = maxCostUsd;
  if (bool(flags, 'record')) overrides.record = true;
  const cdpUrl = one(flags, 'cdp-url');
  if (cdpUrl && cdpUrl !== 'true') overrides.cdpUrl = cdpUrl;
  const workspace = one(flags, 'workspace');
  if (workspace && workspace !== 'true') overrides.workspace = workspace;

  const config = loadConfig(overrides);
  const redactor = new Redactor();
  registerSecrets(config, redactor);

  const interactive = Boolean(process.stdin.isTTY) && !json;
  if (review && !interactive) {
    process.stderr.write(
      '--review needs an interactive terminal (and is incompatible with --json). Nothing was executed.\n',
    );
    return EXIT_USAGE;
  }
  const gate = interactive ? new TerminalApprovalGate(redactor) : new DenyHighRiskGate();

  if (!json) {
    process.stderr.write(
      `mode=${config.mode} review=${config.review} telemetry=${config.telemetry ? 'on' : 'off'} ` +
        `recording=${config.recording ? 'on' : 'off'} approval=${gate.name}\n`,
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

  if (json) {
    process.stdout.write(`${JSON.stringify(redactor.redactValue(outcome), null, 2)}\n`);
  } else {
    process.stdout.write(renderOutcome(outcome));
  }
  if (outcome.status === 'stopped_by_approval') return EXIT_NOT_APPROVED;
  return outcome.status === 'completed' && outcome.verification.verified ? EXIT_OK : EXIT_FAILED;
}

function renderOutcome(outcome: RunOutcome): string {
  const lines = [
    '',
    `Status        : ${outcome.status}`,
    `Verified      : ${outcome.verification.verified} (${outcome.verification.verdict})`,
    `Steps         : ${outcome.steps} (jev ${outcome.jevSteps}, pi fallbacks ${outcome.piFallbacks})`,
    `Final URL     : ${outcome.finalUrl}`,
    `Duration      : ${outcome.durationMs} ms`,
    `Audit log     : ${outcome.auditLogPath ?? '(none)'}`,
  ];
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
      checks.push({
        name,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
        required,
      });
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
    let rejected = 0;
    const bad: unknown[] = [
      { choice: 'NOPE', confidence: 1, probabilities: { CLICK: 1, DONE: 0 } },
      { choice: 'CLICK', confidence: 1, probabilities: { CLICK: 0.4, DONE: 0.2 } },
      { choice: 'CLICK', confidence: 1, probabilities: { CLICK: 0.2, DONE: 0.8 } },
      { choice: 'CLICK', confidence: 5, probabilities: { CLICK: 1, DONE: 0 } },
      null,
    ];
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
    const decision = { fingerprint: first } as Decision;
    const snapshot = { fingerprint: second } as JevSnapshot;
    try {
      assertDecisionFresh(decision, snapshot);
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
    return 'purchase/submit labels gated, navigation labels not';
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
    return 'executed action listed once; idempotent actions excluded';
  });

  return checks;
}

function commandVerify(flags: Map<string, string[]>): number {
  const auditPath = one(flags, 'audit');
  const json = bool(flags, 'json');
  const checks = selfCheck();

  if (auditPath && auditPath !== 'true') {
    checks.push(...auditChecks(auditPath));
  }

  const failed = checks.filter((check) => !check.passed);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: failed.length ? 'fail' : 'pass', checks }, null, 2)}\n`,
    );
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
      {
        name: 'audit file readable',
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
        required: true,
      },
    ];
  }
}

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

async function commandDoctor(flags: Map<string, string[]>): Promise<number> {
  const json = bool(flags, 'json');
  const config = loadConfig({});
  const redactor = new Redactor();
  registerSecrets(config, redactor);
  const checks: Check[] = [];

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 19);
  checks.push({
    name: 'node version',
    passed: nodeOk,
    detail: `${process.version} (@browser_use/pi requires >= 22.19)`,
    required: true,
  });

  let piVersion = 'not installed';
  let piOk = false;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require('@browser_use/pi/package.json') as { version?: string; engines?: { node?: string } };
    piVersion = manifest.version ?? 'unknown';
    piOk = true;
  } catch {
    try {
      const local = join(process.cwd(), 'node_modules/@browser_use/pi/package.json');
      piVersion = (JSON.parse(readFileSync(local, 'utf8')) as { version: string }).version;
      piOk = true;
    } catch {
      piOk = false;
    }
  }
  checks.push({ name: 'pi package', passed: piOk, detail: `@browser_use/pi ${piVersion}`, required: true });

  const candidates = [
    ...(config.browser.executablePath ? [config.browser.executablePath] : []),
    ...(CHROME_CANDIDATES[platform()] ?? []),
  ];
  const chrome = candidates.find((candidate) => existsSync(candidate));
  checks.push({
    name: 'chrome available',
    passed: Boolean(chrome) || config.browser.kind === 'cloud',
    detail: chrome ? `found ${chrome}` : `no Chrome/Chromium at known paths for ${platform()} ${release()}`,
    required: config.browser.kind !== 'cloud',
  });

  const cdpUrl = config.browser.cdpUrl;
  if (cdpUrl) {
    let detail = 'not reachable';
    let ok = false;
    try {
      const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, {
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) {
        const info = (await response.json()) as Record<string, string>;
        detail = `${info['Browser'] ?? 'unknown build'} at ${cdpUrl}`;
        ok = true;
      } else detail = `HTTP ${response.status} from ${cdpUrl}`;
    } catch (error) {
      detail = `${cdpUrl}: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ name: 'chrome remote debugging', passed: ok, detail, required: config.browser.kind === 'chrome' });
  } else {
    checks.push({
      name: 'chrome remote debugging',
      passed: true,
      detail: 'no BUJB_CDP_URL configured; Pi will launch or attach by profile',
      required: false,
    });
  }

  const required: [string, boolean][] = [
    ['TYPESAFE_API_KEY', Boolean(config.typesafe.apiKey)],
    ['TEXT_MODEL_API_KEY', Boolean(config.textModel.apiKey)],
    ['OPENROUTER_API_KEY', Boolean(process.env['OPENROUTER_API_KEY'])],
  ];
  for (const [name, present] of required) {
    checks.push({
      name: `env ${name}`,
      passed: present,
      // Only ever "set" or "unset" — never a prefix, length or fingerprint.
      detail: present ? 'set' : 'unset',
      required: false,
    });
  }

  checks.push({
    name: 'typesafe endpoint',
    passed: Boolean(config.typesafe.baseUrl),
    detail: `${config.typesafe.baseUrl} (model ${config.typesafe.model}, key ${config.typesafe.apiKey ? 'set' : 'unset'})`,
    required: false,
  });
  checks.push({
    name: 'text model endpoint',
    passed: Boolean(config.textModel.baseUrl),
    detail: `${config.textModel.baseUrl} (model ${config.textModel.model}, key ${config.textModel.apiKey ? 'set' : 'unset'})`,
    required: false,
  });

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

  const failedRequired = checks.filter((check) => check.required && !check.passed);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: failedRequired.length ? 'fail' : 'ok',
          platform: `${platform()} ${release()}`,
          node: process.version,
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
    process.stdout.write(`\n${failedRequired.length ? 'doctor: required checks failed' : 'doctor: ok'}\n`);
  }
  return failedRequired.length ? EXIT_ENVIRONMENT : EXIT_OK;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const redactor = new Redactor();
    redactor.registerEnvironment();
    process.stderr.write(`${redactor.redact(error instanceof Error ? error.stack ?? error.message : String(error))}\n`);
    process.exitCode = EXIT_ENVIRONMENT;
  });
