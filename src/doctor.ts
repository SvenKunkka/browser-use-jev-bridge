/**
 * Readiness reporting, shared by the CLI and the MCP server.
 *
 * One implementation, so `bu-fast doctor` and `browser_fast_doctor` can never
 * disagree about whether the tool can run.
 *
 * Three answers, not two:
 *   - `ready`      every leg the mode needs has credentials and a browser
 *   - `partial`    it will start, but something is degraded
 *   - `not_ready`  the mode cannot run; `blockers` says why
 *
 * A credential is only ever reported as "set" or "unset". Never a prefix,
 * never a length, never a fingerprint.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeConfig,
  loadConfig,
  providerCredential,
  type BridgeMode,
  type DotEnvResult,
} from './config.js';

export type Readiness = 'ready' | 'partial' | 'not_ready';

export interface DoctorCheck {
  name: string;
  passed: boolean;
  detail: string;
  required: boolean;
}

export interface DoctorReport {
  status: Readiness;
  mode: BridgeMode;
  platform: string;
  node: string;
  legs: { fast: Readiness; pi: Readiness };
  blockers: string[];
  checks: DoctorCheck[];
  config: Record<string, unknown>;
}

/** The worst of a set of readiness values. */
export function worstReadiness(values: Readiness[]): Readiness {
  if (values.includes('not_ready')) return 'not_ready';
  if (values.includes('partial')) return 'partial';
  return 'ready';
}

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

/**
 * Whichever entry point loaded `.env` records the result here, so `doctor` can
 * report where a variable came from — by name only.
 */
let dotenvResult: DotEnvResult | undefined;
export function recordDotEnv(result: DotEnvResult | undefined): void {
  dotenvResult = result;
}

