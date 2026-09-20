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
git clone <this repository> browser-use-jev-bridge
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

### Budgets

`--max-steps`, `--timeout-ms` and `--max-cost-usd` are **one budget for the
whole run**. A Pi fallback leg is offered only what is left after the fast path
has spent its share, never the original limits, and the deadline aborts an
in-flight Pi run rather than being noticed afterwards. `RunOutcome.budget`
reports limits, used and remaining. Cost accounting covers the Pi legs; the
TypeSafe and text-model endpoints do not report a price.

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

## What is guaranteed, and what is not

Guaranteed by construction and covered by tests:

- one Pi session owns the browser; the fast path has no browser of its own;
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
- there is no MCP server in this version;
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
npm run smoke        # end-to-end against dist/, offline
```

The fixture tests launch a throwaway headless Chromium and attach a **real** Pi
session to it. The Jev tests replace only the two paid endpoints with
deterministic scripts; Pi's model transport is replaced by one that throws, so
its agent loop physically cannot contact a provider.

`tests/integration.pi-fallback.test.ts` goes further: it drives Pi's **real
agent loop** with a scripted `streamFn`, so a genuine `javascript` tool call is
produced, the approval hook is invoked by Pi itself, and the test can assert
that a refused high-risk call leaves the page untouched while an approved one
does not. `npm run smoke` runs the same shape against `dist/`, with its output
split into `[jev]`, `[verifier]`, `[pi]` and `[approval]` sections.

If no browser is installed the browser tests skip rather than fail; set
`BUJB_TEST_CHROME` to point at one.

`@earendil-works/pi-ai` is a pinned **dev** dependency (0.85.1, the version Pi
itself pins). The harness uses only its public
`utils/event-stream` subpath, to build the scripted transport. No production
code path imports it.

## Codex integration

`skill/SKILL.md` is written for an agent caller: when to use the tool, when
`--review` is mandatory, how to read the exit codes, and how to handle each
failure mode. `skill/install.sh <dir>` copies it into a skills directory you
name; it refuses to overwrite anything and is never run by the build.

**MCP is not implemented in this version.** The CLI is the complete, supported
interface. The intended next-stage MCP surface, so it can be reviewed before it
is built:

| Tool | Input | Output | Notes |
| --- | --- | --- | --- |
| `browser_fast_run` | `{url, goal, mode?, review?, allowedDomains?, prohibitedDomains?, maxSteps?, timeoutMs?, maxCostUsd?}` | `RunOutcome` (`src/types.ts`) | One session per call; blocks until the run ends. `review: true` requires an approval channel, i.e. `browser_fast_approve`. |
| `browser_fast_step` | `{sessionId}` | `{snapshotDigest, decision, riskAssessment, pendingApprovalId?}` | Advances one step of an existing session. Returns *before* executing when approval is pending. |
| `browser_fast_approve` | `{sessionId, approvalId, approved, reason?}` | `{executed: boolean, record?: ActionRecord}` | The only way a high-risk action proceeds over MCP. |
| `browser_fast_verify` | `{sessionId}` or `{auditPath}` | `VerificationResult` | Runs the independent verifier, or re-checks a recorded log offline. |
| `browser_fast_cancel` | `{sessionId}` | `{status}` | Cancels the Pi run and closes the session. |

Building it requires session lifetime management (`sessionId` → `PiSession`),
an approval channel that survives across tool calls, and a policy for
abandoned sessions. None of that exists yet, and nothing in this repository
pretends otherwise.

## Licence and attribution

MIT. This project ports MIT-licensed code from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) and
depends on [`@browser_use/pi`](https://github.com/browser-use/browser-use-pi)
through its public API. Both licences and a file-by-file statement of what was
reused are in [`LICENSES/`](LICENSES/NOTICE.md).
