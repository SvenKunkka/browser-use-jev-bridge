<!-- SVENKUNKKA-README-NAV:BEGIN -->
[中文项目说明](#project-overview-zh) · [English overview](#project-overview-en) · [维护者 X / Maintainer on X](https://x.com/Svenu1s5)
<!-- SVENKUNKKA-README-NAV:END -->

# browser-use-jev-bridge

**A Jev-style fast policy in front of a Browser Use Pi fallback, sharing one
browser session, with an independent verifier, an approval gate and an audit
log.**

Ordinary HTML controls are handled by a fast, dynamically-typed decision policy
that makes one structured model call per step. Anything it cannot model —
iframes, file uploads, canvas, complex shadow DOM, modal dialogs, popups, new
tabs, recovery — is handed to a general-purpose Browser Use Pi agent **in the
same tab, on the same CDP connection, in the same workspace**. A run is only
reported as complete when a separate verification call confirms it from a fresh
observation of the final page, with enough confidence.

**The handoff is one-way.** Once Browser Use Pi takes over, the run re-observes,
verifies and ends; control does not return to the fast path. This version cannot
enumerate the individual browser actions inside a Pi cell, so it cannot promise
the fast path would not repeat one. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) § "Jev → Pi is one-way".

It ships two front ends over one engine: the `bu-fast` CLI and `bu-fast-mcp`,
a stdio MCP server built on the official SDK, so an agent such as Codex can
start a task, watch it, and answer approval requests between calls.

- MCP tool reference: [`docs/MCP.md`](docs/MCP.md)
- Install, upgrade, uninstall: [`docs/INSTALL.md`](docs/INSTALL.md)
- Architecture and porting notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Security model and defaults: [`docs/SECURITY.md`](docs/SECURITY.md)
- Acceptance evidence: [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)
- Codex skill: [`skill/SKILL.md`](skill/SKILL.md)

> **This is not a sandbox.** Pi executes model-authored JavaScript in a Node
> worker with filesystem and network access, against a real browser profile.
> Run untrusted tasks on an isolated machine. See `docs/SECURITY.md`.

## Requirements

- Node **>= 22.19** (`@browser_use/pi@0.1.0` declares `engines.node >= 22.19`).
- Google Chrome, Chromium or Microsoft Edge, or a Browser Use Cloud key.
- For the fast path: a TypeSafe key and a small OpenAI-compatible text model key.
- For the fallback: whatever `@browser_use/pi` needs for your chosen model
  (typically `OPENROUTER_API_KEY`).

None of these are needed to build the project or to run its tests: the entire
test suite, including the browser integration tests, runs offline.

## Install from zero

```sh
git clone https://github.com/SvenKunkka/browser-use-jev-bridge.git
cd browser-use-jev-bridge
npm install            # installs @browser_use/pi locally; the global copy is untouched
npm run check          # type-check
npm test               # offline unit + fixture integration tests
npm run build          # emit dist/
npm run smoke          # offline end-to-end against local fixtures
node dist/cli.js doctor --json
```

`npm install` installs `@browser_use/pi` **into this project**. Any globally
installed copy is left exactly as it is, and nothing in
`/opt/homebrew/lib/node_modules` is read, patched or written.

To get `bu-fast` on your PATH:

```sh
npm link          # or: alias bu-fast="node $PWD/dist/cli.js"
```

To register the MCP server and the skill with Codex on this machine:

```sh
./scripts/install-local.sh --dry-run    # show exactly what would change
./scripts/install-local.sh              # back up config.toml, then install
./scripts/doctor-local.sh               # verify the installation
./scripts/uninstall-local.sh            # remove only what we installed
```

The installer adds one `[mcp_servers.browser-fast-hybrid]` block between marker
comments and one `~/.codex/skills/browser-fast-hybrid/` directory. It never
touches the bundled `browser` plugin or any other server. If the shell running
the installer sees this checkout at a different path than Codex will
(a container or VM with the project bind-mounted), pass
`--repo-root /the/path/Codex/sees`. See [`docs/INSTALL.md`](docs/INSTALL.md).

