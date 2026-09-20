# Acceptance evidence

Everything below was executed on **2026-09-20**, in the environment described in
§1. Command output is pasted verbatim. Nothing in this file is a claim that was
not produced by a command.

**Headline:** the offline implementation is complete and verified. **No online
run against a live site was performed**, because no `TYPESAFE_API_KEY`,
`TEXT_MODEL_API_KEY` or `OPENROUTER_API_KEY` exists in this environment. That
item is recorded as `blocked_by_credentials`, not as a pass.

---

## 1. Environment and dependency versions

```text
$ node --version
v22.22.2

$ npm --version
10.9.7

$ uname -sm
Linux x86_64

$ npm ls --depth=0
browser-use-jev-bridge@0.1.0 /home/claude/browser-use-jev-bridge
+-- @browser_use/pi@0.1.0
+-- @types/node@22.20.4
`-- typescript@5.9.3


$ npm view @browser_use/pi version engines.node license
version = '0.1.0'
engines.node = '>=22.19'
license = 'MIT'
```

Checked against the live sources rather than taken from the brief:

| Assumption in the brief | What the live source says | Effect on this project |
| --- | --- | --- |
| `@browser_use/pi@0.1.0` is current | `npm view`: `0.1.0` is the only published version, `dist-tags.latest = 0.1.0`, published 2026-09-09, MIT | matches |
| Node v26.8.1 | the package declares `engines.node >= 22.19`; this build ran on v22.22.2 | both are supported; this project declares the same `>= 22.19` |
| `Browser.chrome` is public | yes — `Browser.cloud / chromium / chrome` are exported | used |
| `openBrowser()` is usable | declared in `dist/browser.d.ts` but **not** re-exported from the entry point, and the `exports` map only exposes `"."` | not used; this project never reaches into `dist/*` |
| `agent.execute` hands back data | it returns `{text, images, targetId, …}`; the JSON channel (`valueJson`) is only populated on the private `BrowserRuntime.readResult` path | the fast path uses a sentinel-delimited JSON payload on the cell's stdout |
| `redact` takes named values | `history.redact(value, secrets)` treats the array as literal secret **values**, and `sensitiveData` values are appended to it automatically | literal values are passed |
| Jev Ultrafast can be reused directly | it is a Python project built on Browser Harness | fully re-implemented in TypeScript over the Pi cell backend; there is no second process |

The macOS machine state described in the brief (`/opt/homebrew/bin/bu-pi-server`,
a global `@browser_use/pi`, Node v26.8.1, Apple Silicon) **could not be reached
from the session that built this**, so it was not relied on — and it was not
modified. This project installs its own `@browser_use/pi` under
`./node_modules`; nothing reads or writes `/opt/homebrew/lib/node_modules`.

---

## 2. `npm run check`

```text

> browser-use-jev-bridge@0.1.0 check
> tsc --noEmit -p tsconfig.json

check exit=0
```

## 3. `npm test`

Offline unit tests plus fixture integration tests driving a real headless
Chromium through a real Browser Use Pi session whose model transport is
replaced by one that throws.

```text
    ok 1 - fixture — the snapshot exposes usable controls and hides disabled ones
    ok 2 - fixture — clicking a button changes the page and the fingerprint
    ok 3 - fixture — typing replaces the field value
    ok 4 - fixture — selecting a dropdown option applies it in the page
    ok 5 - fixture — an occluded control is refused at the last instant
    ok 6 - fixture — a node whose guard changed cannot be clicked
    ok 7 - fixture — a whole-page change invalidates a pending fill
    ok 8 - fixture — an unsupported page is detected from a real observation
    ok 9 - fixture — a full scripted fast-path run reaches a verified completion
    ok 10 - fixture — the domain policy stops a run before the browser is touched
    ok 11 - requirement 1 — dynamic action space is built from observed controls only
    ok 12 - an element with no supported operation never enters the space
    ok 13 - requirement 4 — a page change produces a different fingerprint
    ok 14 - requirement 4 — changing the action list alone invalidates the fingerprint
    ok 15 - requirement 5 — a decision made on an older page cannot be executed
    ok 16 - node guards reject a changed control and a changed form-control page key
    ok 17 - stable stringify sorts keys so digests do not depend on property order
    ok 18 - requirement 8 — the handoff lists every action that may already have taken effect
    ok 19 - duplicate executions are listed once
    ok 20 - requirement 2 — a well-formed TypeSafe answer is accepted
    ok 21 - requirement 3 — malformed or illegal answers are rejected and nothing executes
    ok 22 - requirement 3 — a target head naming an element that was not offered is refused
    ok 23 - the operation head decides which target head is validated
    ok 24 - the request carries one question per supported operation and never a raw DOM dump
    ok 25 - requirement 6 — three actions with no page change hand the task to Pi
    ok 26 - requirement 7 — BLOCKED hands the task to Pi instead of guessing
    ok 27 - requirement 7 — BLOCKED with no fallback available stops instead of continuing
    ok 28 - two consecutive stale decisions hand the task to Pi
    ok 29 - requirement 12 — control returns to Jev only through a fresh observation
    ok 30 - requirement 13 — a DONE claim that fails verification is never reported as completed
    ok 31 - requirement 13 — with no verifier configured the run is unverified, not completed
    ok 32 - requirement 9 — an unapproved high-risk action stops the run before anything is dispatched
    ok 33 - an approved high-risk action does execute, and is recorded as high risk
    ok 34 - a credential-like field is never filled by the text model
    ok 35 - unsupported-page detection routes iframes, canvas, shadow DOM, popups and uploads to Pi
    ok 36 - an unsupported page is handed over before any action is attempted
    ok 37 - requirement 10 — domain allow and deny rules
    ok 38 - requirement 11 — secrets never survive into logs or error messages
    ok 39 - requirement 9 — high-risk actions require human confirmation and are denied without one

# tests 39
# suites 0
# pass 39
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4643.627136
test exit=0
```

## 4. `npm run build`

```text
> browser-use-jev-bridge@0.1.0 build
> node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})" && tsc -p tsconfig.build.json
build exit=0
```

## 5. `npm run smoke` (offline, against `dist/`)

```text
INFO  chrome at http://127.0.0.1:37823, workspace /tmp/bujb-smoke-oq4mJP
PASS  fast path reaches a verified completion
PASS  an unverified completion claim is not reported as completed
PASS  the occlusion guard stops a covered click in a real page
PASS  an unsupported page is recognised from a real observation
smoke: ok in 1227 ms
smoke exit=0
```

## 6. `bu-fast doctor --json`

Every credential appears only as `set` or `unset`.

```json
{
  "status": "ok",
  "platform": "linux 6.18.44-fc-v37",
  "node": "v22.22.2",
  "checks": [
    {
      "name": "node version",
      "passed": true,
      "detail": "v22.22.2 (@browser_use/pi requires >= 22.19)",
      "required": true
    },
    {
      "name": "pi package",
      "passed": true,
      "detail": "@browser_use/pi 0.1.0",
      "required": true
    },
    {
      "name": "chrome available",
      "passed": true,
      "detail": "found /opt/pw-browsers/chromium",
      "required": true
    },
    {
      "name": "chrome remote debugging",
      "passed": true,
      "detail": "no BUJB_CDP_URL configured; Pi will launch or attach by profile",
      "required": false
    },
    {
      "name": "env TYPESAFE_API_KEY",
      "passed": false,
      "detail": "unset",
      "required": false
    },
    {
      "name": "env TEXT_MODEL_API_KEY",
      "passed": false,
      "detail": "unset",
      "required": false
    },
    {
      "name": "env OPENROUTER_API_KEY",
      "passed": false,
      "detail": "unset",
      "required": false
    },
    {
      "name": "typesafe endpoint",
      "passed": true,
      "detail": "https://api.typesafe.ai/v1/systemone (model jev-latest, key unset)",
      "required": false
    },
    {
      "name": "text model endpoint",
      "passed": true,
      "detail": "https://api.deepseek.com/v1 (model deepseek-chat, key unset)",
      "required": false
    },
    {
      "name": "workspace writable",
      "passed": true,
      "detail": "/home/claude/browser-use-jev-bridge/.work is writable",
      "required": true
    },
    {
      "name": "telemetry",
      "passed": true,
      "detail": "disabled (default); DO_NOT_TRACK=unset",
      "required": false
    },
    {
      "name": "recording",
      "passed": true,
      "detail": "disabled (default)",
      "required": false
    }
  ],
  "config": {
    "mode": "hybrid",
    "review": false,
    "workspace": "/home/claude/browser-use-jev-bridge/.work",
    "pi": {
      "model": "openrouter/openai/gpt-5.6-luna",
      "reasoning": null
    },
    "typesafe": {
      "baseUrl": "https://api.typesafe.ai/v1/systemone",
      "model": "jev-latest",
      "apiKey": "unset"
    },
    "textModel": {
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "reasoning": "provider-default",
      "apiKey": "unset"
    },
    "browser": {
      "kind": "chrome",
      "cdpUrl": null,
      "executablePath": null,
      "profileDir": "unset",
      "headless": false,
      "cloudApiKey": "unset"
    },
    "budgets": {
      "maxSteps": 40,
      "timeoutMs": 300000,
      "maxCostUsd": 1
    },
    "domains": {
      "allowed": [],
      "prohibited": []
    },
    "privacy": {
      "telemetry": "disabled (default)",
      "recording": "disabled (default)",
      "highlightActions": false,
      "namedSecrets": []
    },
    "thresholds": {
      "maxConsecutiveStale": 2,
      "maxNoProgress": 3,
      "jevMaxSteps": 60
    },
    "environment": {
      "OPENROUTER_API_KEY": "unset",
      "BROWSER_USE_API_KEY": "unset",
      "TYPESAFE_API_KEY": "unset",
      "TEXT_MODEL_API_KEY": "unset",
      "DO_NOT_TRACK": "unset",
      "HOME": "set"
    }
  }
}
```

## 7. `bu-fast verify` (offline invariant self-check)

```text
PASS  dynamic action space: 3 elements, CLICK/TYPE_TEXT/SELECT target groups, WAIT control
PASS  TypeSafe response validation: 1 valid accepted, 5 invalid rejected
PASS  stale decision cannot execute: fingerprint change invalidates the pending decision
PASS  high-risk actions require approval: purchase/submit labels gated, navigation labels not
PASS  domain allow/deny rules: apex + wildcard allowed, denial wins, others refused
PASS  secret redaction: registered values and bearer tokens masked
PASS  text helper output validation: 1 valid accepted, 4 invalid rejected
PASS  handoff carries mustNotRepeat: executed action listed once; idempotent actions excluded

8/8 checks passed
verify exit=0
```

Negative control — an audit log that claims `completed` without a verified
result must fail:

```text
$ printf '%s\n' '{"type":"run_start","goal":"x"}' \
    '{"type":"run_end","status":"completed","verified":false}' > fake.jsonl
$ bu-fast verify --audit fake.jsonl
FAIL  audit completion is backed by verification: completed was claimed without a verified result
9/10 checks passed
$ echo $?
1
```

---

## 8. Requirement-by-requirement

Test numbers refer to the list in §3.

### Part 1 — core architecture

| Requirement | Status | Evidence |
| --- | --- | --- |
| Pi is the sole owner of the browser session, Chrome/CDP connection, tab lifecycle and workspace | pass | `src/pi/session.ts` is the only module that constructs `BrowserUse`; `src/jev/executor.ts` reaches the page only through the `BrowserBackend` port. No other `CDP`, `Tabs` or `Page` is constructed in `src/`. |
| Jev never starts a second Chrome control process | pass | the fast path's DOM work is `agent.execute()` → `page.evaluate` / `page.cdp` in Pi's cell; fixture tests 1–9 run entirely through it |
| Jev and Pi never contend for the same tab | pass | `HybridRouter` runs one leg at a time, and `BrowserUse.execute()` itself throws when the session is busy |
| Uses the public API: `BrowserUse.create`, `Browser.chrome`, `agent.execute`, `agent.run`, `agent.followUp`, events, budgets, domain limits, result validation, recording, cancellation | pass | `src/pi/session.ts`, `src/pi/fallback.ts`; budgets via `RunOptions.maxSteps/timeoutMs/maxCostUsd`; domains via `allowedDomains`/`prohibitedDomains`; cancellation via `agent.cancel()`; masking via `redact`/`sensitiveData` |
| Does not modify the global `@browser_use/pi` | pass | §1 |
| Does not depend on private `dist/*` modules | pass | only `import { … } from '@browser_use/pi'`; no adapter for private interfaces was needed |

### Part 2 — Jev port

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Visible content and actionable-control snapshot | pass | `SNAPSHOT_SOURCE`; fixture test 1 |
| 2 | Dynamic action space | pass | `src/jev/action-space.ts`; tests 11, 12 |
| 3 | `CLICK` `TYPE_TEXT` `SELECT` `SCROLL_UP` `SCROLL_DOWN` `WAIT` `DONE` `BLOCKED` | pass | `JEV_OPERATIONS`; tests 11, 12, 21, 22, 23 |
| 4 | Page fingerprint | pass | `fingerprintSnapshot`; tests 13, 14; fixture test 2 |
| 5 | Node guard and freshness checks | pass | `guardSource`, `guardMatches`; test 15, 16; fixture test 6 |
| 6 | Re-check node, visibility, disabled, occlusion and page version before clicking | pass | `actTargetSource`; fixture tests 5 and 6; smoke step 3 |
| 7 | Re-check page state before typing | pass | the router calls `isFresh` before text generation; fixture test 7 |
| 8 | Re-observe the page after each action | pass | `HybridRouter.executeStep`; fixture test 2 |
| 9 | Repeated ineffective-action detection | pass | test 25 |
| 10 | Operation head and target heads in one TypeSafe request | pass | `buildDecisionRequest`; test 24 |
| 11 | Separate small OpenAI-compatible model for text fields | pass | `src/jev/text-helper.ts`; test 34 proves it is bypassed for credentials |
| 12 | Independent result verification after `DONE` | pass | `src/verification/verifier.ts`; tests 30, 31; smoke step 2 |
| — | Licence and provenance preserved | pass | `LICENSES/NOTICE.md` maps every ported file to its upstream original |
| — | No unrelated demo assets or historical measurements copied | pass | `fixtures/` holds two hand-written pages; nothing from upstream `docs/` or `static/` |

### Part 3 — hybrid routing

| Requirement | Status | Evidence |
| --- | --- | --- |
| Ordinary visible HTML controls go to the Jev fast path | pass | fixture test 9; smoke step 1 |
| iframe, file upload, canvas, complex shadow DOM, dialog, popup and new tab go to Pi | pass | tests 35, 36; fixture test 8 |
| `BLOCKED` goes to Pi | pass | tests 26, 27 |
| Two consecutive stale/fingerprint failures go to Pi | pass | test 28 |
| Three consecutive non-WAIT actions with no effective page change go to Pi | pass | test 25 |
| Exceeding the Jev step limit goes to Pi, or stops safely | pass | the step-limit branch in `HybridRouter.run`; `--mode fast` stops instead (test 26, 27) |
| After Pi finishes, the page is re-observed and a new fingerprint generated before Jev resumes | pass | test 29 asserts the audit order `fallback_end` → `observation` → `decision` |
| Any old decision is invalid after the page changes | pass | test 15, 16 |
| No automatic repeat of a click, submit or input that may already have landed | pass | tests 18, 19; `effectUncertain`; there is no retry path in `executeStep` |
| Structured `HandoffContext` with exactly the specified fields | pass | `src/router/handoff.ts`; test 18, 19 |

### Part 4 — safety

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Pi anonymous telemetry off by default, explicit opt-in | pass | `config.telemetry` defaults false and `DO_NOT_TRACK=1` is set when unset; §6 |
| 2 | Recording off by default, explicit opt-in | pass | `config.recording` defaults false; §6 |
| 3 | No API key in `.env`, logs, history, screenshots or error messages | pass | `Redactor` wraps every sink; test 38; scan in §9 |
| 4 | `.env.example` provided; real `.env` git-ignored | pass | `.env.example`, `.gitignore`; §9 |
| 5 | `allowedDomains` and `prohibitedDomains` supported | pass | `src/safety/domains.ts`; test 37; fixture test 10 |
| 6 | Max steps, total timeout and max model cost | pass | `--max-steps`, `--timeout-ms`, `--max-cost-usd`, enforced in the loop and handed to Pi |
| 7 | Purchase, payment, message send, delete, publish, approval submission and sensitive upload pause for human confirmation | pass | `assessRisk` + `DenyHighRiskGate`; tests 32, 33, 39 |
| 8 | `--review` shows URL, policy source, action type, target element, non-sensitive text summary and risk level | pass | `TerminalApprovalGate.render`; refused outright without a TTY rather than degrading |
| 9 | Passwords and tokens via named secret injection, never model-generated | pass | `input[type=password]` never enters the action space; credential-like labels are refused before the text model (test 34); Pi receives `sensitiveData` |
| 10 | No automatic replay of browser actions after a failure | pass | see Part 3 |
| 11 | README states the runtime is not a security sandbox | pass | README top; `docs/SECURITY.md` |

### Part 6 — CLI

| Requirement | Status | Evidence |
| --- | --- | --- |
| `run`, `run --review`, `verify`, `doctor` | pass | §5–§7 |
| `--allowed-domain --prohibited-domain --max-steps --timeout-ms --max-cost-usd --mode --record --json` | pass | `src/cli.ts`; `bu-fast help` |
| `doctor` checks Node, Pi version, Chrome, remote debugging, env set/unset, TypeSafe and text endpoints, workspace writability, telemetry/recording — without leaking credentials | pass | §6 |
| Every command has a clear exit code | pass | 0/1/2/3/4, documented in README and `--help`; 0 and 1 both observed in §7 |

### Part 8 — tests

| # | Required offline test | Test(s) in §3 |
| --- | --- | --- |
| 1 | dynamic action space construction | 11, 12 |
| 2 | TypeSafe response validation | 20 |
| 3 | illegal operation/target rejected | 21, 22, 23 |
| 4 | fingerprint change invalidates the old action | 13, 14 |
| 5 | a stale decision cannot execute | 15, 16 |
| 6 | repeated no-change triggers fallback | 25 |
| 7 | `BLOCKED` triggers fallback | 26, 27 |
| 8 | handoff contains `mustNotRepeat` | 18, 19 |
| 9 | high-risk action requires human confirmation | 32, 33, 39 |
| 10 | domain allow/deny rules | 37 |
| 11 | logs and error messages redact sensitive values | 38 |
| 12 | the page is re-observed after the Pi fallback | 29 |
| 13 | a failing verifier must not report completed | 30, 31 |

Additional offline tests: two-consecutive-stale fallback (28),
credential fields never reach the text model (34), one question per
supported operation (24), deterministic serialisation
(17), unsupported-page routing (35, 36).

Fixture integration coverage (real Chromium + real Pi session):

| Required scenario | Test in §3 |
| --- | --- |
| button click | 2 |
| text input | 3 |
| dropdown select | 4 |
| page change | 2, 9 |
| occluded element | 5 |
| disabled element | 1 |
| page change causing staleness | 6, 7 |
| simulated unsupported control triggering fallback | 8 (plus unit 35, 36) |

No test reaches a real website, a paid API or Browser Use Cloud. If no browser
is installed, the fixture tests skip rather than fail.

---

## 9. Secret-material scan

```text
$ ls -a (root)
. .. .build-test .env.example .gitignore .work LICENSE LICENSES README.md dist docs fixtures node_modules package-lock.json package.json scripts skill src tests tsconfig.build.json tsconfig.json tsconfig.test.json 

$ test -e .env  (a real .env must NOT exist)
absent

$ grep -RInE '(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{12,})' src tests scripts skill docs fixtures README.md .env.example
src/cli.ts:320:    const masked = redactor.redact('token=super-secret-value-123 and Authorization: Bearer abcdefgh12345678');
tests/unit.safety.test.ts:43:    'POST failed for key ts-live-7f3a9b2c4d5e6f70 with header Authorization: Bearer abcd1234efgh5678 ' +
tests/unit.safety.test.ts:44:    'and body {"password":"hunter2-very-secret","token":"sk-proj-ABCDEFGHIJKLMNOP"} at https://u:p@host.test/x';
tests/unit.safety.test.ts:47:  for (const secret of ['ts-live-7f3a9b2c4d5e6f70', 'hunter2-very-secret', 'abcd1234efgh5678', 'sk-proj-ABCDEFGHIJKLMNOP', 'u:p@']) {

$ grep -c '=' .env.example ; values after '=' in .env.example:
TYPESAFE_BASE_URL=https://api.typesafe.ai/v1/systemone
TYPESAFE_MODEL=jev-latest
TEXT_MODEL_BASE_URL=https://api.deepseek.com/v1
TEXT_MODEL=deepseek-chat
TEXT_MODEL_REASONING=low
BUJB_PI_MODEL=openrouter/openai/gpt-5.6-luna
BUJB_PI_REASONING=medium
BUJB_CDP_URL=http://127.0.0.1:9222
BUJB_BROWSER=chrome
BUJB_TELEMETRY=0
DO_NOT_TRACK=1
BUJB_RECORD=0
```

The three matches are synthetic strings inside the redaction test and the
`verify` self-check; they exist precisely to prove that such strings are
masked. No real credential is present anywhere in the tree, and no `.env`
exists.

---

## 10. Structured acceptance summary

```json
{
  "status": "partial",
  "verified": [
    "single Pi session owns the browser, CDP connection, tab and workspace",
    "Jev fast path executes inside Pi's cell against Pi's page binding; no second browser control process",
    "dynamic action space with one index per element and per-operation target sets",
    "TypeSafe operation head + target heads validated strictly; an invalid response executes nothing",
    "a separate small model supplies field text and is never asked for a credential",
    "page fingerprint, whole-page marker and per-node guards all enforced",
    "pre-input re-check of node, visibility, disabled, read-only, viewport and occlusion, in a real browser",
    "post-action re-observation and page-change accounting",
    "BLOCKED, unsupported page, three no-change actions, two consecutive stale decisions, step limit and credential fields all route to Pi",
    "handoff carries goal, currentUrl, completedActions, fallbackReason, mustNotRepeat, stopCondition",
    "no automatic replay of any dispatched browser action",
    "high-risk actions blocked without human approval; --review prompts before every action",
    "domain allow/deny enforced host-side and passed to Pi",
    "telemetry and recording off by default, opt-in only",
    "secrets redacted from audit log, CLI output, doctor output and error messages",
    "an independent verifier gates the completed status; DONE alone never reports completed",
    "npm run check / npm test / npm run build / npm run smoke / bu-fast doctor --json / bu-fast verify all exit 0",
    "39 automated tests pass offline, including 10 real-browser fixture tests against a real Pi session"
  ],
  "partial": [
    "Pi-leg approval is a code-inspection hook (beforeToolCall) plus a prohibition in the handoff prompt, not a semantic action gate; Jev-leg approval gates a resolved element and is exact",
    "freshness comparisons use in-page 64-bit-class digests rather than raw guard tuples, to fit the Pi cell's 1 MB stdout capture limit; a collision could in principle mask a change",
    "the TypeSafe and text-model request/response shapes are ported from jev-ultrafast source and have never been exercised against the live endpoints",
    "unsupported-page detection is heuristic: a page that has a modelled control AND an iframe stays on the fast path"
  ],
  "blocked": [
    "blocked_by_credentials: any online run of the Jev fast path (needs TYPESAFE_API_KEY and TEXT_MODEL_API_KEY)",
    "blocked_by_credentials: any online run of the Pi fallback (needs a provider key such as OPENROUTER_API_KEY)",
    "blocked_by_environment: the macOS machine described in the brief, its Node v26.8.1, its global @browser_use/pi and /opt/homebrew/bin/bu-pi-server were not reachable from the session that built this and were therefore neither inspected nor modified",
    "not_implemented: the MCP server (browser_fast_run/step/approve/verify/cancel). The CLI is complete; the intended MCP interface is specified in README.md and nothing pretends it exists"
  ],
  "commands": [
    "node --version",
    "npm ls --depth=0",
    "npm view @browser_use/pi version engines.node license",
    "npm run check",
    "npm test",
    "npm run build",
    "npm run smoke",
    "node dist/cli.js doctor --json",
    "node dist/cli.js verify",
    "node dist/cli.js verify --audit <fabricated log>   (expected failure, exit 1)"
  ],
  "knownLimitations": [
    "not a sandbox: Pi runs model-authored JavaScript with filesystem and network access",
    "the fallback budget is capped at 3 Pi legs per run, after which the run stops rather than looping",
    "verification depends on evidence being visible on the final page; a goal whose success is not visible returns INSUFFICIENT_EVIDENCE and the run is reported unverified",
    "--review requires a TTY and is refused with --json rather than silently approving",
    "only the listed Chrome/Chromium paths are probed by doctor; set BUJB_CHROME_EXECUTABLE for anything else"
  ]
}
```
