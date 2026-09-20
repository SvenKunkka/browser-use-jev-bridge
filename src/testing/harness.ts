/**
 * Offline test harness.
 *
 * Shipped in the package (not only in tests/) so the same code backs
 * `npm test` and `npm run smoke`, and so a reviewer can reproduce either from
 * a single entry point.
 *
 * Everything here is designed to keep the default test run free of network
 * access and model spend:
 *   - `createOfflinePiSession` builds a *real* Pi session but injects a
 *     `streamFn` that throws, so Pi's agent loop can never contact a provider.
 *     The browser, the V8 cell and the CDP path are all genuine.
 *   - `ScriptedTypeSafeClient` and `ScriptedTextModelClient` replace the two
 *     paid endpoints with deterministic scripts.
 *   - fixtures are local files loaded over file://.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BridgeConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { TypeSafeClient, TypeSafeRequest } from '../jev/policy.js';
import type { FieldContext, TextModelClient, TextModelResult } from '../jev/text-helper.js';
import type { TypeSafeResponse } from '../types.js';
import { PiSession } from '../pi/session.js';
import { DomainPolicy } from '../safety/domains.js';
import { Redactor } from '../safety/redaction.js';

/** Walk up from this module until the package's fixtures/ directory is found. */
function findFixtureDir(): string {
  let directory = resolve(fileURLToPath(new URL('.', import.meta.url)));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(directory, 'fixtures');
    if (existsSync(join(candidate, 'form.html'))) return candidate;
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Could not locate the fixtures directory.');
}

export const FIXTURE_DIR = findFixtureDir();

export function fixtureUrl(name: string): string {
  return pathToFileURL(join(FIXTURE_DIR, name)).toString();
}