Codex reads `config.toml` and the skills directory **at startup**, so an
install is "installed, awaiting restart" until Codex is restarted.

## Configure

```sh
cp .env.example .env     # then fill it in; .env is git-ignored
```

`bu-fast` loads `./.env` at startup, and a variable already set in your shell
always beats the file. **No command-line flag accepts a key**, so nothing ends
up in shell history or a process listing.

The library entry point does **not** load `.env` implicitly. Programmatic
callers do it themselves:

```ts
import { applyDotEnv, loadConfig, runTask } from 'browser-use-jev-bridge';
applyDotEnv();                       // names only are reported; values are never logged
const outcome = await runTask({ config: loadConfig({}), goal: '…', url: '…' });
```

Attaching to your own Chrome is the usual setup:

```sh
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.bujb-chrome"

export BUJB_CDP_URL=http://127.0.0.1:9222
```

Use a dedicated `--user-data-dir`. Pointing remote debugging at your everyday
profile exposes every logged-in session in it to the agent.

## Use

```sh
# Ordinary run (hybrid: Jev fast path, Pi fallback)
bu-fast run --url https://example.com/search --goal "the results are filtered to In stock"

# Ask before every action
bu-fast run --url https://example.com/search --goal "…" --review

# Constrain it
bu-fast run --url https://example.com/ --goal "…" \
  --allowed-domain '*.example.com' --prohibited-domain ads.example.com \
  --max-steps 20 --timeout-ms 120000 --max-cost-usd 0.25 --json

# Fast path only, no general-purpose fallback
bu-fast run --url … --goal "…" --mode fast

# Offline self-check, and environment report
bu-fast verify
bu-fast doctor --mode hybrid --json
bu-fast doctor --mode fast --json
bu-fast doctor --mode pi --json
bu-fast verify --audit .work/audit-<uuid>.jsonl
```

### doctor readiness

`doctor` answers one question per mode: can this actually run right now?

| Status | Meaning | Exit |
| --- | --- | --- |
| `ready` | every leg the mode needs has credentials and a browser | 0 |
| `partial` | it will start, but something is degraded (for example `--mode fast` with no text model, so `TYPE_TEXT` cannot run) | 0 |
| `not_ready` | the mode cannot run — the reasons are listed under `blockers` | 4 |

`--mode hybrid` checks the fast path and the Pi fallback separately; it is
`not_ready` only when neither leg is usable, and `partial` when one is. The Pi
check resolves the provider from the configured model id (`openrouter/...` →
`OPENROUTER_API_KEY`) and, with `Browser.cloud()`, also requires
`BROWSER_USE_API_KEY`. When `BUJB_CDP_URL` is set, the endpoint is really
contacted; when it is not, `doctor` says the automatic connection is **not
verified** rather than implying a successful probe.

### As an MCP server

```sh
bu-fast-mcp          # stdio; stdout is JSON-RPC only, diagnostics go to stderr
```

```jsonc
browser_fast_start  { "url": "…", "goal": "…", "review": true }   → { sessionId }
browser_fast_status { "sessionId": "…" }                          → poll
browser_fast_approve{ "sessionId": "…", "approvalId": "…", "approved": true }
browser_fast_cancel { "sessionId": "…" }
```

No MCP tool accepts a credential, unknown fields are rejected, and an
unanswered approval is denied. Full reference: [`docs/MCP.md`](docs/MCP.md).

### Budgets and the deadline

`--max-steps`, `--timeout-ms` and `--max-cost-usd` are **one budget for the
whole run**. A Pi fallback leg is offered only what is left after the fast path
has spent its share, never the original limits.

`--timeout-ms` is a run-level deadline bound to a single `AbortSignal`: the
initial navigation, every observation and freshness probe, page evaluation and
CDP calls, TypeSafe requests *and their retry backoff*, text-model requests,
Jev input dispatch, the Pi leg, the re-observation after it, and the final
verification call. Closing gets its own small allowance
(`BUJB_CLEANUP_MS`, default 10 s) so cleanup is never cut off. An expired
budget reports `timeout`; a caller cancelling reports `cancelled`.

