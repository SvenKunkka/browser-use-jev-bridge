/**
 * CLI integration: the built `dist/cli.js` is spawned as a real process, so
 * exit codes and readiness are checked the way a caller (or Codex) sees them.
 *
 * No credentials are present in the test environment, which is exactly the
 * state `doctor` has to report as not_ready rather than ok.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = resolve(process.cwd(), 'dist/cli.js');
const built = existsSync(CLI);
const skip = built ? false : 'dist/cli.js is not built — run `npm run build` first';

const CLEAN_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  NODE_OPTIONS: '',
};

async function cli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...CLEAN_ENV, ...options.env },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bujb-cli-'));
}

test('cli — doctor reports not_ready with no credentials, and exits 4', { skip }, async () => {
  const cwd = scratch();
  try {
    const result = await cli(['doctor', '--mode', 'hybrid', '--json'], { cwd });
    assert.equal(result.code, 4, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout) as {
      status: string;
      legs: { fast: string; pi: string };
      blockers: string[];
      config: Record<string, unknown>;
    };
    assert.equal(report.status, 'not_ready');
    assert.equal(report.legs.fast, 'not_ready');
    assert.equal(report.legs.pi, 'not_ready');
    assert.ok(report.blockers.length > 0);
    // Keys are reported as set/unset only.
    const serialized = JSON.stringify(report);
    assert.match(serialized, /"apiKey":"unset"/);
    assert.equal(/sk-[A-Za-z0-9_-]{12,}/.test(serialized), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli — doctor --mode fast is not_ready without a TypeSafe key', { skip }, async () => {
  const cwd = scratch();
  try {
    const result = await cli(['doctor', '--mode', 'fast', '--json'], { cwd });
    assert.equal(result.code, 4);
    const report = JSON.parse(result.stdout) as { status: string; legs: { fast: string } };
    assert.equal(report.legs.fast, 'not_ready');
    assert.equal(report.status, 'not_ready');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli — doctor --mode fast is partial with TypeSafe but no text model', { skip }, async () => {
  const cwd = scratch();
  try {
    // Point the browser check at a file that certainly exists, so this test
    // isolates *credential* readiness from browser discovery. Machines without
    // a Chrome install would otherwise report not_ready for a different and
    // entirely correct reason.
    const result = await cli(['doctor', '--mode', 'fast', '--json'], {
      cwd,
      env: {
        TYPESAFE_API_KEY: 'unit-test-placeholder-value',
        BUJB_CHROME_EXECUTABLE: process.execPath,
      },
    });
    const report = JSON.parse(result.stdout) as { status: string; legs: { fast: string }; blockers: string[] };
    assert.equal(report.legs.fast, 'partial');
    assert.equal(result.code, 0, 'partial is usable, so the exit code is 0');
    assert.ok(report.blockers.some((blocker) => /TYPE_TEXT/.test(blocker)));
    assert.equal(JSON.stringify(report).includes('unit-test-placeholder-value'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli — doctor loads .env from the working directory', { skip }, async () => {
  const cwd = scratch();
  try {
    writeFileSync(join(cwd, '.env'), 'TYPESAFE_API_KEY=from-dotenv-not-printed\n');
    const result = await cli(['doctor', '--mode', 'fast', '--json'], { cwd });
    const report = JSON.parse(result.stdout) as {
      legs: { fast: string };
      checks: { name: string; detail: string }[];
    };
    assert.equal(report.legs.fast, 'partial', '.env supplied the TypeSafe key');
    const dotenv = report.checks.find((check) => check.name === 'dotenv');
    assert.ok(dotenv);
    assert.match(dotenv!.detail, /applied 1 name\(s\) \[TYPESAFE_API_KEY\]/);
    assert.equal(JSON.stringify(report).includes('from-dotenv-not-printed'), false, 'the value is never printed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli — a real environment variable beats .env', { skip }, async () => {
  const cwd = scratch();
  try {
    writeFileSync(join(cwd, '.env'), 'TYPESAFE_API_KEY=from-dotenv\n');
    const result = await cli(['doctor', '--mode', 'fast', '--json'], {
      cwd,
      env: { TYPESAFE_API_KEY: 'from-shell' },
    });
    const report = JSON.parse(result.stdout) as { checks: { name: string; detail: string }[] };
    const dotenv = report.checks.find((check) => check.name === 'dotenv');
    assert.match(dotenv!.detail, /applied 0 name\(s\)/);
    assert.match(dotenv!.detail, /1 already set in the environment/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli — verify passes offline and exits 0', { skip }, async () => {
  const result = await cli(['verify']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /checks passed/);
});

test('cli — a fabricated completed-but-unverified audit log fails verify', { skip }, async () => {
  const cwd = scratch();
  try {
    const path = join(cwd, 'fake.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'run_start', goal: 'x' })}\n${JSON.stringify({ type: 'run_end', status: 'completed', verified: false })}\n`,
    );
    const result = await cli(['verify', '--audit', path]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /completed was claimed without a verified result/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli — usage errors exit 2 and never start a run', { skip }, async () => {
  for (const args of [
    ['run'],
    ['run', '--url', 'https://x.test/', '--goal', 'g', '--max-setps', '3'],
    ['run', '--url', 'https://x.test/', '--goal', 'g', '--max-steps', '0'],
    ['run', '--url', 'https://x.test/', '--goal', 'g', '--max-steps'],
    ['run', '--url', 'not-a-url', '--goal', 'g'],
    ['run', '--url', 'https://x.test/', '--goal', 'g', '--mode', 'turbo'],
    ['run', '--url', 'https://a.test/', '--url', 'https://b.test/', '--goal', 'g'],
    ['doctor', '--mode', 'turbo'],
    ['nonsense'],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2, `expected usage error for: ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  }
});

test('cli — --review without a terminal is refused rather than silently downgraded', { skip }, async () => {
  const result = await cli(['run', '--url', 'https://x.test/', '--goal', 'g', '--review']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /interactive terminal/);
});

test('cli — help exits 0 and documents the terminal fallback', { skip }, async () => {
  const result = await cli(['help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /terminal/);
  assert.match(result.stdout, /Exit codes/);
});
