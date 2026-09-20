# Shared helpers for the local install scripts. Sourced, never executed.
# shellcheck shell=bash

set -uo pipefail

MARKER_BEGIN='# >>> browser-fast-hybrid (managed by browser-use-jev-bridge) >>>'
MARKER_END='# <<< browser-fast-hybrid <<<'
SERVER_NAME='browser-fast-hybrid'
SKILL_MARKER='.installed-by-browser-fast-hybrid'

# SOURCE_ROOT is where these files actually are, as seen by this shell.
# REPO_ROOT is the path Codex will use at runtime. They are the same unless
# the script is run through a different mount of the same tree (a container or
# VM with the project bind-mounted), in which case pass --repo-root with the
# path the machine running Codex sees. BFH_REPO_ROOT is the environment form.
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="${BFH_REPO_ROOT:-$SOURCE_ROOT}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_HOME/config.toml"
SKILL_DIR="$CODEX_HOME/skills/$SERVER_NAME"

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# The exact TOML block we manage, between markers so removal is exact.
render_block() {
  cat <<TOML
$MARKER_BEGIN
# Installed by $REPO_ROOT/scripts/install-local.sh
# Remove with scripts/uninstall-local.sh, or delete everything between the markers.
[mcp_servers.$SERVER_NAME]
command = "/bin/sh"
cwd = "$REPO_ROOT"
startup_timeout_sec = 120
args = ["-lc", """
# browser-fast-hybrid launcher: resolve node from a login shell, then exec.
ROOT='$REPO_ROOT'
ENTRY="\$ROOT/dist/mcp/main.js"
if [ ! -f "\$ENTRY" ]; then
  echo "browser-fast-hybrid: \$ENTRY is missing. Run: cd \$ROOT && npm ci && npm run build" >&2
  exit 127
fi
if command -v node >/dev/null 2>&1; then exec node "\$ENTRY"; fi
for d in "\$HOME/.nvm/versions/node"/*/bin "\$HOME/.fnm/node-versions"/*/installation/bin "\$HOME/.volta/bin" /opt/homebrew/bin /usr/local/bin; do
  [ -x "\$d/node" ] && exec "\$d/node" "\$ENTRY"
done
echo "browser-fast-hybrid: no node on PATH; Node 22.19+ is required" >&2
exit 127"""]
$MARKER_END
TOML
}

backup_config() {
  local stamp backup
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="$CODEX_CONFIG.bak.$stamp"
  cp "$CODEX_CONFIG" "$backup" || die "could not back up $CODEX_CONFIG"
  say "  backed up $CODEX_CONFIG -> $backup"
}

has_managed_block() {
  grep -qF "$MARKER_BEGIN" "$CODEX_CONFIG" 2>/dev/null
}

has_unmanaged_entry() {
  # A hand-written [mcp_servers.browser-fast-hybrid] outside our markers.
  if ! grep -qE "^\[mcp_servers\.$SERVER_NAME\]" "$CODEX_CONFIG" 2>/dev/null; then return 1; fi
  has_managed_block && return 1
  return 0
}

remove_managed_block() {
  local tmp
  tmp="$(mktemp)"
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    index($0, b) { skip = 1; next }
    index($0, e) { skip = 0; next }
    !skip        { print }
  ' "$CODEX_CONFIG" > "$tmp" || { rm -f "$tmp"; die 'could not rewrite the config'; }
  mv "$tmp" "$CODEX_CONFIG"
}

# --repo-root <path>: the path Codex will see. Used when this script runs
# through a different mount of the same tree than Codex does.
set_repo_root() {
  case "${1:-}" in
    /*) ;;
    *) die "--repo-root needs an absolute path, got: ${1:-<empty>}" ;;
  esac
  REPO_ROOT="${1%/}"
}