/** Locate the installed Pi manifest from THIS file, not the working directory. */
function findPiVersion(): { ok: boolean; version: string } {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const manifestPath = join(directory, 'node_modules', '@browser_use', 'pi', 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
        return { ok: true, version: manifest.version ?? 'unknown' };
      } catch {
        return { ok: false, version: 'unreadable' };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { ok: false, version: 'not installed' };
}

function findSdkVersion(): { ok: boolean; version: string } {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const manifestPath = join(directory, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
        return { ok: true, version: manifest.version ?? 'unknown' };
      } catch {
        return { ok: false, version: 'unreadable' };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { ok: false, version: 'not installed' };
}

export async function doctorReport(mode: BridgeMode = 'hybrid'): Promise<DoctorReport> {
  const config = loadConfig({ mode });
  const checks: DoctorCheck[] = [];
  const readiness: Readiness[] = [];
  const blockers: string[] = [];

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 19);
  checks.push({
    name: 'node version',
    passed: nodeOk,
    detail: `${process.version} (@browser_use/pi requires >= 22.19)`,
    required: true,
  });
  if (!nodeOk) {
    readiness.push('not_ready');
    blockers.push(`Node ${process.version} is older than the required 22.19.`);
  }

  const pi = findPiVersion();
  checks.push({ name: 'pi package', passed: pi.ok, detail: `@browser_use/pi ${pi.version}`, required: true });
  if (!pi.ok) {
    readiness.push('not_ready');
    blockers.push('@browser_use/pi is not installed; run npm ci in the project directory.');
  }

  const sdk = findSdkVersion();
  checks.push({
    name: 'mcp sdk',
    passed: sdk.ok,
    detail: `@modelcontextprotocol/sdk ${sdk.version}`,
    required: true,
  });
  if (!sdk.ok) {
    readiness.push('not_ready');
    blockers.push('@modelcontextprotocol/sdk is not installed; run npm ci in the project directory.');
  }

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
    let reachable = false;
    try {
      const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        const info = (await response.json()) as Record<string, string>;
        detail = `${info['Browser'] ?? 'unknown build'} at ${cdpUrl}`;
        reachable = true;
      } else detail = `HTTP ${response.status} from ${cdpUrl}`;
    } catch (error) {
      detail = `${cdpUrl}: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({
      name: 'chrome remote debugging',
      passed: reachable,
      detail,
      required: config.browser.kind === 'chrome',
    });
    if (!reachable && config.browser.kind === 'chrome') {
      readiness.push('not_ready');
      blockers.push(`BUJB_CDP_URL is set to ${cdpUrl} but nothing answered there.`);
    }
  } else {
    checks.push({
      name: 'chrome remote debugging',
      passed: true,
      // Nothing was contacted, so do not imply a successful probe.
      detail: 'not configured (no BUJB_CDP_URL); Pi would launch or attach at run time — NOT verified here',
      required: false,
    });
    readiness.push('partial');
  }

  const typeSafeKey = Boolean(config.typesafe.apiKey);
  const textKey = Boolean(config.textModel.apiKey);
  const piCredential = providerCredential(config.pi.model);
  const piKey = piCredential.present.length > 0;
  const cloudKey = Boolean(config.browser.cloudApiKey);

  const fastReady: Readiness = !typeSafeKey ? 'not_ready' : textKey ? 'ready' : 'partial';
  const piReady: Readiness = !piKey
    ? 'not_ready'
    : config.browser.kind === 'cloud' && !cloudKey
      ? 'not_ready'
      : 'ready';

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
      `model ${config.pi.model} → provider "${piCredential.provider}"` +
      `${piCredential.known ? '' : ' (unknown provider; the env var name is a guess)'}; ` +
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
  } else if (fastReady === 'not_ready' && piReady === 'not_ready') {
    readiness.push('not_ready');
    blockers.push('Neither the Jev fast path nor the Pi fallback has usable credentials.');
  } else if (fastReady !== 'ready' || piReady !== 'ready') {
    readiness.push('partial');
    if (fastReady === 'not_ready') blockers.push('The Jev fast path is unusable: TYPESAFE_API_KEY is unset.');
    if (fastReady === 'partial') blockers.push('TYPE_TEXT is unusable: TEXT_MODEL_API_KEY is unset.');
    if (piReady === 'not_ready') blockers.push(`The Pi fallback is unusable: no ${piCredential.candidates.join('/')}.`);
  } else {
    readiness.push('ready');
  }

  const envNames: [string, boolean][] = [
    ['TYPESAFE_API_KEY', typeSafeKey],
    ['TEXT_MODEL_API_KEY', textKey],
    ['BROWSER_USE_API_KEY', cloudKey],
    ...piCredential.candidates.map((candidate) => [candidate, Boolean(process.env[candidate])] as [string, boolean]),
  ];
  for (const [name, present] of envNames) {
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
    detail: dotenvResult?.found
      ? `${dotenvResult.path}: applied ${dotenvResult.applied.length} name(s) [${dotenvResult.applied.join(', ') || 'none'}], ` +
        `${dotenvResult.skipped.length} already set in the environment` +
        (dotenvResult.malformedLines.length ? `, malformed lines ${dotenvResult.malformedLines.join(', ')}` : '')
      : `${dotenvResult?.path ?? join(process.cwd(), '.env')}: not present`,
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
  if (config.unscopedSecrets.length) {
    checks.push({
      name: 'named secrets',
      passed: false,
      detail:
        `these secrets have no domain scope and will NOT be injected: ${config.unscopedSecrets.join(', ')} ` +
        '— add BUJB_SECRET_DOMAINS_<NAME>. They are still redacted from all output.',
      required: false,
    });
    readiness.push('partial');
    blockers.push(
      `Unscoped named secret(s): ${config.unscopedSecrets.join(', ')}. Set BUJB_SECRET_DOMAINS_<NAME> to use them.`,
    );
  }
  checks.push({
    name: 'verification thresholds',
    passed: true,
    detail: `minConfidence ${config.verification.minConfidence}, minProbability ${config.verification.minProbability}`,
    required: false,
  });

  return {
    status: worstReadiness(readiness.length ? readiness : ['ready']),
    mode,
    platform: `${platform()} ${release()}`,
    node: process.version,
    legs: { fast: fastReady, pi: piReady },
    blockers,
    checks,
    config: describeConfig(config),
  };
}