`RunOutcome.budget` reports limits, used and remaining. Cost accounting covers
the Pi legs; the TypeSafe and text-model endpoints do not report a price.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Goal reached **and** verified |
| 1 | Finished without verified success |
| 2 | Usage error — unknown flag, missing value, non-positive budget, bad URL |
| 3 | An action needed human approval and none was available |
| 4 | Environment or configuration problem (including `doctor: not_ready`) |

Only `0` means the task is done. `status: "completed"` is emitted only
alongside `verification.verified: true`.

Unknown flags are rejected, not ignored: `--max-setps 5` exits 2 rather than
quietly running with the default budget.

### After a stop, before re-running

Exit 3 (and MCP `blocked` with `outcomeStatus: "stopped_by_approval"`) means
**the declined action was not dispatched**. It does not mean the page is
unchanged: earlier steps in the same run may already have changed it, and if
the run reached Browser Use Pi, that leg's internal actions are not
enumerated.

Before re-running, read `history` (CLI) or `steps` (MCP). Every entry carries
an `executionPhase` and an `effectUncertain` flag, and anything in
`uncertainActions` must be treated as having happened. Only an empty `history`
shows that nothing was dispatched.

## What is guaranteed, and what is not

Guaranteed by construction and covered by tests:

- one Pi session owns the browser; the fast path has no browser of its own;
- an action that may have taken effect is recorded *before* the operation that
  could cause it, carries an explicit `executionPhase`, and is never retried or
  re-planned;
- `--timeout-ms` is a run-level deadline covering browser calls, model calls,
  retry backoff, the Pi leg and the verifier;
- the MCP server adds session lifecycle and a cross-call approval channel, and
  nothing else: same router, same gate, same budget, same redactor;
- the Pi approval hook is installed at session creation and reads Pi 0.1.0's
  real context (`toolCall.name`, `args`) — proved at runtime by
  `tests/integration.pi-fallback.test.ts`, which drives the actual Pi agent
  loop against a local browser;
- a high-risk Pi tool call is refused by default, and the page is unchanged;
- `--review` gates every Pi tool call, not only pattern matches;
- the Pi fallback is terminal, so no Jev action can follow a Pi action;
- one budget covers Jev steps, Pi steps, wall clock and cost, and a second
  fallback leg cannot reset it;
- a decision executes only against the page fingerprint it was made on;
- `CLICK`/`SELECT` re-check the node guard and the form-control page key, and
  then re-check visibility, disabled state, viewport and occlusion in-page at
  the instant of input;
- nothing is retried automatically after an action reached the browser;
- every dispatched **Jev** action is carried into the handoff as
  `mustNotRepeat`;
- high-risk actions are blocked without a human;
- credentials never reach the text model, and `input[type=password]` is never
  in the action space at all;
- completion is decided by a separate call that is shown the goal and a fresh
  page — never the agent's claim — and requires `SATISFIED` plus a confidence
  and a probability above the configured thresholds.

Not guaranteed, and stated plainly:

- **Pi's internal browser actions are not enumerated.** `history` has one
  record per Pi leg and `mustNotRepeat` covers Jev actions only. Nothing in
  this project claims otherwise, and it is why the fallback is terminal;
- the third Pi approval layer is a pattern match over generated JavaScript; the
  intent check and `--review` are the layers that do not depend on it;
- verification is an independent **call**, not an independent model — it uses
  the same TypeSafe provider and model id as the decision heads;
- the in-page digests used for freshness are 64-bit-class hashes, so a
  collision could in principle mask a change (see `docs/ARCHITECTURE.md`);
- this project does not sandbox anything.

## Testing

```sh
./scripts/acceptance.sh   # runs everything below and writes docs/acceptance-local.txt
```