const CHROME_CANDIDATES = [
  process.env['BUJB_TEST_CHROME'],
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((candidate): candidate is string => Boolean(candidate));

export function findChromeExecutable(): string | undefined {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export interface TestChrome {
  cdpUrl: string;
  close(): Promise<void>;
}

/**
 * A throwaway headless browser for fixture tests. The test owns this process;
 * Pi attaches to it over CDP and owns every tab and every page operation from
 * that point on, exactly as it would with the operator's own Chrome.
 */
export async function launchTestChrome(): Promise<TestChrome> {
  const executable = findChromeExecutable();
  if (!executable) throw new Error('No Chrome/Chromium found. Set BUJB_TEST_CHROME.');
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'bujb-chrome-'));
  const child: ChildProcess = spawn(
    executable,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cdpUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('Chrome did not expose CDP within 20 s.');
    }
    try {
      const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 200));
  }

  return {
    cdpUrl,
    async close() {
      child.kill('SIGTERM');
      await new Promise((done) => setTimeout(done, 300));
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export interface OfflineSession {
  session: PiSession;
  config: BridgeConfig;
  redactor: Redactor;
  domainPolicy: DomainPolicy;
  close(): Promise<void>;
}

/**
 * Real Pi session, real Chrome, no model provider reachable.
 *
 * Pass `streamFn` to drive Pi's agent loop deterministically, and
 * `beforeToolCall` to attach the approval hook exactly as production does.
 * With no `streamFn`, any attempt by Pi to reach a provider throws.
 */
export async function createOfflinePiSession(options: {
  cdpUrl: string;
  workspace: string;
  allowedDomains?: string[];
  prohibitedDomains?: string[];
  beforeToolCall?: PiBeforeToolCall;
  streamFn?: unknown;
}): Promise<OfflineSession> {
  const config = loadConfig(
    {
      mode: 'hybrid',
      workspace: options.workspace,
      cdpUrl: options.cdpUrl,
      browserKind: 'chrome',
      ...(options.allowedDomains ? { allowedDomains: options.allowedDomains } : {}),
      ...(options.prohibitedDomains ? { prohibitedDomains: options.prohibitedDomains } : {}),
    },
    { ...process.env, BUJB_TELEMETRY: '0', BUJB_RECORD: '0', DO_NOT_TRACK: '1' },
  );
  const redactor = new Redactor();
  const domainPolicy = new DomainPolicy({
    allowedDomains: config.allowedDomains,
    prohibitedDomains: config.prohibitedDomains,
  });
  // Any attempt by Pi's agent loop to reach a model provider fails loudly
  // instead of silently spending money.
  const streamFn = async function* offline(): AsyncGenerator<never> {
    throw new Error('Offline test harness: no model provider is available.');
  };
  const session = await PiSession.create({
    config,
    redactor,
    domainPolicy,
    ...(options.beforeToolCall ? { beforeToolCall: options.beforeToolCall } : {}),
    streamFn: (options.streamFn ?? streamFn) as never,
  });
  return {
    session,
    config,
    redactor,
    domainPolicy,
    async close() {
      await session.close();
    },
  };
}

export type ScriptedAnswer = Record<string, { choice: string; confidence?: number }>;

/**
 * Deterministic TypeSafe stand-in. Each entry answers one request; probability
 * mass is generated so the answer passes the real validator unchanged.
 */
export class ScriptedTypeSafeClient implements TypeSafeClient {
  readonly description = 'scripted TypeSafe (offline)';
  readonly requests: TypeSafeRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptedAnswer[]) {}

  async ask(body: TypeSafeRequest): Promise<TypeSafeResponse> {
    this.requests.push(body);
    const step = this.script[this.index++];
    if (!step) throw new Error('Scripted TypeSafe client ran out of answers.');
    const answers: TypeSafeResponse['answers'] = {};
    for (const [question, definition] of Object.entries(body.questions)) {
      const criteria = Object.keys(((definition as { criteria: Record<string, unknown> }).criteria) ?? {});
      const scripted = step[question];
      if (!scripted) continue;
      const probabilities: Record<string, number> = {};
      const others = criteria.filter((id) => id !== scripted.choice);
      const remainder = others.length ? 0.2 / others.length : 0;
      for (const id of criteria) probabilities[id] = id === scripted.choice ? (others.length ? 0.8 : 1) : remainder;
      answers[question] = {
        choice: scripted.choice,
        confidence: scripted.confidence ?? 0.9,
        probabilities,
      };
    }
    return { answers, model: 'scripted', usage: {} };
  }
}

/** Raw stand-in used to test that malformed provider output is rejected. */
export class RawTypeSafeClient implements TypeSafeClient {
  readonly description = 'raw TypeSafe (offline)';
  constructor(private readonly response: TypeSafeResponse) {}
  async ask(): Promise<TypeSafeResponse> {
    return this.response;
  }
}

export class ScriptedTextModelClient implements TextModelClient {
  readonly description = 'scripted text model (offline)';
  readonly model = 'scripted';
  readonly contexts: FieldContext[] = [];
  constructor(private readonly values: string[]) {}
  async complete(context: FieldContext): Promise<TextModelResult> {
    this.contexts.push(context);
    const text = this.values.shift();
    if (text === undefined) throw new Error('Scripted text model ran out of values.');
    return { text, model: this.model, latencyMs: 1 };
  }
}

export interface LabelStep {  // exported for the MCP test server's plan
  operation?: string;
  targetLabel?: string;
  verdict?: string;
  /** Override the answer's confidence, for testing the verifier's thresholds. */
  confidence?: number;
}

function distribute(ids: string[], choice: string): Record<string, number> {
  const others = ids.filter((id) => id !== choice);
  const remainder = others.length ? 0.2 / others.length : 0;
  return Object.fromEntries(ids.map((id) => [id, id === choice ? (others.length ? 0.8 : 1) : remainder]));
}

export class LabelDrivenTypeSafeClient implements TypeSafeClient {
  readonly description = 'label-driven TypeSafe (offline)';
  readonly requests: TypeSafeRequest[] = [];
  private index = 0;

  constructor(private readonly script: LabelStep[]) {}

  async ask(body: TypeSafeRequest): Promise<TypeSafeResponse> {
    this.requests.push(body);
    const step = this.script[this.index++];
    if (!step) throw new Error('Label-driven client ran out of script steps.');
    const answers: TypeSafeResponse['answers'] = {};

    if (step.verdict && body.questions['verdict']) {
      const ids = Object.keys((body.questions['verdict'] as { criteria: Record<string, unknown> }).criteria);
      answers['verdict'] = {
        choice: step.verdict,
        confidence: step.confidence ?? 0.95,
        probabilities: distribute(ids, step.verdict),
      };
      return { answers, model: 'label-driven' };
    }

    if (step.operation) {
      const ids = Object.keys((body.questions['operation'] as { criteria: Record<string, unknown> }).criteria);
      if (!ids.includes(step.operation)) {
        throw new Error(`Operation "${step.operation}" was not offered. Offered: ${ids.join(', ')}`);
      }
      answers['operation'] = {
        choice: step.operation,
        confidence: 0.95,
        probabilities: distribute(ids, step.operation),
      };
      const questionName = `${step.operation.toLowerCase()}_target`;
      const question = body.questions[questionName] as
        | { criteria: Record<string, { element: string }> }
        | undefined;
      if (question && step.targetLabel) {
        const entry = Object.entries(question.criteria).find(
          ([index, value]) => value.element === `[${index}] ${step.targetLabel}`,
        );
        if (!entry) {
          throw new Error(
            `No target labelled "${step.targetLabel}". Offered: ${Object.values(question.criteria)
              .map((value) => value.element)
              .join(' | ')}`,
          );
        }
        const ids2 = Object.keys(question.criteria);
        answers[questionName] = {
          choice: entry[0],
          confidence: 0.95,
          probabilities: distribute(ids2, entry[0]),
        };
      }
    }
    return { answers, model: 'label-driven' };
  }
}

// ---------------------------------------------------------------------------
// Pi approval-hook test support
// ---------------------------------------------------------------------------

import type { PiBeforeToolCall, PiBeforeToolCallContext } from '../pi/fallback.js';

/**
 * A `BeforeToolCallContext` shaped exactly like the one Pi 0.1.0 passes.
 *
 * The field names here are not guesses: `PiBeforeToolCallContext` is derived
 * from `BrowserUse.create`'s own parameter type, so if upstream renames
 * `args` or `toolCall`, this stops compiling. The *runtime* proof that Pi
 * really passes this shape is in tests/integration.pi-fallback.test.ts, where
 * Pi itself invokes the hook.
 */
export function makePiToolCallContext(name: string, args: unknown, id = 'call_1'): PiBeforeToolCallContext {
  const assistantMessage = {
    role: 'assistant' as const,
    content: [{ type: 'toolCall' as const, id, name, arguments: (args ?? {}) as Record<string, unknown> }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse' as const,
    timestamp: Date.now(),
  };
  return {
    assistantMessage,
    toolCall: assistantMessage.content[0],
    args,
    context: { messages: [], tools: [], systemPrompt: '' },
  } as unknown as PiBeforeToolCallContext;
}

// ---------------------------------------------------------------------------
// A deterministic stand-in for Pi's model transport
// ---------------------------------------------------------------------------

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export interface ScriptedPiTurn {
  /** Emit a tool call; Pi will execute it (subject to beforeToolCall). */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** Emit plain text and end the turn. */
  text?: string;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A `streamFn` that replays a fixed script of assistant turns.
 *
 * This is what makes a genuine Pi fallback testable offline: Pi's agent loop,
 * tool registry, `beforeToolCall` plumbing, V8 cell and CDP path are all the
 * real thing; only the provider request is replaced. No network, no spend.
 */
export function scriptedPiStreamFn(turns: ScriptedPiTurn[]): unknown {
  let index = 0;
  const calls: ScriptedPiTurn[] = [];
  const streamFn = (model: { api: string; provider: string; id: string }) => {
    const stream = createAssistantMessageEventStream();
    const turn = turns[index++] ?? { text: 'No further scripted turns.' };
    calls.push(turn);
    const base = {
      role: 'assistant' as const,
      content: [] as unknown[],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: 'pending' as const,
      timestamp: Date.now(),
    };

    if (turn.toolCall) {
      const toolCall = {
        type: 'toolCall' as const,
        id: `scripted_call_${index}`,
        name: turn.toolCall.name,
        arguments: turn.toolCall.arguments,
      };
      const partial = { ...base, content: [toolCall] };
      stream.push({ type: 'start', partial } as never);
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial } as never);
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial } as never);
      stream.push({
        type: 'done',
        reason: 'toolUse',
        message: { ...partial, stopReason: 'toolUse' },
      } as never);
    } else {
      const text = turn.text ?? '';
      const partial = { ...base, content: [{ type: 'text' as const, text }] };
      stream.push({ type: 'start', partial } as never);
      stream.push({ type: 'text_start', contentIndex: 0, partial } as never);
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial } as never);
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial } as never);
      stream.push({ type: 'done', reason: 'stop', message: { ...partial, stopReason: 'stop' } } as never);
    }
    stream.end();
    return stream;
  };
  (streamFn as { scriptedCalls?: ScriptedPiTurn[] }).scriptedCalls = calls;
  return streamFn;
}
