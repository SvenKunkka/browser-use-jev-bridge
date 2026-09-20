#!/usr/bin/env bash
# Install this skill into a Codex skills directory.
#
# It is deliberately NOT run by the project's build or test scripts, and it
# never writes outside the directory you give it. Review it before use.
#
#   ./skill/install.sh ~/.codex/skills
#
set -euo pipefail

target="${1:-}"
if [[ -z "$target" ]]; then
  echo "usage: $0 <skills-directory>" >&2
  echo "example: $0 ~/.codex/skills" >&2
  exit 2
fi
if [[ ! -d "$target" ]]; then
  echo "error: $target does not exist. Create it yourself first." >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$target/browser-fast-hybrid"

if [[ -e "$dest" ]]; then
  echo "error: $dest already exists. Remove or rename it first; this script never overwrites." >&2
  exit 1
fi

mkdir -p "$dest"
cp "$here/SKILL.md" "$dest/SKILL.md"
echo "installed: $dest/SKILL.md"
echo "note: bu-fast must be on PATH (npm link, or call dist/cli.js directly)."
