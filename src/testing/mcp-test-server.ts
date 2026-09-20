#!/usr/bin/env node
/**
 * A real MCP server over a real stdio transport, with only the paid model
 * transports replaced by scripts.
 *
 * This exists so the MCP tests can drive the genuine article: the real SDK
 * transport, the real session manager and approval channel, the real router,
 * the real Browser Use Pi agent loop and a real Chromium. The script comes
 * from `BUJB_TEST_PLAN`, so one binary covers every scenario.
 *
 * Never installed anywhere or referenced by the CLI; it is a test fixture that
 * happens to live in `dist` so it can be spawned as a child process.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridgeMcpServer } from '../mcp/server.js';
import { LabelDrivenTypeSafeClient, ScriptedTextModelClient, scriptedPiStreamFn } from './harness.js';
import type { LabelStep, ScriptedPiTurn } from './harness.js';

interface TestPlan {
  typeSafe?: LabelStep[];
  text?: string[];
  pi?: ScriptedPiTurn[];
}

function stderr(message: string): void {
  process.stderr.write(`[test-mcp] ${message}\n`);
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const plan: TestPlan = JSON.parse(process.env['BUJB_TEST_PLAN'] ?? '{}');

const bridge = createBridgeMcpServer({
  maxSessions: positive('BUJB_MCP_MAX_SESSIONS', 1),
  approvalTimeoutMs: positive('BUJB_MCP_APPROVAL_TIMEOUT_MS', 300_000),
  completedTtlMs: positive('BUJB_MCP_SESSION_TTL_MS', 900_000),
  log: stderr,
  testTransport: {
    typeSafe: new LabelDrivenTypeSafeClient(plan.typeSafe ?? []),
    textModel: new ScriptedTextModelClient(plan.text ?? []),
    ...(plan.pi ? { piStreamFn: scriptedPiStreamFn(plan.pi) } : {}),
  },
});

let closing = false;
const shutdown = async (why: string): Promise<void> => {
  if (closing) return;
  closing = true;
  stderr(`shutting down: ${why}`);
  await bridge.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.stdin.on('close', () => void shutdown('stdin closed'));

const transport = new StdioServerTransport();
transport.onclose = () => void shutdown('transport closed');
await bridge.server.connect(transport);
stderr('ready');