```sh
npm run check        # tsc --noEmit over src and tests
npm test             # unit + fixture integration (offline)
npm run test:unit    # unit only, no browser needed
npm run test:fixtures
npm run build
npm run smoke        # end-to-end against dist/, offline; [jev] [verifier] [pi] [approval] [mcp]
npm run mcp:handshake  # initialize/listTools against the shipped bu-fast-mcp entry point
```

The fixture tests launch a throwaway headless Chromium and attach a **real** Pi
session to it. The Jev tests replace only the two paid endpoints with
deterministic scripts; Pi's model transport is replaced by one that throws, so
its agent loop physically cannot contact a provider.

`tests/integration.pi-fallback.test.ts` goes further: it drives Pi's **real
agent loop** with a scripted `streamFn`, so a genuine `javascript` tool call is
produced, the approval hook is invoked by Pi itself, and the test can assert
that a refused high-risk call leaves the page untouched while an approved one
does not.

`tests/integration.mcp.test.ts` does the same for the MCP surface: a real stdio
transport, the official SDK client, the real session manager, approval channel,
router and Chromium. `npm run smoke` runs the same shapes against `dist/`, with
its output split into `[jev]`, `[verifier]`, `[pi]`, `[approval]` and `[mcp]`
sections.

If no browser is installed the browser tests skip rather than fail; set
`BUJB_TEST_CHROME` to point at one.

`@earendil-works/pi-ai` is a pinned **dev** dependency (0.85.1, the version Pi
itself pins). The harness uses only its public
`utils/event-stream` subpath, to build the scripted transport. No production
code path imports it.

## Codex integration

The MCP server ships and is covered by protocol-level tests that drive a real
stdio transport, the real session manager, the real router, a real Browser Use
Pi agent loop and a real Chromium.

`skill/SKILL.md` is written for an agent caller: prefer the `browser_fast_*`
MCP tools, keep the `bu-fast` CLI for diagnostics and terminal review, when
`review` is mandatory, how to read each state and exit code, and what to check
before re-running after a stop.

`scripts/install-local.sh` does the whole local registration (server + skill).
`skill/install.sh <dir>` copies just the skill into a directory you name.
Neither overwrites anything it did not create, and neither is run by the
build.

## Licence and attribution

MIT. This project ports MIT-licensed code from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) and
depends on [`@browser_use/pi`](https://github.com/browser-use/browser-use-pi)
through its public API. Both licences and a file-by-file statement of what was
reused are in [`LICENSES/`](LICENSES/NOTICE.md).


---

<!-- SVENKUNKKA-PROJECT-INFO:BEGIN -->

<a id="project-overview-zh"></a>
## 中文项目说明

混合浏览器自动化工具：普通网页控件使用快速策略，复杂操作交给共享会话的 Browser Use Pi，并提供 CLI、MCP、确认门禁、审计日志和独立页面核验。

**使用入口：** 使用 Node.js 22.19 及以上版本，运行 `npm install`、`npm run build`，配置 `.env`；安装与 MCP 接入见 [docs/INSTALL.md](docs/INSTALL.md)。

**范围说明：** 快速策略转交 Pi 后不会返回；Pi 可访问文件系统与网络，工具并非隔离沙箱。浏览器、模型服务及密钥需自行配置。

<a id="project-overview-en"></a>
## English project overview

A hybrid browser automation tool that uses a fast policy for ordinary HTML controls and hands complex work to Browser Use Pi in the same session, with CLI and MCP interfaces, approval gates, audit logs and independent page verification.

**Getting started:** Use Node.js 22.19 or later, run `npm install` and `npm run build`, then configure `.env`. See [docs/INSTALL.md](docs/INSTALL.md) for installation and MCP integration.

**Scope:** Handoff to Pi is one-way. Pi has filesystem and network access, so this tool is not an isolation sandbox. Browsers, model services and credentials require configuration.

**仓库维护者 / Repository maintainer:** [SvenKunkka](https://github.com/SvenKunkka) · [X / Twitter](https://x.com/Svenu1s5)

<!-- SVENKUNKKA-PROJECT-INFO:END -->
