#!/usr/bin/env node
/**
 * `bu-fast-mcp` — the stdio MCP entry point.
 *
 * **stdout carries JSON-RPC and nothing else.** Every diagnostic goes to
 * stderr. Pi's own logging is disabled at session creation for the same
 * reason. If you add output here, write it to stderr.
 *
 * Shutdown is deliberate: SIGINT, SIGTERM and a closed stdin all cancel every
 * session, release Chrome and let the process exit. A disconnecting client
 * never leaves a browser task running.
 */

import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { applyDotEnv } from '../config.js';
import { recordDotEnv } from '../doctor.js';
import { createBridgeMcpServer } from './server.js';

function stderr(message: string): void {
  process.stderr.write(`[browser-fast-hybrid] ${message}\n`);
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function main(): Promise<void> {
  // The MCP entry point loads .env exactly once, like the CLI does, and the
  // real environment still wins.
  recordDotEnv(applyDotEnv());

  const bridge = createBridgeMcpServer({
    maxSessions: positiveEnv('BUJB_MCP_MAX_SESSIONS', 1),
    approvalTimeoutMs: positiveEnv('BUJB_MCP_APPROVAL_TIMEOUT_MS', 300_000),
    completedTtlMs: positiveEnv('BUJB_MCP_SESSION_TTL_MS', 900_000),
    log: stderr,
  });

  let shuttingDown = false;
  const shutdown = async (why: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stderr(`shutting down: ${why}`);
    try {
      await bridge.close();
    } catch (error) {
      stderr(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // A client that goes away closes our stdin; that is the disconnect signal.
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.stdin.on('end', () => void shutdown('stdin ended'));
  process.on('uncaughtException', (error) => {
    stderr(`uncaught: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    void shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', (reason) => {
    stderr(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown('transport closed');
  await bridge.server.connect(transport);
  stderr('ready on stdio');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    stderr(`failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
}
