#!/usr/bin/env bash
#
# Check the local installation: the Codex entry, the skill, the build, the
# tool's own readiness, and a real MCP handshake. Read-only.
#
#   ./scripts/doctor-local.sh
#   ./scripts/doctor-local.sh --repo-root /abs/path   the path Codex will use,
#                                                     when this shell sees the
#                                                     tree at a different mount
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root) shift; set_repo_root "${1:-}" ;;
    --repo-root=*) set_repo_root "${1#*=}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

fails=0
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s\n' "$label"
    fails=$((fails + 1))
  fi
}

say 'browser-fast-hybrid local doctor'
info "repository : $REPO_ROOT"
[ "$REPO_ROOT" = "$SOURCE_ROOT" ] || info "files read from : $SOURCE_ROOT (--repo-root given)"
info "codex home : $CODEX_HOME"
say ''

check 'codex config.toml exists'                 test -f "$CODEX_CONFIG"
check 'MCP server registered (managed block)'    grep -qF "$MARKER_BEGIN" "$CODEX_CONFIG"
check 'skill installed'                          test -f "$SKILL_DIR/SKILL.md"
check 'skill carries our install marker'         test -f "$SKILL_DIR/$SKILL_MARKER"
check 'bundled browser plugin still configured'  grep -qF 'plugins."browser@openai-bundled"' "$CODEX_CONFIG"
check 'registered cwd matches this repository'   grep -qF "cwd = \"$REPO_ROOT\"" "$CODEX_CONFIG"
check 'dist/mcp/main.js built'                   test -f "$SOURCE_ROOT/dist/mcp/main.js"
check 'dist/cli.js built'                        test -f "$SOURCE_ROOT/dist/cli.js"
check 'node_modules installed'                   test -d "$SOURCE_ROOT/node_modules/@modelcontextprotocol/sdk"
say ''

if command -v node >/dev/null 2>&1 && [ -f "$SOURCE_ROOT/dist/cli.js" ]; then
  say 'tool readiness (node dist/cli.js doctor --mode hybrid):'
  ( cd "$SOURCE_ROOT" && node dist/cli.js doctor --mode hybrid 2>&1 | tail -n 12 | sed 's/^/  /' )
  say ''
  say 'MCP handshake (tools/list over a real stdio transport):'
  ( cd "$SOURCE_ROOT" && node -e '
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["dist/mcp/main.js"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "doctor", version: "1" } } });
    setTimeout(() => { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); }, 500);
    setTimeout(() => {
      child.kill("SIGTERM");
      const tools = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((m) => m && m.id === 2).flatMap((m) => (m.result && m.result.tools) || []).map((t) => t.name);
      if (tools.length) { console.log("  tools: " + tools.join(", ")); }
      else { console.log("  FAILED: no tools/list response"); process.exitCode = 1; }
    }, 2500);
  ' ) || fails=$((fails + 1))
else
  warn 'node or dist/cli.js missing; skipped the runtime checks'
  fails=$((fails + 1))
fi

say ''
if [ "$fails" -eq 0 ]; then
  say 'local doctor: ok'
  say '(Codex loads config.toml and skills at startup — restart it after an install.)'
  exit 0
fi
say "local doctor: $fails check(s) failed"
exit 1
