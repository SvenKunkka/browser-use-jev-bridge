/**
 * Single owner of the browser.
 *
 * Everything that touches Chrome in this project goes through one
 * `BrowserUse` instance created here: the Pi fallback agent, and the Jev fast
 * path, which runs its DOM work inside Pi's own persistent V8 cell against
 * Pi's own `page` binding. There is no second CDP connection, no second Chrome
 * process, and no tab that Pi does not own.
 *
 * The Jev fast path talks to the page through `evaluateInPage` and `cdp`, both
 * of which are thin wrappers over a Pi cell. The JSON channel is the cell's
 * stdout, delimited by sentinels, because `BrowserUse.execute()` is the public
 * API and does not expose the worker's private JSON capture path.
 */

import { BrowserUse, Browser, type BrowserOptions, type RunOptions, type RunResult } from '@browser_use/pi';
import type { BridgeConfig } from '../config.js';
import { StalePageError } from '../jev/freshness.js';
import { DomainPolicy } from '../safety/domains.js';
import type { Redactor } from '../safety/redaction.js';

const BEGIN = '<<<BUJB:JSON:BEGIN>>>';
const END = '<<<BUJB:JSON:END>>>';

const CONTEXT_LOST = /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated/i;

export interface PageInfo {
  url: string;
  title: string;
}

/** The surface the Jev fast path is allowed to use. Nothing else reaches Chrome. */
export interface BrowserBackend {
  evaluateInPage<T>(expression: string, timeoutMs?: number): Promise<T>;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Several CDP calls inside one cell, so a press/release pair cannot be split. */
  cdpBatch(calls: { method: string; params?: Record<string, unknown> }[]): Promise<void>;
  info(): Promise<PageInfo>;
  goto(url: string): Promise<PageInfo>;
  tabCount(): Promise<number>;
}

export interface PiSessionOptions {
  config: BridgeConfig;
  redactor: Redactor;
  domainPolicy: DomainPolicy;
  /**
   * Pi accepts the approval hook only at session creation, so the router's
   * per-run controller is bound here. Without this the whole Pi-side approval
   * layer is inert.
   */
  beforeToolCall?: BrowserUseBeforeToolCall;
  /** Test seam: deterministic model transport so no provider is contacted. */
  streamFn?: BrowserUseOptionsStreamFn;
}

type BrowserUseOptionsStreamFn = NonNullable<Parameters<typeof BrowserUse.create>[0]['streamFn']>;
type BrowserUseBeforeToolCall = NonNullable<Parameters<typeof BrowserUse.create>[0]['beforeToolCall']>;

export function browserOptionsFor(config: BridgeConfig): BrowserOptions {
  if (config.browser.kind === 'cloud') {
    const options: Parameters<typeof Browser.cloud>[0] = { apiKey: config.browser.cloudApiKey ?? '' };
    return Browser.cloud(options);
  }
  if (config.browser.kind === 'chromium') {
    const options: Parameters<typeof Browser.chromium>[0] = { headless: config.browser.headless };
    if (config.browser.executablePath) options.executablePath = config.browser.executablePath;
    return Browser.chromium(options);
  }
  const options: Parameters<typeof Browser.chrome>[0] = {};
  if (config.browser.cdpUrl) options.cdpUrl = config.browser.cdpUrl;
  if (config.browser.profileDir) options.profileDir = config.browser.profileDir;
  if (config.browser.approveConnection) options.approveConnection = true;
  return Browser.chrome(options);
}

export class PiSession implements BrowserBackend {
  private constructor(
    readonly agent: BrowserUse,
    private readonly config: BridgeConfig,
    private readonly redactor: Redactor,
    private readonly domainPolicy: DomainPolicy,
  ) {}

  static async create(options: PiSessionOptions): Promise<PiSession> {
    const { config, redactor, domainPolicy } = options;
    // Telemetry and recording are off unless the operator turned them on.
    if (!config.telemetry) process.env['DO_NOT_TRACK'] ??= '1';

    const create: Parameters<typeof BrowserUse.create>[0] = {
      model: config.pi.model,
      browser: browserOptionsFor(config),
      workspace: config.workspace,
      telemetry: config.telemetry,
      recording: config.recording,
      maxOutputChars: 900_000,
      cellTimeoutMs: config.cellTimeoutMs,
      highlightActions: config.highlightActions,
      redact: config.redactValues,
    };
    if (config.pi.reasoning) create.reasoning = config.pi.reasoning;
    if (domainPolicy.allowed.length) create.allowedDomains = domainPolicy.allowed;
    if (domainPolicy.prohibited.length) create.prohibitedDomains = domainPolicy.prohibited;
    if (Object.keys(config.secrets).length) create.sensitiveData = config.secrets;
    if (options.beforeToolCall) create.beforeToolCall = options.beforeToolCall;
    if (options.streamFn) create.streamFn = options.streamFn;

    const agent = await BrowserUse.create(create);
    return new PiSession(agent, config, redactor, domainPolicy);
  }

