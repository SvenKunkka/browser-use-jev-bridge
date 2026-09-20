/**
 * Configuration.
 *
 * Every credential is read from the process environment and never from a CLI
 * flag, so a key cannot end up in shell history, a process listing or an audit
 * record. `describe()` returns a structure that is safe to print: secrets
 * collapse to "set" / "unset".
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Redactor } from './safety/redaction.js';

export type BridgeMode = 'fast' | 'hybrid' | 'pi';

export interface SecretBinding {
  value: string;
  domains: string[];
}

export interface BrowserConfig {
  kind: 'chrome' | 'chromium' | 'cloud';
  cdpUrl?: string;
  executablePath?: string;
  profileDir?: string;
  headless: boolean;
  approveConnection: boolean;
  cloudApiKey?: string;
}

export interface BridgeConfig {
  mode: BridgeMode;
  review: boolean;
  json: boolean;
  workspace: string;
  pi: { model: string; reasoning?: 'low' | 'medium' | 'high' | 'xhigh' };
  typesafe: { baseUrl: string; apiKey?: string; model: string };
  textModel: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    reasoning: 'none' | 'low' | 'provider-default';
  };
  browser: BrowserConfig;
  allowedDomains: string[];
  prohibitedDomains: string[];
  maxSteps: number;
  timeoutMs: number;
  maxCostUsd: number;
  cellTimeoutMs: number;
  telemetry: boolean;
  recording: boolean;
  highlightActions: boolean;
  verification: {
    /** Minimum confidence the verifier's answer must carry. */
    minConfidence: number;
    /** Minimum probability mass the verifier must put on SATISFIED. */
    minProbability: number;
  };
  /** Literal values Pi must mask in its own history, events and logs. */
  redactValues: string[];
  secrets: Record<string, SecretBinding>;
  thresholds: {
    /** Consecutive stale/fingerprint failures before handing to Pi. */
    maxConsecutiveStale: number;
    /** Consecutive non-WAIT actions with no page change before handing to Pi. */
    maxNoProgress: number;
    /** Hard cap on Jev fast-path actions. */
    jevMaxSteps: number;
  };
}

export interface ConfigOverrides {
  mode?: BridgeMode;
  review?: boolean;
  json?: boolean;
  workspace?: string;
  allowedDomains?: string[];
  prohibitedDomains?: string[];
  maxSteps?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
  record?: boolean;
  cdpUrl?: string;
  browserKind?: 'chrome' | 'chromium' | 'cloud';
  headless?: boolean;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function text(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

/** BUJB_SECRET_<NAME> plus optional BUJB_SECRET_DOMAINS_<NAME>. */
export function collectSecrets(env: NodeJS.ProcessEnv): Record<string, SecretBinding> {
  const secrets: Record<string, SecretBinding> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('BUJB_SECRET_') || key.startsWith('BUJB_SECRET_DOMAINS_')) continue;
    if (!value || !value.trim()) continue;
    const name = key.slice('BUJB_SECRET_'.length);
    const domains = (env[`BUJB_SECRET_DOMAINS_${name}`] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    secrets[name.toLowerCase()] = { value, domains };
  }
  return secrets;
}

export function loadConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const secrets = collectSecrets(env);
  const browserKind = (overrides.browserKind ??
    (text(env, 'BUJB_BROWSER', 'chrome') as BrowserConfig['kind']));

  const browser: BrowserConfig = {
    kind: browserKind,
    headless: overrides.headless ?? flag(env, 'BUJB_HEADLESS', false),
    approveConnection: flag(env, 'BUJB_APPROVE_CHROME_CONNECTION', false),
  };
  const cdpUrl = overrides.cdpUrl ?? optional(env, 'BUJB_CDP_URL');
  if (cdpUrl) browser.cdpUrl = cdpUrl;
  const executablePath = optional(env, 'BUJB_CHROME_EXECUTABLE');
  if (executablePath) browser.executablePath = executablePath;
  const profileDir = optional(env, 'BUJB_CHROME_PROFILE_DIR');
  if (profileDir) browser.profileDir = profileDir;
  const cloudApiKey = optional(env, 'BROWSER_USE_API_KEY');
  if (cloudApiKey) browser.cloudApiKey = cloudApiKey;

  const reasoning = optional(env, 'BUJB_PI_REASONING');

