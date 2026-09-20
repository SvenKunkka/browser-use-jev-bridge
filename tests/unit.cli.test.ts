import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, worstReadiness, selfCheck, exitCodeForOutcome } from '../src/cli.js';
import { applyDotEnv, parseDotEnv, loadConfig, describeConfig, providerCredential } from '../src/config.js';
import { sessionStateForOutcome } from '../src/mcp/session-manager.js';
import type { RunStatus } from '../src/types.js';

test('regression — an unknown flag is a usage error, not silently ignored', () => {
  const parsed = parseArguments(['run', '--url', 'https://x.test/', '--goal', 'g', '--max-setps', '5']);
  assert.ok(parsed.errors.some((error) => /Unknown flag "--max-setps"/.test(error)));
  assert.equal(parsed.values.has('max-setps'), false);
});

test('regression — budget flags must be positive numbers', () => {
  for (const [flag, value] of [
    ['--max-steps', '0'],
    ['--max-steps', '-3'],
    ['--timeout-ms', '-1'],
    ['--max-cost-usd', 'abc'],
    ['--max-steps', 'NaN'],
  ] as [string, string][]) {
    const parsed = parseArguments(['run', '--url', 'https://x.test/', '--goal', 'g', flag, value]);
    assert.ok(
      parsed.errors.some((error) => error.includes('must be a positive number')),
      `${flag} ${value} should be rejected`,
    );
  }
  const ok = parseArguments(['run', '--url', 'https://x.test/', '--goal', 'g', '--max-steps', '12']);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.values.get('max-steps'), ['12']);
});

