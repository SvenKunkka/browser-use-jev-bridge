#!/usr/bin/env bash
#
# Remove exactly what install-local.sh created, and nothing else.
#
#   ./scripts/uninstall-local.sh --dry-run
#   ./scripts/uninstall-local.sh
#
# It removes the marker-delimited [mcp_servers.browser-fast-hybrid] block from
# ~/.codex/config.toml (after a backup) and the skill directory — but only if
# that directory carries this installer's marker file. It never recursively
# deletes a directory it cannot prove it created, and it never touches any
# other server, plugin or skill.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

say "browser-fast-hybrid uninstaller"
info "codex home : $CODEX_HOME"
info "mode       : $([ "$DRY_RUN" = 1 ] && echo 'dry run (no writes)' || echo 'uninstall')"
say ''

say '1) ~/.codex/config.toml'
if [ ! -f "$CODEX_CONFIG" ]; then
  info 'no config.toml — nothing to remove'
elif has_managed_block; then
  if [ "$DRY_RUN" = 1 ]; then
    info 'would back up config.toml and remove the marker-delimited block'
  else
    backup_config
    remove_managed_block
    info "removed [mcp_servers.$SERVER_NAME]"
  fi
elif grep -qE "^\[mcp_servers\.$SERVER_NAME\]" "$CODEX_CONFIG" 2>/dev/null; then
  warn "an [mcp_servers.$SERVER_NAME] entry exists but has no installer markers; leaving it alone. Remove it by hand if you want it gone."
else
  info 'no managed block present'
fi
say ''

say '2) ~/.codex/skills/browser-fast-hybrid'
if [ ! -d "$SKILL_DIR" ]; then
  info 'not installed'
elif [ ! -f "$SKILL_DIR/$SKILL_MARKER" ]; then
  warn "$SKILL_DIR has no installer marker; leaving it alone."
elif [ "$DRY_RUN" = 1 ]; then
  info "would remove $SKILL_DIR/SKILL.md, $SKILL_DIR/$SKILL_MARKER and the directory"
else
  rm -f "$SKILL_DIR/SKILL.md" "$SKILL_DIR/$SKILL_MARKER"
  rmdir "$SKILL_DIR" 2>/dev/null || warn "$SKILL_DIR is not empty; left in place"
  info 'skill removed'
fi
say ''
say 'Done. Restart Codex for the change to take effect.'
say 'The repository itself, node_modules and dist were not touched.'