  return {
    mode: overrides.mode ?? 'hybrid',
    review: overrides.review ?? false,
    json: overrides.json ?? false,
    workspace: resolve(overrides.workspace ?? text(env, 'BUJB_WORKSPACE', join(process.cwd(), '.work'))),
    pi: {
      model: text(env, 'BUJB_PI_MODEL', 'openrouter/openai/gpt-5.6-luna'),
      ...(reasoning ? { reasoning: reasoning as 'low' | 'medium' | 'high' | 'xhigh' } : {}),
    },
    typesafe: {
      baseUrl: text(env, 'TYPESAFE_BASE_URL', 'https://api.typesafe.ai/v1/systemone'),
      ...(optional(env, 'TYPESAFE_API_KEY') ? { apiKey: optional(env, 'TYPESAFE_API_KEY') } : {}),
      model: text(env, 'TYPESAFE_MODEL', 'jev-latest'),
    },
    textModel: {
      baseUrl: text(env, 'TEXT_MODEL_BASE_URL', 'https://api.deepseek.com/v1'),
      ...(optional(env, 'TEXT_MODEL_API_KEY') ? { apiKey: optional(env, 'TEXT_MODEL_API_KEY') } : {}),
      model: text(env, 'TEXT_MODEL', 'deepseek-chat'),
      reasoning: (text(env, 'TEXT_MODEL_REASONING', 'provider-default') as
        | 'none'
        | 'low'
        | 'provider-default'),
    },
    browser,
    allowedDomains: overrides.allowedDomains ?? splitList(env['BUJB_ALLOWED_DOMAINS']),
    prohibitedDomains: overrides.prohibitedDomains ?? splitList(env['BUJB_PROHIBITED_DOMAINS']),
    maxSteps: overrides.maxSteps ?? number(env, 'BUJB_MAX_STEPS', 40),
    timeoutMs: overrides.timeoutMs ?? number(env, 'BUJB_TIMEOUT_MS', 300_000),
    maxCostUsd: overrides.maxCostUsd ?? number(env, 'BUJB_MAX_COST_USD', 1),
    cellTimeoutMs: number(env, 'BUJB_CELL_TIMEOUT_MS', 30_000),
    verification: {
      minConfidence: ratio(env, 'BUJB_VERIFY_MIN_CONFIDENCE', 0.8),
      minProbability: ratio(env, 'BUJB_VERIFY_MIN_PROBABILITY', 0.8),
    },
    telemetry: flag(env, 'BUJB_TELEMETRY', false),
    recording: overrides.record ?? flag(env, 'BUJB_RECORD', false),
    highlightActions: flag(env, 'BUJB_HIGHLIGHT', false),
    redactValues: Object.values(secrets).map((secret) => secret.value),
    secrets,
    thresholds: {
      maxConsecutiveStale: number(env, 'BUJB_MAX_STALE', 2),
      maxNoProgress: number(env, 'BUJB_MAX_NO_PROGRESS', 3),
      jevMaxSteps: number(env, 'BUJB_JEV_MAX_STEPS', 60),
    },
  };
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A threshold in [0, 1]. An out-of-range or unparsable value falls back. */
function ratio(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Register everything credential-bearing with the redactor. */
export function registerSecrets(config: BridgeConfig, redactor: Redactor, env = process.env): void {
  redactor.registerEnvironment(env);
  for (const [name, secret] of Object.entries(config.secrets)) {
    redactor.register(`SECRET_${name.toUpperCase()}`, secret.value);
  }
  redactor.register('TYPESAFE_API_KEY', config.typesafe.apiKey);
  redactor.register('TEXT_MODEL_API_KEY', config.textModel.apiKey);
  redactor.register('BROWSER_USE_API_KEY', config.browser.cloudApiKey);
}

/** Safe to print, log and ship in `doctor --json`. Contains no secret value. */
export function describeConfig(config: BridgeConfig): Record<string, unknown> {
  const state = (value: unknown) => (value ? 'set' : 'unset');
  return {
    mode: config.mode,
    review: config.review,
    workspace: config.workspace,
    pi: { model: config.pi.model, reasoning: config.pi.reasoning ?? null },
    typesafe: { baseUrl: config.typesafe.baseUrl, model: config.typesafe.model, apiKey: state(config.typesafe.apiKey) },
    textModel: {
      baseUrl: config.textModel.baseUrl,
      model: config.textModel.model,
      reasoning: config.textModel.reasoning,
      apiKey: state(config.textModel.apiKey),
    },
    browser: {
      kind: config.browser.kind,
      cdpUrl: config.browser.cdpUrl ?? null,
      executablePath: config.browser.executablePath ?? null,
      profileDir: config.browser.profileDir ? 'set' : 'unset',
      headless: config.browser.headless,
      cloudApiKey: state(config.browser.cloudApiKey),
    },
    budgets: { maxSteps: config.maxSteps, timeoutMs: config.timeoutMs, maxCostUsd: config.maxCostUsd },
    domains: { allowed: config.allowedDomains, prohibited: config.prohibitedDomains },
    privacy: {
      telemetry: config.telemetry ? 'enabled (explicitly opted in)' : 'disabled (default)',
      recording: config.recording ? 'enabled (explicitly opted in)' : 'disabled (default)',
      highlightActions: config.highlightActions,
      namedSecrets: Object.keys(config.secrets).map((name) => ({ name, value: 'set' })),
    },
    thresholds: config.thresholds,
    verification: config.verification,
    environment: {
      OPENROUTER_API_KEY: state(process.env['OPENROUTER_API_KEY']),
      BROWSER_USE_API_KEY: state(process.env['BROWSER_USE_API_KEY']),
      TYPESAFE_API_KEY: state(config.typesafe.apiKey),
      TEXT_MODEL_API_KEY: state(config.textModel.apiKey),
      DO_NOT_TRACK: state(process.env['DO_NOT_TRACK']),
      HOME: homedir() ? 'set' : 'unset',
    },
  };
}

// ---------------------------------------------------------------------------
// .env support
// ---------------------------------------------------------------------------

export interface DotEnvResult {
  /** Absolute path that was looked at. */
  path: string;
  /** False when the file does not exist. */
  found: boolean;
  /** Names (never values) of variables taken from the file. */
  applied: string[];
  /** Names already present in the process environment, which always win. */
  skipped: string[];
  /** 1-based line numbers that could not be parsed. */
  malformedLines: number[];
}

/**
 * Minimal, dependency-free `.env` reader.
 *
 * Deliberately *not* Node's `process.loadEnvFile`: this one guarantees the
 * precedence the project documents — a variable already present in the
 * process environment is never overwritten — and it reports which names it
 * set so `doctor` can show provenance without ever touching a value.
 *
 * Supported: `KEY=value`, `export KEY=value`, single- or double-quoted values
 * (with `\n` escapes inside double quotes), `#` comments, blank lines.
 * Not supported, on purpose: variable interpolation and command substitution.
 */
export function parseDotEnv(text: string): { entries: Map<string, string>; malformedLines: number[] } {
  const entries = new Map<string, string>();
  const malformedLines: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = (lines[index] ?? '').trim();
    if (!raw || raw.startsWith('#')) continue;
    const withoutExport = raw.startsWith('export ') ? raw.slice('export '.length).trim() : raw;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) {
      malformedLines.push(index + 1);
      continue;
    }
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      malformedLines.push(index + 1);
      continue;
    }
    let value = withoutExport.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    entries.set(key, value);
  }
  return { entries, malformedLines };
}

