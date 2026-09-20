# Install, upgrade, uninstall

This tool installs as a **separate** Codex MCP server called
`browser-fast-hybrid`, alongside whatever you already have. It does not
replace, disable or modify the bundled `browser` plugin, any other MCP server,
or any other skill.

## What gets installed

| Where | What | Removable |
| --- | --- | --- |
| `~/.codex/config.toml` | one `[mcp_servers.browser-fast-hybrid]` block between marker comments | yes, exactly |
| `~/.codex/skills/browser-fast-hybrid/` | `SKILL.md` plus an installer marker file | yes, exactly |
| the repository | `node_modules/` and `dist/` | ordinary build output |

Nothing else is written. No credential is written anywhere.

## Install

```sh
cd /path/to/browser-use-jev-bridge

./scripts/install-local.sh --dry-run    # print every change, write nothing
./scripts/install-local.sh              # npm ci + build, then register
./scripts/doctor-local.sh               # verify
```

Then **restart Codex**. It reads `config.toml` and the skills directory at
startup; a running Codex will not pick up the new server. "Installed" and
"loaded" are different states, and `doctor-local.sh` only proves the first.

Options:

- `--dry-run` — show the exact TOML block and file paths, change nothing.
- `--skip-deps` — register only; do not run `npm ci` or `npm run build`. Use
  this when the dependencies are already installed **for this platform**.
- `--repo-root /abs/path` — record that path in `config.toml` instead of the
  script's own location. Needed only when the shell running the installer sees
  the checkout at a different path than Codex will: a container or VM with the
  project bind-mounted. The script still reads `skill/SKILL.md` and checks
  `dist/` where it actually is, and writes the path you gave into the config.
  It must be absolute. `BFH_REPO_ROOT` is the environment form.
  `./scripts/doctor-local.sh --repo-root …` takes the same flag and checks that
  the registered `cwd` matches.

`CODEX_HOME` is honoured if you keep Codex's home somewhere other than
`~/.codex`.

### Platform note

`node_modules` contains platform-specific packages (for example
`@esbuild/darwin-arm64` on an Apple Silicon Mac). Install dependencies **on the
machine that will run the server** — `./scripts/install-local.sh` does that for
you. A tree installed on another platform will fail at runtime.

## Safety properties of the installer

- **Backs up first.** `config.toml` is copied to
  `config.toml.bak.<YYYYmmdd-HHMMSS>` before any edit.
- **Idempotent.** A second run reports "already present" and changes nothing.
- **Refuses to clobber.** If an `[mcp_servers.browser-fast-hybrid]` entry exists
  that the installer did not write, it aborts and changes nothing. If
  `~/.codex/skills/browser-fast-hybrid/` exists without the installer's marker
  file, it aborts.
- **Minimal.** It appends one block; it does not rewrite, reorder or reformat
  the rest of the file.

## Upgrade

```sh
cd /path/to/browser-use-jev-bridge
git pull                       # or however you update the checkout
npm ci && npm run build
./scripts/doctor-local.sh
```

The config block points at `dist/mcp/main.js` in this directory, so a rebuild
is the upgrade. Re-run `./scripts/install-local.sh` only if you moved the
repository or changed `SKILL.md` — it will reinstall the skill file and leave
the config block alone.

## Uninstall

```sh
./scripts/uninstall-local.sh --dry-run
./scripts/uninstall-local.sh
```

It removes only the marker-delimited config block (after a backup) and only a
skill directory that carries its own marker file. If either was edited by hand
it says so and leaves it alone rather than guessing. The repository,
`node_modules` and `dist` are untouched.

## The registered block

```toml
# >>> browser-fast-hybrid (managed by browser-use-jev-bridge) >>>
[mcp_servers.browser-fast-hybrid]
command = "/bin/sh"
cwd = "<repository>"
startup_timeout_sec = 120
args = ["-lc", """…resolve node from a login shell, then exec dist/mcp/main.js…"""]
# <<< browser-fast-hybrid <<<
```

A login shell is used so the launcher picks up nvm, fnm, Volta or Homebrew
node the same way your terminal does, with explicit fallbacks. `cwd` is the
repository, so `./.env` is the one that gets loaded.

## Using it from Codex

Once Codex has restarted:

```
Use browser-fast-hybrid: open https://example.com and tell me the exact text of
the first paragraph. Read-only, allowedDomains example.com.
```

Codex should call `browser_fast_doctor`, then `browser_fast_start`, then poll
`browser_fast_status`. For anything consequential, ask it to pass
`review: true` and answer with `browser_fast_approve`.

See [`MCP.md`](MCP.md) for the tool reference and the approval workflow.

## Troubleshooting

**Codex does not list the tools.** It was probably not restarted. Check
`./scripts/doctor-local.sh` first — if it says the block is registered, restart
Codex.

**The server exits immediately.** Run it by hand:

```sh
node dist/mcp/main.js < /dev/null
```

It should print `[browser-fast-hybrid] ready on stdio` to **stderr** and then
exit when stdin closes. If it reports a missing module, run `npm ci` on this
machine. If it reports a missing `dist/mcp/main.js`, run `npm run build`.

**`doctor` says `not_ready`.** That is the tool telling you it cannot run. Read
`blockers`: usually a missing `TYPESAFE_API_KEY` / provider key, or no Chrome.
Fill in `.env` (see `.env.example`) and re-check.

**A run stops with `blocked` / exit 3.** An action needed approval. That means
the *declined* action was not dispatched — it does not mean the page is
unchanged. Read `steps` / `history` and anything in `uncertainActions` before
re-running. See [`SECURITY.md`](SECURITY.md).

**A run ends `timeout`.** The whole-run deadline fired. An action in flight at
that moment is marked `effect_uncertain`; treat it as having happened.

**Two things fighting over Chrome.** Only one browser task runs at a time per
MCP server, but the CLI and the MCP server are separate processes. Do not run
`bu-fast run` against the same Chrome profile while a Codex session is active.
