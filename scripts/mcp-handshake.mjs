#!/usr/bin/env node
/**
 * Acceptance check for the shipped MCP entry point.
 *
 * Spawns the real `dist/mcp/main.js` over a real stdio transport with the
 * official SDK client, performs initialize + tools/list, calls the one tool
 * that needs no browser (`browser_fast_doctor`), and proves that stdout
 * carried nothing but MCP JSON-RPC.
 *
 * No browser is launched and no paid endpoint is contacted.
 * Exit 0 on success, 1 on failure.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = resolve(process.cwd(), 'dist/mcp/main.js');
const EXPECTED = [
  'browser_fast_approve',
  'browser_fast_cancel',
  'browser_fast_doctor',
  'browser_fast_list_sessions',
  'browser_fast_start',
  'browser_fast_status',
  'browser_fast_verify',
];

if (!existsSync(SERVER)) {
  process.stdout.write(`FAIL  ${SERVER} is missing — run \`npm run build\` first\n`);
  process.exit(1);
}

/** Drive the server over raw pipes and return every line it wrote to stdout. */
function rawStdoutFrames() {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DO_NOT_TRACK: '1' },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.resume();
    child.on('error', fail);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } },
    });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    }, 400);
    setTimeout(() => {
      child.kill('SIGTERM');
      done(out.split('\n').filter((line) => line.trim().length > 0));
    }, 2500);
  });
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DO_NOT_TRACK: '1' },
  stderr: 'pipe',
});

const client = new Client({ name: 'bujb-acceptance', version: '1' });
let failures = 0;
const log = (line) => process.stdout.write(`${line}\n`);

try {
  await client.connect(transport);
  transport.stderr?.resume();

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, EXPECTED);
  log(`PASS  initialize + tools/list: ${names.join(', ')}`);

  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must publish an object input schema`);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
  }
  log('PASS  every tool publishes a description and an object input schema');

  const doctor = await client.callTool({ name: 'browser_fast_doctor', arguments: {} });
  const report = JSON.parse(doctor.content.map((entry) => entry.text).join(''));
  assert.ok(['ready', 'partial', 'not_ready'].includes(report.status), `unexpected status ${report.status}`);
  log(`PASS  browser_fast_doctor over MCP: status=${report.status} fast=${report.legs.fast} pi=${report.legs.pi}`);

  const rejected = await client
    .callTool({ name: 'browser_fast_start', arguments: { url: 'not-a-url', goal: 'x' } })
    .then((result) => Boolean(result.isError))
    .catch(() => true);
  assert.equal(rejected, true, 'an invalid URL must be refused');
  log('PASS  an invalid start request is refused');

  // Stdout purity, checked against raw pipes rather than through the SDK:
  // a stray console.log anywhere in the server (or in Pi) fails here.
  const frames = await rawStdoutFrames();
  assert.ok(frames.length >= 2, `expected initialize and tools/list frames, saw ${frames.length}`);
  for (const line of frames) JSON.parse(line); // throws on anything but JSON-RPC
  log(`PASS  stdout carried only JSON-RPC (${frames.length} frames, raw pipe)`);
} catch (error) {
  failures++;
  log(`FAIL  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await client.close().catch(() => {});
}

log(`\nmcp handshake: ${failures === 0 ? 'ok' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