/**
 * Load `<dir>/.env` into `env`, without overwriting anything already set.
 * Returns names only — never a value, and never anything that could be logged
 * back out as a credential.
 */
export function applyDotEnv(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): DotEnvResult {
  const path = resolve(dir, '.env');
  const result: DotEnvResult = { path, found: false, applied: [], skipped: [], malformedLines: [] };
  if (!existsSync(path)) return result;
  result.found = true;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return result;
  }
  const { entries, malformedLines } = parseDotEnv(text);
  result.malformedLines = malformedLines;
  for (const [key, value] of entries) {
    if (env[key] !== undefined) {
      result.skipped.push(key);
      continue;
    }
    env[key] = value;
    result.applied.push(key);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------

/**
 * Which environment variables can supply a key for a Pi model id.
 *
 * Pi model ids are `provider/model…` (e.g. `openrouter/openai/gpt-5.6-luna`).
 * `@earendil-works/pi-ai` has an authoritative `findEnvKeys()`, but it is not
 * reachable through that package's `exports` map, and this project does not
 * import private module paths. So this is a local table. It can drift from
 * upstream; when a provider is unknown, the conventional
 * `<PROVIDER>_API_KEY` is assumed and `doctor` says the check is a guess.
 */
const PROVIDER_ENV: Record<string, string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  zai: ['ZAI_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
};

export interface ProviderCredential {
  provider: string;
  candidates: string[];
  present: string[];
  known: boolean;
}

export function providerCredential(modelId: string, env: NodeJS.ProcessEnv = process.env): ProviderCredential {
  const provider = (modelId.split('/')[0] ?? '').trim().toLowerCase();
  const known = Object.hasOwn(PROVIDER_ENV, provider);
  const candidates = known
    ? (PROVIDER_ENV[provider] as string[])
    : [`${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`];
  const present = candidates.filter((name) => Boolean(env[name] && env[name]!.trim()));
  return { provider, candidates, present, known };
}
