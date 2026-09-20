#!/usr/bin/env bash
# Reproduce the acceptance evidence on THIS machine and write it to
# docs/acceptance-local.txt.
#
#   ./scripts/acceptance.sh
#
# The MCP session/approval/cancel evidence is produced by `npm run smoke`,
# whose [mcp] section drives a real stdio transport with the official SDK
# client; `scripts/mcp-handshake.mjs` covers the shipped `bu-fast-mcp` entry
# point itself.
#
# Run it on macOS to produce the native-macOS record (Node v26.x, arm64) that
# a cloud session cannot produce for you. It installs nothing globally, never
# pushes, and touches only ./node_modules, ./dist, ./.build-test and the output
# file. Some steps are expected to exit non-zero on a machine with no
# credentials — the script records the code and keeps going.
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
out="docs/acceptance-local.txt"
: > "$out"

section() { printf '\n===== %s =====\n' "$1" | tee -a "$out"; }
capture() {
  section "$1"; shift
  printf '$ %s\n' "$*" | tee -a "$out"
  "$@" >>"$out" 2>&1
  local code=$?
  printf 'exit=%s\n' "$code" | tee -a "$out"
  return 0
}

section "environment"
{
  printf '$ node --version\n'; node --version
  printf '$ npm --version\n';  npm --version
  printf '$ uname -sm\n';      uname -sm
  printf '$ sw_vers\n';        (sw_vers 2>/dev/null || echo 'not macOS')
} | tee -a "$out"

capture "npm ci"                      npm ci --no-audit --no-fund
capture "npm run check"               npm run check
capture "npm test"                    npm test
capture "npm run build"               npm run build
capture "npm run smoke"               npm run smoke
capture "bu-fast verify"              node dist/cli.js verify
capture "bu-fast doctor --mode fast"  node dist/cli.js doctor --mode fast --json
capture "bu-fast doctor --mode hybrid" node dist/cli.js doctor --mode hybrid --json
capture "bu-fast doctor --mode pi"    node dist/cli.js doctor --mode pi --json
capture "mcp startup + initialize/listTools" node scripts/mcp-handshake.mjs
capture "npm audit --omit=dev"        npm audit --omit=dev
capture "npm pack --dry-run"          npm pack --dry-run --json
capture "install-local --dry-run"     ./scripts/install-local.sh --dry-run --skip-deps
capture "doctor-local"                ./scripts/doctor-local.sh
capture "git status --short"          git status --short
capture "git log --oneline -n 3"      git log --oneline -n 3

printf '\nWritten to %s\n' "$out"