test('a single-valued flag given twice is an error; repeatable flags accumulate', () => {
  const duplicated = parseArguments(['run', '--url', 'https://a.test/', '--url', 'https://b.test/', '--goal', 'g']);
  assert.ok(duplicated.errors.some((error) => /--url" was given more than once/.test(error)));

  const repeated = parseArguments([
    'run', '--url', 'https://a.test/', '--goal', 'g',
    '--allowed-domain', 'a.test', '--allowed-domain', 'b.test',
  ]);
  assert.deepEqual(repeated.errors, []);
  assert.deepEqual(repeated.values.get('allowed-domain'), ['a.test', 'b.test']);
});

test('a flag that needs a value must get one', () => {
  const missing = parseArguments(['run', '--url', '--goal', 'g']);
  assert.ok(missing.errors.some((error) => /--url" requires a value/.test(error)));
  const empty = parseArguments(['run', '--url=', '--goal', 'g']);
  assert.ok(empty.errors.some((error) => /requires a non-empty value/.test(error)));
});

test('switches do not swallow the next token and reject values', () => {
  const parsed = parseArguments(['run', '--review', '--url', 'https://a.test/', '--goal', 'g']);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.values.get('review'), ['true']);
  assert.deepEqual(parsed.values.get('url'), ['https://a.test/']);

  const bad = parseArguments(['run', '--review=maybe', '--url', 'https://a.test/', '--goal', 'g']);
  assert.ok(bad.errors.some((error) => /is a switch/.test(error)));
});

test('doctor readiness is the worst of its parts', () => {
  assert.equal(worstReadiness(['ready', 'ready']), 'ready');
  assert.equal(worstReadiness(['ready', 'partial']), 'partial');
  assert.equal(worstReadiness(['partial', 'not_ready']), 'not_ready');
});

test('the offline self-check covers every invariant it claims to', () => {
  const checks = selfCheck();
  const names = checks.map((check) => check.name);
  for (const expected of [
    'dynamic action space',
    'TypeSafe response validation',
    'stale decision cannot execute',
    'high-risk actions require approval',
    'domain allow/deny rules',
    'secret redaction',
    'text helper output validation',
    'handoff carries mustNotRepeat',
    'budget is not reset between fallbacks',
  ]) {
    assert.ok(names.includes(expected), `missing self-check: ${expected}`);
  }
  assert.deepEqual(checks.filter((check) => !check.passed), []);
});

// ---------------------------------------------------------------------------

test('regression — .env is parsed, applied, and never overrides the real environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bujb-env-'));
  try {
    writeFileSync(
      join(dir, '.env'),
      [
        '# a comment',
        '',
        'TYPESAFE_API_KEY=ts-from-dotenv',
        'export TEXT_MODEL_API_KEY="tm-from-dotenv"',
        "BUJB_PI_MODEL='openrouter/openai/gpt-5.6-luna'",
        'BUJB_MAX_STEPS=7 # trailing comment',
        'NOT A VALID LINE',
      ].join('\n'),
    );

    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: 'already-set-in-shell' };
    const result = applyDotEnv(dir, env);

    assert.equal(result.found, true);
    assert.equal(env['TYPESAFE_API_KEY'], 'already-set-in-shell', 'the shell value must win');
    assert.deepEqual(result.skipped, ['TYPESAFE_API_KEY']);
    assert.equal(env['TEXT_MODEL_API_KEY'], 'tm-from-dotenv');
    assert.equal(env['BUJB_PI_MODEL'], 'openrouter/openai/gpt-5.6-luna');
    assert.equal(env['BUJB_MAX_STEPS'], '7');
    assert.ok(result.applied.includes('TEXT_MODEL_API_KEY'));
    assert.deepEqual(result.malformedLines, [7]);

    // The result reports names only — never a value.
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('tm-from-dotenv'), false);
    assert.equal(serialized.includes('already-set-in-shell'), false);

    // And the config built from that environment still reports keys as set/unset only.
    const described = JSON.stringify(describeConfig(loadConfig({}, env)));
    assert.equal(described.includes('tm-from-dotenv'), false);
    assert.equal(described.includes('already-set-in-shell'), false);
    assert.match(described, /"apiKey":"set"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing .env is not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bujb-env-none-'));
  try {
    const result = applyDotEnv(dir, {});
    assert.equal(result.found, false);
    assert.deepEqual(result.applied, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the .env parser handles quotes, comments and escapes', () => {
  const { entries } = parseDotEnv(
    ['A=1', 'B="two words"', "C='three'", 'D=four # comment', 'E="line\\nbreak"', '#F=ignored'].join('\n'),
  );
  assert.equal(entries.get('A'), '1');
  assert.equal(entries.get('B'), 'two words');
  assert.equal(entries.get('C'), 'three');
  assert.equal(entries.get('D'), 'four');
  assert.equal(entries.get('E'), 'line\nbreak');
  assert.equal(entries.has('F'), false);
});

test('provider credentials are resolved from the model id', () => {
  const known = providerCredential('openrouter/openai/gpt-5.6-luna', { OPENROUTER_API_KEY: 'x' });
  assert.equal(known.provider, 'openrouter');
  assert.equal(known.known, true);
  assert.deepEqual(known.present, ['OPENROUTER_API_KEY']);

  const missing = providerCredential('anthropic/claude', {});
  assert.deepEqual(missing.present, []);
  assert.ok(missing.candidates.includes('ANTHROPIC_API_KEY'));

  const unknown = providerCredential('acme-cloud/model-1', { 'ACME_CLOUD_API_KEY': 'y' });
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.candidates, ['ACME_CLOUD_API_KEY']);
  assert.deepEqual(unknown.present, ['ACME_CLOUD_API_KEY']);
});

test('the exit-code mapping is exactly what the docs promise', () => {
  const verified = { verified: true } as never;
  const unverified = { verified: false } as never;
  assert.equal(exitCodeForOutcome({ status: 'completed', verification: verified }), 0);
  assert.equal(exitCodeForOutcome({ status: 'completed', verification: unverified }), 1);
  assert.equal(exitCodeForOutcome({ status: 'unverified', verification: unverified }), 1);
  assert.equal(exitCodeForOutcome({ status: 'blocked', verification: unverified }), 1);
  assert.equal(exitCodeForOutcome({ status: 'timeout', verification: unverified }), 1);
  assert.equal(exitCodeForOutcome({ status: 'cost_limit', verification: unverified }), 1);
  assert.equal(exitCodeForOutcome({ status: 'stopped_by_approval', verification: unverified }), 3);
});

test('the CLI exit code and the MCP session state agree on every outcome', () => {
  const verified = { verified: true } as never;
  const unverified = { verified: false } as never;
  const cases: { status: RunStatus; verification: never; state: string; exit: number }[] = [
    { status: 'completed', verification: verified, state: 'completed', exit: 0 },
    { status: 'unverified', verification: unverified, state: 'unverified', exit: 1 },
    { status: 'blocked', verification: unverified, state: 'blocked', exit: 1 },
    { status: 'step_limit', verification: unverified, state: 'blocked', exit: 1 },
    { status: 'timeout', verification: unverified, state: 'timeout', exit: 1 },
    { status: 'cost_limit', verification: unverified, state: 'cost_limit', exit: 1 },
    { status: 'cancelled', verification: unverified, state: 'cancelled', exit: 1 },
    { status: 'error', verification: unverified, state: 'failed', exit: 1 },
    { status: 'stopped_by_approval', verification: unverified, state: 'blocked', exit: 3 },
  ];
  for (const testCase of cases) {
    assert.equal(
      sessionStateForOutcome(testCase.status),
      testCase.state,
      `MCP state for ${testCase.status}`,
    );
    assert.equal(
      exitCodeForOutcome({ status: testCase.status, verification: testCase.verification }),
      testCase.exit,
      `CLI exit code for ${testCase.status}`,
    );
  }
  // The only state that means "the goal was verified" is the only exit code 0.
  const success = cases.filter((entry) => entry.exit === 0);
  assert.deepEqual(success.map((entry) => entry.state), ['completed']);
});
