# browser-use-jev-bridge

**A Jev-style fast policy in front of a Browser Use Pi fallback, sharing one
browser session, with an independent verifier, an approval gate and an audit
log.**

Ordinary HTML controls are handled by a fast, dynamically-typed decision policy
that makes one structured model call per step. Anything it cannot model —
iframes, file uploads, canvas, complex shadow DOM, modal dialogs, popups, new
tabs, recovery — is handed to a general-purpose Browser Use Pi agent **in the
same tab, on the same CDP connection, in the same workspace**. A run is only
reported as complete when a separate verifier confirms it from a fresh
observation of the final page.

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

Every credential is read from the environment. **No command-line flag accepts a
key**, so nothing ends up in shell history or a process listing.

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
bu-fast doctor --json
bu-fast verify --audit .work/audit-<uuid>.jsonl
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Goal reached **and** independently verified |
| 1 | Finished without verified success |
| 2 | Usage error |
| 3 | A high-risk action needed human approval and none was available |
| 4 | Environment or configuration problem |

Only `0` means the task is done. `status: "completed"` is emitted only
alongside `verification.verified: true`.

## What is guaranteed, and what is not

Guaranteed by construction and covered by tests:

- one Pi session owns the browser; the fast path has no browser of its own;
- a decision executes only against the page fingerprint it was made on;
- `CLICK`/`SELECT` re-check the node guard and the form-control page key, and
  then re-check visibility, disabled state, viewport and occlusion in-page at
  the instant of input;
- nothing is retried automatically after an action reached the browser;
- every dispatched action is carried into any handoff as `mustNotRepeat`;
- high-risk actions are blocked without a human;
- credentials never reach the text model, and `input[type=password]` is never
  in the action space at all;
- completion is decided by a verifier that is shown the goal and a fresh page,
  never the agent's claim.

Not guaranteed, and stated plainly:

- approval on the **Pi** leg is a code inspection, not a semantic action gate
  (see `docs/SECURITY.md`);
- the in-page digests used for freshness are 64-bit-class hashes, so a
  collision could in principle mask a change (see `docs/ARCHITECTURE.md`);
- this project does not sandbox anything.

## Testing

```sh
npm run check        # tsc --noEmit over src and tests
npm test             # unit + fixture integration (offline)
npm run test:unit    # unit only, no browser needed
npm run test:fixtures
npm run build
npm run smoke        # end-to-end against dist/, offline
```

The fixture tests launch a throwaway headless Chromium, attach a **real** Pi
session to it, and replace only the two paid endpoints with deterministic
scripts. Pi's own model transport is replaced by one that throws, so the agent
loop physically cannot contact a provider. If no browser is installed the
browser tests skip rather than fail; set `BUJB_TEST_CHROME` to point at one.

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
