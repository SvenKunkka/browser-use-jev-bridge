#!/usr/bin/env bash
#
# Register browser-fast-hybrid with Codex on THIS machine.
#
#   ./scripts/install-local.sh --dry-run     show every change, write nothing
#   ./scripts/install-local.sh               install
#   ./scripts/install-local.sh --skip-deps   install without running npm ci/build
#   ./scripts/install-local.sh --repo-root /abs/path
#                                            record that path in config.toml
#                                            instead of this script's location
#                                            (for a bind-mounted checkout)
#
# What it does, and nothing else:
#   1. (unless --skip-deps) npm ci && npm run build in this repository
#   2. appends one [mcp_servers.browser-fast-hybrid] block to ~/.codex/config.toml,
#      between marker comments, after backing the file up
#   3. installs skill/SKILL.md to ~/.codex/skills/browser-fast-hybrid/
#
# It never removes or edits any other server, plugin or skill — in particular
# it does not touch the bundled `browser` plugin. It writes no credentials. It
# is idempotent: running it twice changes nothing the second time.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

DRY_RUN=0
SKIP_DEPS=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-deps) SKIP_DEPS=1 ;;
    --repo-root) shift; set_repo_root "${1:-}" ;;
    --repo-root=*) set_repo_root "${1#*=}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

say "browser-fast-hybrid installer"
info "repository : $REPO_ROOT"
[ "$REPO_ROOT" = "$SOURCE_ROOT" ] || info "files read from : $SOURCE_ROOT (--repo-root given)"
info "codex home : $CODEX_HOME"
info "mode       : $([ "$DRY_RUN" = 1 ] && echo 'dry run (no writes)' || echo 'install')"
say ''

[ -d "$CODEX_HOME" ] || die "$CODEX_HOME does not exist. Is Codex installed for this user?"
[ -f "$CODEX_CONFIG" ] || die "$CODEX_CONFIG does not exist; refusing to create one from scratch."
[ -f "$SOURCE_ROOT/skill/SKILL.md" ] || die "skill/SKILL.md is missing from the repository."

# --- 1. dependencies and build ----------------------------------------------
say '1) dependencies and build'
if [ "$SKIP_DEPS" = 1 ]; then
  info 'skipped (--skip-deps)'
  if [ ! -f "$SOURCE_ROOT/dist/mcp/main.js" ]; then
    warn "dist/mcp/main.js is missing; run 'npm ci && npm run build' before Codex can start the server"
  fi
elif [ "$DRY_RUN" = 1 ]; then
  info "would run: npm ci --no-audit --no-fund && npm run build   (in $SOURCE_ROOT)"
else
  ( cd "$SOURCE_ROOT" && npm ci --no-audit --no-fund && npm run build ) \
    || die 'npm ci / npm run build failed'
  info 'dependencies installed and dist built'
fi
say ''

# --- 2. the MCP server entry -------------------------------------------------
say '2) ~/.codex/config.toml'
if has_unmanaged_entry; then
  die "config.toml already has an [mcp_servers.$SERVER_NAME] entry that this installer did not write. Remove it by hand first; nothing was changed."
fi
if has_managed_block; then
  info 'the managed block is already present — leaving it untouched (idempotent)'
elif [ "$DRY_RUN" = 1 ]; then
  info "would back up $CODEX_CONFIG and append:"
  render_block | sed 's/^/    | /'
else
  backup_config
  { printf '\n'; render_block; } >> "$CODEX_CONFIG" || die 'could not append to config.toml'
  info "appended [mcp_servers.$SERVER_NAME]"
fi
info 'other servers and plugins were not read, modified or removed'
say ''

# --- 3. the skill ------------------------------------------------------------
say '3) ~/.codex/skills/browser-fast-hybrid'
if [ -d "$SKILL_DIR" ] && [ ! -f "$SKILL_DIR/$SKILL_MARKER" ]; then
  die "$SKILL_DIR exists but was not created by this installer; refusing to overwrite it."
fi
if [ "$DRY_RUN" = 1 ]; then
  info "would write $SKILL_DIR/SKILL.md and $SKILL_DIR/$SKILL_MARKER"
else
  mkdir -p "$SKILL_DIR" || die "could not create $SKILL_DIR"
  cp "$SOURCE_ROOT/skill/SKILL.md" "$SKILL_DIR/SKILL.md" || die 'could not copy SKILL.md'
  {
    printf 'installed-by: browser-use-jev-bridge\n'
    printf 'repository: %s\n' "$REPO_ROOT"
    printf 'installed-at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$SKILL_DIR/$SKILL_MARKER"
  info "installed $SKILL_DIR/SKILL.md"
fi
say ''

if [ "$DRY_RUN" = 1 ]; then
  say 'dry run complete — nothing was written.'
  exit 0
fi

say 'Installed.'
say ''
say 'Codex reads config.toml and the skills directory at startup, so RESTART Codex'
say 'to load the new MCP server and skill. Then verify with:'
say '  ./scripts/doctor-local.sh'
