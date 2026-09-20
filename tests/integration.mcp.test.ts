/**
 * MCP integration.
 *
 * Everything here is the real thing except the two paid model endpoints and
 * Pi's provider request: a real MCP stdio transport, the real SDK client, the
 * real session manager and approval channel, the real router and safety
 * layers, the real Browser Use Pi agent loop, and a real headless Chromium on
 * local file:// fixtures.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findChromeExecutable, fixtureUrl, launchTestChrome, type TestChrome } from '../src/testing/harness.js';

const TEST_SERVER = resolve(process.cwd(), 'dist/testing/mcp-test-server.js');
const MAIN_SERVER = resolve(process.cwd(), 'dist/mcp/main.js');
const built = existsSync(TEST_SERVER) && existsSync(MAIN_SERVER);
const chromeFound = Boolean(findChromeExecutable());
const skip = !built
  ? 'dist is not built — run `npm run build` first'
  : !chromeFound
    ? 'no Chrome/Chromium found (set BUJB_TEST_CHROME)'
    : false;

const SECRET = 'super-secret-token-value-do-not-leak';

let chrome: TestChrome | undefined;
let workspace: string | undefined;

before(async () => {
  if (skip) return;
  workspace = mkdtempSync(join(tmpdir(), 'bujb-mcp-'));
  chrome = await launchTestChrome();
});

after(async () => {
  await chrome?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

interface Plan {
  typeSafe?: { operation?: string; targetLabel?: string; verdict?: string; confidence?: number }[];
  text?: string[];
  pi?: { toolCall?: { name: string; arguments: Record<string, unknown> }; text?: string }[];
}

interface Harness {
  client: Client;
  close(): Promise<void>;
}

async function startServer(plan: Plan, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TEST_SERVER],
    cwd: process.cwd(),
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      BUJB_TEST_PLAN: JSON.stringify(plan),
      BUJB_CDP_URL: chrome!.cdpUrl,
      BUJB_BROWSER: 'chrome',
      BUJB_WORKSPACE: workspace!,
      BUJB_TELEMETRY: '0',
      BUJB_RECORD: '0',
      DO_NOT_TRACK: '1',
      // Present so the tests can prove it never appears in any MCP result.
      BUJB_SECRET_DEMO: SECRET,
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bujb-test', version: '1' });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close().catch(() => {});
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  let result: { isError?: boolean; content: { type: string; text: string }[] };
  try {
    result = (await client.callTool({ name, arguments: args })) as typeof result;
  } catch (error) {
    // The SDK rejects some schema violations at the protocol level, before the
    // handler runs. That is still a refusal, so surface it the same way.
    return { isError: true, text: String(error), json: {} as Record<string, unknown> };
  }
  const text = result.content.map((entry) => entry.text).join('');
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { isError: Boolean(result.isError), text, json };
}

async function poll(
  client: Client,
  sessionId: string,
  predicate: (status: Record<string, unknown>) => boolean,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const status = await call(client, 'browser_fast_status', { sessionId });
    last = status.json;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for state; last = ${JSON.stringify(last).slice(0, 800)}`);
}

const FORM_PLAN: Plan = {
  typeSafe: [
    { operation: 'TYPE_TEXT', targetLabel: 'Search query' },
    { operation: 'CLICK', targetLabel: 'Search' },
    { operation: 'DONE' },
    { verdict: 'SATISFIED' },
  ],
  text: ['blue widgets'],
};

// ---------------------------------------------------------------------------

test('mcp — initialize and listTools expose every tool with an input schema', { skip }, async () => {
  const harness = await startServer({});
  try {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'browser_fast_approve',
      'browser_fast_cancel',
      'browser_fast_doctor',
      'browser_fast_list_sessions',
      'browser_fast_start',
      'browser_fast_status',
      'browser_fast_verify',
    ]);
    for (const tool of listed.tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} must publish an object schema`);
    }
    const start = listed.tools.find((tool) => tool.name === 'browser_fast_start');
    const properties = Object.keys((start!.inputSchema as { properties?: object }).properties ?? {});
    for (const expected of ['url', 'goal', 'mode', 'review', 'maxSteps', 'timeoutMs', 'maxCostUsd']) {
      assert.ok(properties.includes(expected), `start schema is missing ${expected}`);
    }
    // No credential may ever be an input.
    for (const forbidden of ['apiKey', 'token', 'cookie', 'authorization', 'headers']) {
      assert.equal(properties.includes(forbidden), false, `start must not accept ${forbidden}`);
    }
  } finally {
    await harness.close();
  }
});

test('mcp — bad inputs are refused before anything starts', { skip }, async () => {
  const harness = await startServer({});
  try {
    const cases: [string, Record<string, unknown>][] = [
      ['relative url', { url: 'not-a-url', goal: 'g' }],
      ['unsupported scheme', { url: 'ftp://example.com', goal: 'g' }],
      ['unknown field', { url: 'https://example.com', goal: 'g', maxSetps: 3 }],
      ['zero budget', { url: 'https://example.com', goal: 'g', maxSteps: 0 }],
      ['negative timeout', { url: 'https://example.com', goal: 'g', timeoutMs: -1 }],
      ['api key smuggled in', { url: 'https://example.com', goal: 'g', apiKey: 'sk-nope' }],
      ['missing goal', { url: 'https://example.com' }],
    ];
    for (const [label, args] of cases) {
      const result = await call(harness.client, 'browser_fast_start', args);
      assert.equal(result.isError, true, `${label} should be refused`);
    }
    const sessions = await call(harness.client, 'browser_fast_list_sessions');
    assert.equal((sessions.json['sessions'] as unknown[]).length, 0, 'no session was created');
  } finally {
    await harness.close();
  }
});

test('mcp — start, poll, complete', { skip }, async () => {
  const harness = await startServer(FORM_PLAN);
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('form.html'),
      goal: 'search for blue widgets',
      maxSteps: 8,
      timeoutMs: 60_000,
    });
    assert.equal(started.isError, false, started.text);
    const sessionId = started.json['sessionId'] as string;
    assert.ok(sessionId.startsWith('bfh_'));
    assert.ok(['created', 'running'].includes(started.json['state'] as string));

    const final = await poll(harness.client, sessionId, (status) =>
      ['completed', 'unverified', 'blocked', 'failed', 'timeout'].includes(status['state'] as string),
    );
    assert.equal(final['state'], 'completed', JSON.stringify(final['notes']));
    const outcome = final['outcome'] as { verification: { verified: boolean }; jevSteps: number };
    assert.equal(outcome.verification.verified, true);
    assert.equal(outcome.jevSteps, 2);
    assert.ok((final['auditPath'] as string).endsWith('.jsonl'));
    assert.equal((final['steps'] as unknown[]).length, 2);
    assert.equal(final['pendingApproval'], null);

    // No secret anywhere in the payload.
    assert.equal(JSON.stringify(final).includes(SECRET), false);

    const verified = await call(harness.client, 'browser_fast_verify', { sessionId });
    assert.equal(verified.json['verificationMode'], 'recorded_run_result');
    assert.equal(verified.json['freshObservation'], false, 'a recorded result is never sold as a fresh check');
    assert.equal(verified.json['verified'], true);
  } finally {
    await harness.close();
  }
});

test('mcp — review mode routes every action through the approval channel', { skip }, async () => {
  const harness = await startServer(FORM_PLAN);
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('form.html'),
      goal: 'search for blue widgets',
      review: true,
      maxSteps: 8,
      timeoutMs: 60_000,
    });
    const sessionId = started.json['sessionId'] as string;

    let approvals = 0;
    for (;;) {
      const status = await poll(
        harness.client,
        sessionId,
        (value) =>
          value['state'] === 'awaiting_approval' ||
          ['completed', 'unverified', 'blocked', 'failed'].includes(value['state'] as string),
      );
      if (status['state'] !== 'awaiting_approval') {
        assert.equal(status['state'], 'completed', JSON.stringify(status['notes']));
        break;
      }
      const pending = status['pendingApproval'] as { approvalId: string; actionLabel: string; risk: string };
      assert.ok(pending.approvalId.startsWith('apr_'));
      assert.ok(pending.actionLabel.length > 0);
      const approved = await call(harness.client, 'browser_fast_approve', {
        sessionId,
        approvalId: pending.approvalId,
        approved: true,
      });
      assert.equal(approved.isError, false, approved.text);
      approvals++;
      assert.ok(approvals < 10, 'unexpected number of approvals');
    }
    assert.ok(approvals >= 2, `every action should be reviewed, saw ${approvals}`);
  } finally {
    await harness.close();
  }
});

test('mcp — a high-risk action pauses without review, and declining stops the run', { skip }, async () => {
  const harness = await startServer({
    typeSafe: [{ operation: 'CLICK', targetLabel: 'Ping' }, { operation: 'CLICK', targetLabel: 'Place order' }],
  });
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('order.html'),
      goal: 'press ping and then the order button',
      maxSteps: 6,
      timeoutMs: 60_000,
    });
    const sessionId = started.json['sessionId'] as string;

    const waiting = await poll(harness.client, sessionId, (value) => value['state'] === 'awaiting_approval');
    const pending = waiting['pendingApproval'] as { approvalId: string; actionLabel: string; risk: string };
    assert.equal(pending.risk, 'high');
    assert.match(pending.actionLabel, /Place order/);

    // A wrong id and a foreign id are both refused.
    const wrong = await call(harness.client, 'browser_fast_approve', {
      sessionId,
      approvalId: 'apr_wrong',
      approved: true,
    });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /does not match/);

    const declined = await call(harness.client, 'browser_fast_approve', {
      sessionId,
      approvalId: pending.approvalId,
      approved: false,
      reason: 'not authorised in a test',
    });
    assert.equal(declined.isError, false, declined.text);

    // Replaying the same approvalId is refused.
    const replay = await call(harness.client, 'browser_fast_approve', {
      sessionId,
      approvalId: pending.approvalId,
      approved: true,
    });
    assert.equal(replay.isError, true, 'an approvalId is single-use');

    const final = await poll(harness.client, sessionId, (value) =>
      ['blocked', 'completed', 'unverified', 'failed'].includes(value['state'] as string),
    );
    assert.equal(final['state'], 'blocked');
    assert.equal(final['outcomeStatus'], 'stopped_by_approval');

    // The earlier step DID run: the run must not claim the page is untouched.
    const history = (final['outcome'] as { history: { label: string; source: string }[] }).history;
    const jev = history.filter((entry) => entry.source === 'jev');
    assert.equal(jev.length, 1, 'only the approved first action is recorded');
    assert.equal(jev[0]!.label, 'Ping');
    assert.equal(
      history.some((entry) => /Place order/.test(entry.label)),
      false,
      'the declined action has no execution record',
    );
  } finally {
    await harness.close();
  }
});

test('mcp — an unanswered approval times out as a denial', { skip }, async () => {
  const harness = await startServer(
    { typeSafe: [{ operation: 'CLICK', targetLabel: 'Place order' }] },
    { BUJB_MCP_APPROVAL_TIMEOUT_MS: '1200' },
  );
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('order.html'),
      goal: 'press the order button',
      maxSteps: 4,
      timeoutMs: 60_000,
    });
    const sessionId = started.json['sessionId'] as string;
    await poll(harness.client, sessionId, (value) => value['state'] === 'awaiting_approval');
    const final = await poll(
      harness.client,
      sessionId,
      (value) => ['blocked', 'failed', 'completed', 'unverified'].includes(value['state'] as string),
      20_000,
    );
    assert.equal(final['state'], 'blocked');
    assert.equal(final['outcomeStatus'], 'stopped_by_approval');
    assert.match(JSON.stringify(final['outcome']), /denied by default|not approved/i);
  } finally {
    await harness.close();
  }
});

test('mcp — cancel is idempotent and releases the session', { skip }, async () => {
  const harness = await startServer({ typeSafe: [{ operation: 'CLICK', targetLabel: 'Place order' }] });
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('order.html'),
      goal: 'press the order button',
      maxSteps: 4,
      timeoutMs: 60_000,
    });
    const sessionId = started.json['sessionId'] as string;
    await poll(harness.client, sessionId, (value) => value['state'] === 'awaiting_approval');

    const first = await call(harness.client, 'browser_fast_cancel', { sessionId });
    assert.equal(first.isError, false);
    const second = await call(harness.client, 'browser_fast_cancel', { sessionId });
    assert.equal(second.isError, false, 'cancel is idempotent');

    const final = await poll(
      harness.client,
      sessionId,
      (value) => !['created', 'running', 'awaiting_approval'].includes(value['state'] as string),
      20_000,
    );
    assert.ok(['cancelled', 'blocked', 'failed'].includes(final['state'] as string), String(final['state']));
    assert.equal(final['pendingApproval'], null, 'the pending approval is released');

    // A new session can start once the previous one is finished.
    const next = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('order.html'),
      goal: 'a second task',
      maxSteps: 2,
      timeoutMs: 20_000,
    });
    assert.equal(next.isError, false, next.text);
  } finally {
    await harness.close();
  }
});

test('mcp — only one browser task may run at a time', { skip }, async () => {
  const harness = await startServer({ typeSafe: [{ operation: 'CLICK', targetLabel: 'Place order' }] });
  try {
    const first = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('order.html'),
      goal: 'press the order button',
      maxSteps: 4,
      timeoutMs: 60_000,
    });
    assert.equal(first.isError, false);
    const second = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('form.html'),
      goal: 'a competing task',
      maxSteps: 4,
      timeoutMs: 60_000,
    });
    assert.equal(second.isError, true, 'a second concurrent task is refused');
    assert.match(second.text, /at most 1 browser task/i);
    await call(harness.client, 'browser_fast_cancel', { sessionId: first.json['sessionId'] as string });
  } finally {
    await harness.close();
  }
});

test('mcp — a finished session expires after its TTL', { skip }, async () => {
  const harness = await startServer(
    { typeSafe: [{ operation: 'DONE' }, { verdict: 'NOT_SATISFIED' }] },
    { BUJB_MCP_SESSION_TTL_MS: '1000' },
  );
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('form.html'),
      goal: 'look at the page',
      maxSteps: 2,
      timeoutMs: 30_000,
    });
    const sessionId = started.json['sessionId'] as string;
    const done = await poll(harness.client, sessionId, (value) =>
      ['unverified', 'completed', 'blocked', 'failed'].includes(value['state'] as string),
    );
    assert.equal(done['state'], 'unverified');
    assert.ok(done['expiresAt'], 'a finished session advertises its expiry');

    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The sweep runs on a timer; a read after expiry must not resurrect it.
    const after = await call(harness.client, 'browser_fast_status', { sessionId });
    if (!after.isError) {
      assert.ok(
        ['expired', 'unverified'].includes(after.json['state'] as string),
        `unexpected post-TTL state ${String(after.json['state'])}`,
      );
    }
  } finally {
    await harness.close();
  }
});

test('mcp — an uncertain action is visible in status, history and the audit log', { skip }, async () => {
  const harness = await startServer({
    typeSafe: [{ operation: 'SELECT', targetLabel: 'Sort order → Leave immediately' }, { verdict: 'NOT_SATISFIED' }],
  });
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('volatile.html'),
      goal: 'change the sort order',
      mode: 'fast',
      maxSteps: 3,
      timeoutMs: 45_000,
    });
    const sessionId = started.json['sessionId'] as string;
    const final = await poll(harness.client, sessionId, (value) =>
      ['completed', 'unverified', 'blocked', 'failed', 'timeout'].includes(value['state'] as string),
    );

    const steps = final['steps'] as { label: string; effectUncertain: boolean; executionPhase: string }[];
    assert.ok(steps.length >= 1, 'the action is recorded');
    const select = steps.find((step) => /Leave immediately/.test(step.label));
    assert.ok(select, `the SELECT is in the step summary: ${JSON.stringify(steps)}`);
    assert.equal(select!.effectUncertain, true, 'a navigating SELECT is never filed as "no effect"');
    assert.ok(['dispatched', 'observed', 'effect_uncertain'].includes(select!.executionPhase));

    const uncertain = final['uncertainActions'] as unknown[];
    assert.ok(uncertain.length >= 1, 'status surfaces uncertain actions separately');

    const auditCheck = await call(harness.client, 'browser_fast_verify', {
      auditPath: final['auditPath'] as string,
    });
    assert.equal(auditCheck.json['verificationMode'], 'audit_only');
    assert.equal(auditCheck.json['freshObservation'], false);
    assert.ok((auditCheck.json['uncertainActions'] as number) >= 1, 'the audit log shows it too');
    assert.equal(auditCheck.json['secretShapedStrings'], false);
  } finally {
    await harness.close();
  }
});

test('mcp — a real Pi fallback leg runs, is gated, and is terminal', { skip }, async () => {
  const harness = await startServer({
    typeSafe: [{ operation: 'BLOCKED' }, { verdict: 'NOT_SATISFIED' }],
    pi: [
      { toolCall: { name: 'javascript', arguments: { code: 'console.log(await page.info())' } } },
      { toolCall: { name: 'finish', arguments: { result: 'looked at the page' } } },
    ],
  });
  try {
    const started = await call(harness.client, 'browser_fast_start', {
      url: fixtureUrl('order.html'),
      goal: 'read what this page says',
      review: true,
      maxSteps: 6,
      timeoutMs: 60_000,
    });
    const sessionId = started.json['sessionId'] as string;

    let piApprovals = 0;
    for (;;) {
      const status = await poll(
        harness.client,
        sessionId,
        (value) =>
          value['state'] === 'awaiting_approval' ||
          ['completed', 'unverified', 'blocked', 'failed', 'timeout'].includes(value['state'] as string),
      );
      if (status['state'] !== 'awaiting_approval') {
        assert.ok(
          ['unverified', 'completed', 'blocked'].includes(status['state'] as string),
          String(status['state']),
        );
        const outcome = status['outcome'] as { piFallbacks: number; notes: string[]; jevSteps: number };
        assert.equal(outcome.piFallbacks, 1, 'exactly one Pi leg');
        assert.ok(
          outcome.notes.some((note) => /terminal/i.test(note)),
          'the outcome states the fallback was terminal',
        );
        break;
      }
      const pending = status['pendingApproval'] as { approvalId: string; source: string; operation: string };
      if (pending.source === 'pi') piApprovals++;
      const approved = await call(harness.client, 'browser_fast_approve', {
        sessionId,
        approvalId: pending.approvalId,
        approved: true,
      });
      assert.equal(approved.isError, false, approved.text);
    }
    assert.ok(piApprovals >= 2, `every Pi tool call is reviewed over MCP, saw ${piApprovals}`);
  } finally {
    await harness.close();
  }
});

test('mcp — a disconnecting client leaves nothing running', { skip }, async () => {
  const harness = await startServer({ typeSafe: [{ operation: 'CLICK', targetLabel: 'Place order' }] });
  const started = await call(harness.client, 'browser_fast_start', {
    url: fixtureUrl('order.html'),
    goal: 'press the order button',
    maxSteps: 4,
    timeoutMs: 60_000,
  });
  await poll(harness.client, started.json['sessionId'] as string, (value) => value['state'] === 'awaiting_approval');

  // Closing the client closes stdio, which the server treats as a disconnect.
  await harness.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // A fresh server can immediately take the browser again, which it could not
  // do if the previous task were still holding a Pi session open.
  const next = await startServer(FORM_PLAN);
  try {
    const again = await call(next.client, 'browser_fast_start', {
      url: fixtureUrl('form.html'),
      goal: 'search for blue widgets',
      maxSteps: 8,
      timeoutMs: 60_000,
    });
    assert.equal(again.isError, false, again.text);
    const final = await poll(next.client, again.json['sessionId'] as string, (value) =>
      ['completed', 'unverified', 'blocked', 'failed'].includes(value['state'] as string),
    );
    assert.equal(final['state'], 'completed', JSON.stringify(final['notes']));
  } finally {
    await next.close();
  }
});

test('mcp — the production entry point writes only JSON-RPC to stdout', { skip }, async () => {
  const child = spawn(process.execPath, [MAIN_SERVER], {
    cwd: process.cwd(),
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      BUJB_WORKSPACE: workspace!,
      BUJB_SECRET_DEMO: SECRET,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_fast_doctor', arguments: {} } });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(lines.length >= 3, `expected JSON-RPC responses, got: ${stdout.slice(0, 400)}`);
  for (const line of lines) {
    let parsed: { jsonrpc?: string };
    try {
      parsed = JSON.parse(line) as { jsonrpc?: string };
    } catch {
      throw new Error(`stdout carried a non-JSON line: ${line.slice(0, 200)}`);
    }
    assert.equal(parsed.jsonrpc, '2.0', `stdout carried a non-JSON-RPC object: ${line.slice(0, 200)}`);
  }
  assert.equal(stdout.includes(SECRET), false, 'no secret on stdout');
  assert.equal(stderr.includes(SECRET), false, 'no secret on stderr');
  // Diagnostics exist — they are simply on the right stream.
  assert.match(stderr, /browser-fast-hybrid/);
});