  get workspace(): string {
    return this.agent.workspace;
  }

  /** Run a cell and pull one JSON value out of its stdout. */
  private async cell<T>(code: string, timeoutMs?: number): Promise<T> {
    let result: Awaited<ReturnType<BrowserUse['execute']>>;
    try {
      result = await this.agent.execute(code, { timeoutMs: timeoutMs ?? this.config.cellTimeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (CONTEXT_LOST.test(message)) throw new StalePageError('Document changed during evaluation');
      throw new Error(this.redactor.redact(message));
    }
    const text = result.text ?? '';
    const start = text.indexOf(BEGIN);
    const stop = text.indexOf(END, start + BEGIN.length);
    if (start < 0 || stop < 0) {
      throw new Error(
        this.redactor.redact(
          `Browser cell produced no JSON payload. Cell output: ${text.slice(0, 500)}`,
        ),
      );
    }
    return JSON.parse(text.slice(start + BEGIN.length, stop)) as T;
  }

  async evaluateInPage<T>(expression: string, timeoutMs?: number): Promise<T> {
    // Top-level await inside the persistent REPL cell: the worker's
    // Runtime.evaluate uses replMode, so re-declaring these bindings on every
    // cell is allowed and nothing leaks between calls.
    const code = [
      `const __bujbSource = ${JSON.stringify(expression)};`,
      'const __bujbValue = await page.evaluate(__bujbSource);',
      `console.log(${JSON.stringify(BEGIN)} + JSON.stringify(__bujbValue === undefined ? null : __bujbValue) + ${JSON.stringify(END)});`,
    ].join('\n');
    return this.cell<T>(code, timeoutMs);
  }

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const code = [
      `const __bujbValue = await page.cdp(${JSON.stringify(method)}, ${JSON.stringify(params)});`,
      `console.log(${JSON.stringify(BEGIN)} + JSON.stringify(__bujbValue === undefined ? null : __bujbValue) + ${JSON.stringify(END)});`,
    ].join('\n');
    return this.cell<unknown>(code);
  }

  /** Several CDP calls in one cell; used so a click's press/release cannot be split. */
  async cdpBatch(calls: { method: string; params?: Record<string, unknown> }[]): Promise<void> {
    const code = [
      `const __bujbCalls = ${JSON.stringify(calls)};`,
      'for (const __bujbCall of __bujbCalls) await page.cdp(__bujbCall.method, __bujbCall.params || {});',
      `console.log(${JSON.stringify(BEGIN)} + JSON.stringify(true) + ${JSON.stringify(END)});`,
    ].join('\n');
    await this.cell<boolean>(code);
  }

  async info(): Promise<PageInfo> {
    return this.evaluateInPage<PageInfo>('({url: location.href, title: document.title})');
  }

  async goto(url: string): Promise<PageInfo> {
    this.domainPolicy.assert(url);
    const code = [
      `const __bujbValue = await page.goto(${JSON.stringify(url)});`,
      `console.log(${JSON.stringify(BEGIN)} + JSON.stringify(__bujbValue) + ${JSON.stringify(END)});`,
    ].join('\n');
    return this.cell<PageInfo>(code, Math.max(this.config.cellTimeoutMs, 60_000));
  }

  async tabCount(): Promise<number> {
    const code = [
      'const __bujbTabs = await tabs.list();',
      "const __bujbValue = __bujbTabs.filter(t => t.type === 'page').length;",
      `console.log(${JSON.stringify(BEGIN)} + JSON.stringify(__bujbValue) + ${JSON.stringify(END)});`,
    ].join('\n');
    return this.cell<number>(code);
  }

  run(task: string, options?: RunOptions): Promise<RunResult<string>> {
    return this.agent.run(task, options);
  }

  followUp(task: string, options?: RunOptions): Promise<RunResult<string>> {
    return this.agent.followUp(task, options);
  }

  cancel(): void {
    this.agent.cancel();
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
