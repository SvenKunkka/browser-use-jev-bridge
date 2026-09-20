# Acceptance evidence

Three passes are recorded here, in order.

- **Pass 1 (MVP)** built the project. Its state is in git at
  `ac80dbd chore: checkpoint claude mvp before acceptance fixes`.
- **Pass 2** is the security-and-truthfulness fix pass, at
  `5dab25a fix(safety): wire the Pi approval hook, make the fallback terminal, unify the budget`.
  It corrects several claims Pass 1 made that were not true — §3, each with the
  evidence that the claim was wrong.
- **Pass 3 — §10 onwards** is the shipping pass: execution states, a real
  run-level deadline, corrected recovery documentation, the MCP server, the
  session manager, and the local Codex installation. **§10 supersedes §9
  wherever they disagree** — most importantly, §9 says the MCP server is
  `not_implemented`; it now ships and is covered by protocol tests.

Command output below is pasted verbatim. Nothing in this file is a claim that
was not produced by a command.

**Two honesty headlines, up front, still true in Pass 3:**

1. **No online API call was made.** No `TYPESAFE_API_KEY`, `TEXT_MODEL_API_KEY`
   or provider key exists in either environment. Every online path is
   `blocked_by_credentials`. The one strictly limited online test that was
   permitted (`https://example.com`, `maxCostUsd <= 0.05`, read-only) was
   therefore **not run**, and no result for it is reported.
2. **No command ran under macOS.** This session reaches the Mac only through
   the Cowork desktop **Linux VM** (Node v22.23.2, aarch64), which mounts the
   real project folder. macOS arm64 / Node v26.8.1 was never executed. Run
   `./scripts/acceptance.sh` on the Mac to produce that record; it writes
   `docs/acceptance-local.txt`.

---

## 1. Where each command ran

| Environment | What it is | Node | Browser |
| --- | --- | --- | --- |
| **A — cloud container** | Anthropic-hosted Linux x86_64 sandbox | v22.22.2 | Chromium present |
| **B — user's machine** | Cowork desktop Linux VM on the Mac, with `/Users/keychron/Projects` mounted; operates on the real files | v22.23.2 (aarch64) | none; the egress policy blocked a Playwright download |
| **C — macOS itself** | not reachable from this session | — | — |

Environment B is the one that touched the delivered files. Its source tree was
verified byte-identical to the delivered tree before the run:

```text
$ ( cd <project> && find src tests fixtures scripts skill docs -type f | sort | xargs sha256sum | sha256sum )
9513158ceb27d59a14781f55af9727152463ae12de5fa044ecc8600b14225528  -
$ ( cd $HOME/verify && find src tests fixtures scripts skill docs -type f | sort | xargs sha256sum | sha256sum )
9513158ceb27d59a14781f55af9727152463ae12de5fa044ecc8600b14225528  -
```

`npm ci` was run in a **copy** under the VM's scratch space, not in the project
folder. The folder's `node_modules` was installed by macOS npm and contains
`@esbuild/darwin-arm64`; running `npm ci` there from Linux would have replaced
it with a Linux build and broken the user's macOS install.

---

## 2. Git

```text
$ git init && git add -A && git commit    # chore: checkpoint claude mvp before acceptance fixes
ac80dbdf899f610053b755ea233137a4652c0b6f
```

`.gitignore` excludes `node_modules/`, `dist/`, `.build-test/`, `.work/` and
`.env` (plus `.env.*` with `!.env.example`). No remote was added and nothing was
pushed. The second, post-fix commit is recorded at the end of this file.

---

## 3. What Pass 1 claimed that was not true

Each row was re-checked against the baseline commit `ac80dbd`.

### 3.1 The Pi approval hook was never installed

```text
$ git archive ac80dbd | tar -x -C ~/baseline && cd ~/baseline
$ grep -rn "beforeToolCall" src/pi/session.ts src/index.ts
  NO MATCH — the hook was never installed
```

`buildBeforeToolCall()` existed but was never passed to `BrowserUse.create`.
Pass 1's SECURITY.md said high-risk code "is blocked by the hook". Nothing was
blocked, because no hook ran.

### 3.2 The hook read fields that do not exist

```text
$ grep -n "toolContext" src/pi/fallback.ts
87:  return async (toolContext: { toolName?: string; arguments?: unknown }) => {
89:      typeof toolContext.arguments === 'string'
91:        : JSON.stringify(toolContext.arguments ?? {});
106:      operation: PI_FALLBACK:${toolContext.toolName ?? 'javascript'},
```

Pi 0.1.0 forwards `@earendil-works/pi-agent-core`'s `BeforeToolCallContext`:
`{ assistantMessage, toolCall, args, context }`. There is no `toolName` and no
`arguments`. Even installed, the old hook would have inspected `undefined` and
matched nothing. A test now asserts both absences at runtime.

### 3.3 Each Pi leg was handed the full budget

```text
$ grep -n "maxSteps: Math.max(1, config.maxSteps)" -A 2 src/index.ts
116:              maxSteps: Math.max(1, config.maxSteps),
117-              timeoutMs: config.timeoutMs,
118-              maxCostUsd: config.maxCostUsd,
```

Not the remainder — the original limits, on every leg.

### 3.4 `.env` did nothing

```text
$ grep -rn "dotenv|loadEnvFile|applyDotEnv" src/
  NO MATCH — .env was never read

$ printf 'TYPESAFE_API_KEY=would-have-worked\n' > .env
$ node ~/baseline/dist/cli.js doctor --json
  .env present, TYPESAFE_API_KEY reported as: unset   <-- the .env was ignored
```

Pass 1's README told the user to `cp .env.example .env`. That instruction did
not work.

### 3.5 `doctor` reported `ok` with no credentials at all

From Pass 1's own recorded output (`ac80dbd:docs/ACCEPTANCE.md` §6):

```text
  "status": ok
  env TYPESAFE_API_KEY   -> unset
  env TEXT_MODEL_API_KEY -> unset
  env OPENROUTER_API_KEY -> unset
```

### 3.6 Unknown flags were silently ignored

```text
$ node ~/baseline/dist/cli.js run --url https://example.com/ --goal g --max-setps 3 --json
  exit=4   (2 would mean "usage error"; the typo was accepted and a browser launch was attempted)
```

### 3.7 No verification thresholds

```text
$ grep -rn "minConfidence|minProbability" src/
  NO MATCH — a 0.01-confidence SATISFIED was accepted as "completed"
```

### 3.8 The handoff was two-way, without the record to justify it

`maybeFallback()` returned a snapshot and the loop did `continue`, so Jev
planned its next click after Pi had acted — while `history` held one synthetic
`PI_FALLBACK` entry and `mustNotRepeat` contained nothing about what Pi had
done. Pass 1's README listed "every dispatched action is carried into any
handoff as `mustNotRepeat`" among its guarantees. That was false for the Pi
leg. The fallback is now terminal, and every document says so.

---

## 4. Verification in environment A (cloud container, with a browser)

### 4.1 Environment

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
+-- @earendil-works/pi-ai@0.85.1
+-- @types/node@22.20.4
`-- typescript@5.9.3
```

### 4.2 `npm run check`

```text

> browser-use-jev-bridge@0.1.0 check
> tsc --noEmit -p tsconfig.json

check exit=0
```

### 4.3 `npm test`

```text
    ok 1 - cli — doctor reports not_ready with no credentials, and exits 4
    ok 2 - cli — doctor --mode fast is not_ready without a TypeSafe key
    ok 3 - cli — doctor --mode fast is partial with TypeSafe but no text model
    ok 4 - cli — doctor loads .env from the working directory
    ok 5 - cli — a real environment variable beats .env
    ok 6 - cli — verify passes offline and exits 0
    ok 7 - cli — a fabricated completed-but-unverified audit log fails verify
    ok 8 - cli — usage errors exit 2 and never start a run
    ok 9 - cli — --review without a terminal is refused rather than silently downgraded
    ok 10 - cli — help exits 0 and documents the terminal fallback
    ok 11 - fixture — the snapshot exposes usable controls and hides disabled ones
    ok 12 - fixture — clicking a button changes the page and the fingerprint
    ok 13 - fixture — typing replaces the field value
    ok 14 - fixture — selecting a dropdown option applies it in the page
    ok 15 - fixture — an occluded control is refused at the last instant
    ok 16 - fixture — a node whose guard changed cannot be clicked
    ok 17 - fixture — a whole-page change invalidates a pending fill
    ok 18 - fixture — an unsupported page is detected from a real observation
    ok 19 - fixture — a full scripted fast-path run reaches a verified completion
    ok 20 - fixture — the domain policy stops a run before the browser is touched
    ok 21 - pi — the hook is installed and receives Pi 0.1.0’s real context shape
    ok 22 - pi — a high-risk tool call is refused by default and the page is untouched
    ok 23 - pi — the same high-risk call executes once a human approves it
    ok 24 - pi — review mode sees every tool call, including the delivery call
    ok 25 - pi — a declined call in review mode stops the leg and changes nothing
    ok 26 - requirement 1 — dynamic action space is built from observed controls only
    ok 27 - an element with no supported operation never enters the space
    ok 28 - regression — two Pi legs cannot each consume the full budget
    ok 29 - the wall clock is a real deadline, not a loop-top check
    ok 30 - a step budget already spent by Jev is not handed to the fallback
    ok 31 - a run that starts with no budget left stops instead of calling Pi
    ok 32 - regression — an unknown flag is a usage error, not silently ignored
    ok 33 - regression — budget flags must be positive numbers
    ok 34 - a single-valued flag given twice is an error; repeatable flags accumulate
    ok 35 - a flag that needs a value must get one
    ok 36 - switches do not swallow the next token and reject values
    ok 37 - doctor readiness is the worst of its parts
    ok 38 - the offline self-check covers every invariant it claims to
    ok 39 - regression — .env is parsed, applied, and never overrides the real environment
    ok 40 - a missing .env is not an error
    ok 41 - the .env parser handles quotes, comments and escapes
    ok 42 - provider credentials are resolved from the model id
    ok 43 - the exit-code mapping is exactly what the docs promise
    ok 44 - requirement 4 — a page change produces a different fingerprint
    ok 45 - requirement 4 — changing the action list alone invalidates the fingerprint
    ok 46 - requirement 5 — a decision made on an older page cannot be executed
    ok 47 - node guards reject a changed control and a changed form-control page key
    ok 48 - stable stringify sorts keys so digests do not depend on property order
    ok 49 - requirement 8 — the handoff lists every action that may already have taken effect
    ok 50 - duplicate executions are listed once
    ok 51 - the hook reads the real Pi context shape (toolCall.name and args)
    ok 52 - a high-risk Pi cell is blocked when nobody can approve it
    ok 53 - review mode gates every Pi tool call, not just the risky-looking ones
    ok 54 - an approved high-risk Pi cell proceeds
    ok 55 - a denied Pi tool call ends the run as stopped_by_approval
    ok 56 - a consequential goal needs approval before Pi is even started
    ok 57 - requirement 2 — a well-formed TypeSafe answer is accepted
    ok 58 - requirement 3 — malformed or illegal answers are rejected and nothing executes
    ok 59 - requirement 3 — a target head naming an element that was not offered is refused
    ok 60 - the operation head decides which target head is validated
    ok 61 - the request carries one question per supported operation and never a raw DOM dump
    ok 62 - requirement 6 — three actions with no page change hand the task to Pi
    ok 63 - requirement 7 — BLOCKED hands the task to Pi instead of guessing
    ok 64 - requirement 7 — BLOCKED with no fallback available stops instead of continuing
    ok 65 - two consecutive stale decisions hand the task to Pi
    ok 66 - requirement 12 — the Pi fallback is terminal: re-observe, verify, stop
    ok 67 - requirement 13 — a DONE claim that fails verification is never reported as completed
    ok 68 - requirement 13 — with no verifier configured the run is unverified, not completed
    ok 69 - requirement 9 — an unapproved high-risk action stops the run before anything is dispatched
    ok 70 - an approved high-risk action does execute, and is recorded as high risk
    ok 71 - a credential-like field is never filled by the text model
    ok 72 - unsupported-page detection routes iframes, canvas, shadow DOM, popups and uploads to Pi
    ok 73 - an unsupported page is handed over before any action is attempted
    ok 74 - requirement 10 — domain allow and deny rules
    ok 75 - requirement 11 — secrets never survive into logs or error messages
    ok 76 - requirement 9 — high-risk actions require human confirmation and are denied without one
    ok 77 - every threshold satisfied — the run may be reported completed
    ok 78 - SATISFIED with low confidence is not verified
    ok 79 - SATISFIED with low probability mass is not verified
    ok 80 - high confidence cannot rescue a failed deterministic check
    ok 81 - an observation taken before the completion claim cannot confirm it
    ok 82 - a verifier that cannot be reached leaves the run unverified, never completed

# tests 82
# suites 0
# pass 82
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 26941.277851
test exit=0
```

### 4.4 `npm run build`

```text
> browser-use-jev-bridge@0.1.0 build
> node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})" && tsc -p tsconfig.build.json
build exit=0
```

### 4.5 `npm run smoke`

Output is now split by leg, and the Pi sections are real: a scripted `streamFn`
drives Pi's own agent loop, so a genuine `javascript` tool call is produced and
the approval hook is invoked by Pi itself.

```text
INFO  chrome at http://127.0.0.1:33527, workspace /tmp/bujb-smoke-4xfYCC
PASS  [jev] fast path reaches a verified completion
PASS  [jev] the occlusion guard stops a covered click in a real page
PASS  [verifier] a weak SATISFIED is not reported as completed
PASS  [pi] a real Pi fallback leg runs with its approval hook installed
PASS  [approval] a high-risk Pi tool call is refused and the page is untouched
PASS  [approval] the same call proceeds once a human approves it
smoke: ok in 2254 ms
smoke exit=0
```

### 4.6 `bu-fast verify`

```text
PASS  dynamic action space: 3 elements, CLICK/TYPE_TEXT/SELECT target groups, WAIT control
PASS  TypeSafe response validation: 1 valid accepted, 5 invalid rejected
PASS  stale decision cannot execute: fingerprint change invalidates the pending decision
PASS  high-risk actions require approval: purchase/submit labels and purchase intents gated; navigation labels not
PASS  domain allow/deny rules: apex + wildcard allowed, denial wins, others refused
PASS  secret redaction: registered values and bearer tokens masked
PASS  text helper output validation: 1 valid accepted, 4 invalid rejected
PASS  handoff carries mustNotRepeat: Jev actions listed once; idempotent actions excluded (Pi-internal actions are not enumerated)
PASS  budget is not reset between fallbacks: two fallbacks consume one budget; the deadline is enforced

9/9 checks passed
verify exit=0
```

### 4.7 `bu-fast doctor --mode … --json`

| Mode | status | legs | exit |
| --- | --- | --- | --- |
| `fast` | `not_ready` | fast=`not_ready`, pi=`not_ready` | 4 |
| `hybrid` | `not_ready` | fast=`not_ready`, pi=`not_ready` | 4 |
| `pi` | `not_ready` | fast=`not_ready`, pi=`not_ready` | 4 |

First blocker reported for each mode:

```text
fast   : TYPESAFE_API_KEY is unset, so --mode fast cannot run.
hybrid : Neither the Jev fast path nor the Pi fallback has usable credentials.
pi     : No credential for the Pi model's provider "openrouter" (OPENROUTER_API_KEY).
```

Full `--mode hybrid` report:

```json
{
  "status": "not_ready",
  "mode": "hybrid",
  "platform": "linux 6.18.44-fc-v37",
  "node": "v22.22.2",
  "legs": {
    "fast": "not_ready",
    "pi": "not_ready"
  },
  "blockers": [
    "Neither the Jev fast path nor the Pi fallback has usable credentials."
  ],
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
      "detail": "not configured (no BUJB_CDP_URL); Pi would launch or attach at run time \u2014 NOT verified here",
      "required": false
    },
    {
      "name": "fast path credentials",
      "passed": false,
      "detail": "TYPESAFE_API_KEY unset; TEXT_MODEL_API_KEY unset \u2014 the Jev fast path cannot make a decision without TypeSafe",
      "required": true
    },
    {
      "name": "pi fallback credentials",
      "passed": false,
      "detail": "model openrouter/openai/gpt-5.6-luna \u2192 provider \"openrouter\"; candidates OPENROUTER_API_KEY; unset",
      "required": true
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
      "name": "env BROWSER_USE_API_KEY",
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
      "detail": "https://api.typesafe.ai/v1/systemone (model jev-latest, key unset) \u2014 not contacted",
      "required": false
    },
    {
      "name": "text model endpoint",
      "passed": true,
      "detail": "https://api.deepseek.com/v1 (model deepseek-chat, key unset) \u2014 not contacted",
      "required": false
    },
    {
      "name": "workspace writable",
      "passed": true,
      "detail": "/home/claude/browser-use-jev-bridge/.work is writable",
      "required": true
    },
    {
      "name": "dotenv",
      "passed": true,
      "detail": "/home/claude/browser-use-jev-bridge/.env: not present",
      "required": false
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
    },
    {
      "name": "verification thresholds",
      "passed": true,
      "detail": "minConfidence 0.8, minProbability 0.8",
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
    "verification": {
      "minConfidence": 0.8,
      "minProbability": 0.8
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

### 4.8 `npm audit --omit=dev`

```text
found 0 vulnerabilities
audit exit=0
```

---

## 5. Verification in environment B (the user's machine, Linux VM)

Run against the real, delivered files.

```text
$ node --version
v22.23.2
$ npm --version
10.9.8
$ uname -sm
Linux aarch64

$ npm ci
added 234 packages in 1m
exit=0

$ npm run check
exit=0

$ npm run build
exit=0

$ npm test
# tests 82
# pass 67
# fail 0
# skipped 15        <- the browser-backed tests; no Chrome in this VM
exit=0

$ npm run smoke
SKIP  no Chrome/Chromium found; set BUJB_TEST_CHROME to run the smoke test
exit=2               <- the documented "no browser" code, not a failure

$ node dist/cli.js verify
9/9 checks passed
exit=0

$ node dist/cli.js doctor --mode hybrid --json
status: not_ready | legs: {'fast': 'not_ready', 'pi': 'not_ready'}
blockers:
  - No Chrome/Chromium was found; set BUJB_CHROME_EXECUTABLE or install one.
  - Neither the Jev fast path nor the Pi fallback has usable credentials.
exit=4

$ npm audit --omit=dev
found 0 vulnerabilities
exit=0
```

An attempt to install a browser in that VM was refused by the account's egress
policy, so the browser tests could not run there:

```text
$ npx playwright install chromium
Error: Failed to download Chromium 131.0.6778.33 ... Download failure, code=1
```

Those 15 tests all pass in environment A, and will run on macOS where Chrome is
installed.

---

## 6. Fix map

| Brief | Fixed | Where | Proof |
| --- | --- | --- | --- |
| §2.1 derive the `beforeToolCall` type | yes | `PiBeforeToolCall` in `src/pi/fallback.ts`, from `Parameters<typeof BrowserUse.create>[0]` | compiles; an upstream rename now breaks the build |
| §2.2 actually pass the hook | yes | `PiSession.create` → `create.beforeToolCall`, wired in `runTask` | integration test "the hook is installed and receives Pi 0.1.0's real context shape" |
| §2.3 read `context.args` / `context.toolCall.name` | yes | `PiApprovalController.hook` | the same test asserts `toolName` and `arguments` are absent |
| §2.4 default mode gates high-risk Pi calls and blocks with no approver | yes | `PiApprovalController` + `DenyHighRiskGate` | "a high-risk tool call is refused by default and the page is untouched" |
| §2.5 `--review` gates every Pi tool call | yes | the `review` branch in the hook | "review mode sees every tool call, including the delivery call" |
| §2.6 assess goal / handoff intent before the leg | yes | `concludeViaFallback` → `assessRisk({ intent: goal })` | "a consequential goal needs approval before Pi is even started" |
| §2.7 denial ⇒ no action, audit record, `stopped_by_approval`, exit 3 | yes | hook aborts the leg; router returns `stopped_by_approval`; `exitCodeForOutcome` | "a denied Pi tool call ends the run as stopped_by_approval" and "the exit-code mapping is exactly what the docs promise" |
| §2.8 no prompt-only controls | yes | the intent gate and `--review` are code paths, not prompt text | — |
| §3 terminal fallback | yes | `HybridRouter.concludeViaFallback` returns a `RunOutcome` | "the Pi fallback is terminal: re-observe, verify, stop" — a third scripted decision would throw if Jev resumed |
| §3 correct the false claims | yes | README, SKILL.md, ARCHITECTURE.md, SECURITY.md | §3 above |
| §4 unified budget | yes | `src/budget.ts`, threaded through the router | "two Pi legs cannot each consume the full budget", "a step budget already spent by Jev is not handed to the fallback", "the wall clock is a real deadline" |
| §4 AbortSignal deadline | yes | `BudgetTracker.deadlineSignal`; `runFallback` composes it into `options.signal` | — |
| §5 working `.env` | yes | `applyDotEnv` in `src/config.ts`, called by the CLI only | ".env is parsed, applied, and never overrides the real environment"; CLI tests 4 and 5 |
| §6 doctor readiness | yes | `--mode`, `ready/partial/not_ready`, per-leg credentials, real CDP probe | CLI tests 1–3, and §4.7 |
| §7 verifier thresholds | yes | `src/verification/verifier.ts` plus `BUJB_VERIFY_MIN_*` | four threshold tests and the claim-freshness test |
| §8 CLI validation | yes | spec-driven `parseArguments` | five parser tests and "usage errors exit 2" |
| §9 real Pi fallback tests | yes | `tests/integration.pi-fallback.test.ts` | 5 tests: real Pi loop, real browser |
| §9 fix the false smoke claim | yes | `scripts/smoke.mjs` rewritten with `[jev] [verifier] [pi] [approval]` sections | §4.5 |
| §10 acceptance evidence | yes | this file, plus `scripts/acceptance.sh` for the macOS record | — |

### Tests added in this pass

```text
tests/unit.budget.test.ts
  regression — two Pi legs cannot each consume the full budget
  the wall clock is a real deadline, not a loop-top check
  a step budget already spent by Jev is not handed to the fallback
  a run that starts with no budget left stops instead of calling Pi

tests/unit.verification.test.ts
  every threshold satisfied — the run may be reported completed
  SATISFIED with low confidence is not verified
  SATISFIED with low probability mass is not verified
  high confidence cannot rescue a failed deterministic check
  an observation taken before the completion claim cannot confirm it
  a verifier that cannot be reached leaves the run unverified, never completed

tests/unit.pi-approval.test.ts
  the hook reads the real Pi context shape (toolCall.name and args)
  a high-risk Pi cell is blocked when nobody can approve it
  review mode gates every Pi tool call, not just the risky-looking ones
  an approved high-risk Pi cell proceeds
  a denied Pi tool call ends the run as stopped_by_approval
  a consequential goal needs approval before Pi is even started

tests/unit.cli.test.ts
  regression — an unknown flag is a usage error, not silently ignored
  regression — budget flags must be positive numbers
  a single-valued flag given twice is an error; repeatable flags accumulate
  a flag that needs a value must get one
  switches do not swallow the next token and reject values
  doctor readiness is the worst of its parts
  the offline self-check covers every invariant it claims to
  regression — .env is parsed, applied, and never overrides the real environment
  a missing .env is not an error
  the .env parser handles quotes, comments and escapes
  provider credentials are resolved from the model id
  the exit-code mapping is exactly what the docs promise

tests/integration.pi-fallback.test.ts
  pi — the hook is installed and receives Pi 0.1.0's real context shape
  pi — a high-risk tool call is refused by default and the page is untouched
  pi — the same high-risk call executes once a human approves it
  pi — review mode sees every tool call, including the delivery call
  pi — a declined call in review mode stops the leg and changes nothing

tests/integration.cli.test.ts
  cli — doctor reports not_ready with no credentials, and exits 4
  cli — doctor --mode fast is not_ready without a TypeSafe key
  cli — doctor --mode fast is partial with TypeSafe but no text model
  cli — doctor loads .env from the working directory
  cli — a real environment variable beats .env
  cli — verify passes offline and exits 0
  cli — a fabricated completed-but-unverified audit log fails verify
  cli — usage errors exit 2 and never start a run
  cli — --review without a terminal is refused rather than silently downgraded
  cli — help exits 0 and documents the terminal fallback

tests/unit.router.test.ts (rewritten for the new semantics)
  requirement 12 — the Pi fallback is terminal: re-observe, verify, stop
```

Two Pass-1 tests changed meaning rather than being deleted: the `no_progress`
and `BLOCKED` tests no longer script a Jev decision after the fallback, because
a Jev decision after a fallback is now impossible. The scripted client throws
when asked for one, which is what makes the terminal-fallback assertion real.

### A bug the new tests found

`cli — doctor --mode fast is partial …` failed the first time it ran from a
temporary working directory: `doctor` resolved `@browser_use/pi/package.json`
relative to `process.cwd()`, so it reported "@browser_use/pi is not installed"
for every invocation outside the project folder. That package's `exports` map
has no `require` condition and does not expose `./package.json`, so neither
`require.resolve` nor `import.meta.resolve` can find it; the manifest is now
located by walking up to `node_modules/@browser_use/pi/package.json`.

---

## 7. Secret-material scan

```text
$ grep -RInE '(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{12,})' src tests scripts skill docs README.md .env.example
src/cli.ts:456:    const masked = redactor.redact('token=super-secret-value-123 and Authorization: Bearer abcdefgh12345678');
tests/unit.safety.test.ts:43-47: synthetic strings inside the redaction test
$ test -e .env && echo PRESENT || echo absent
absent
```

Every match is a synthetic string that exists to prove such strings are masked.
`doctor --json` contains no `"apiKey"` value other than `set` / `unset`, and no
provider-key-shaped string.

---

## 8. Still not verified

- **Online.** `blocked_by_credentials`. The TypeSafe and text-model
  request/response shapes are ported from jev-ultrafast source and have never
  met the live endpoints. The Pi leg has never run against a real provider.
- **macOS-native.** `blocked_by_environment`. Nothing ran under macOS arm64 or
  Node v26.8.1. `./scripts/acceptance.sh` produces that record in one command.
- **Browser tests on the user's machine.** Skipped for lack of a browser in the
  desktop VM; they pass in the cloud container.
- **MCP.** Not implemented, by instruction. The interface sketch in README.md is
  a proposal, not a shipped feature.

---

## 9. Structured acceptance summary

```json
{
  "status": "partial",
  "phase": "acceptance-fix pass (P0/P1/P2)",
  "verified": [
    "Pi beforeToolCall is passed to BrowserUse.create, and its type is derived from that call's own parameter type",
    "the hook reads Pi 0.1.0's real context (context.toolCall.name, context.args), asserted at runtime while the real Pi agent loop drives it",
    "a high-risk Pi tool call is refused by default, the leg is aborted, and the fixture page is provably unchanged",
    "the same call executes once a human approves it, and the page provably changes",
    "--review gates every Pi tool call including the delivery call, not only regex matches",
    "a consequential goal is refused before Pi is started at all",
    "a refused call ends the run as stopped_by_approval, which maps to exit code 3",
    "the Pi fallback is terminal: re-observe, verify, stop; no Jev decision follows a Pi leg",
    "history and every document no longer claim Pi's internal actions are enumerated",
    "one BudgetTracker covers Jev steps, Pi steps, wall clock and cost; a leg is offered only the remainder",
    "the wall-clock deadline is bound to an AbortSignal handed to the Pi run",
    "budget exhaustion maps to step_limit / timeout / cost_limit and is reported in the outcome and the audit log",
    ".env is loaded by the CLI, never overrides the process environment, and reports names only",
    "doctor has --mode fast|hybrid|pi and returns ready / partial / not_ready with blockers, exiting 4 on not_ready",
    "doctor returns not_ready in the real credential-free environment, where Pass 1 returned ok",
    "doctor probes BUJB_CDP_URL when set, and says NOT verified when it is not set",
    "verification requires SATISFIED plus confidence, probability and an observation taken after the claim",
    "unknown flags, non-positive budgets, duplicate flags, missing values and unparsable URLs are usage errors (exit 2)",
    "82 automated tests pass in the cloud container, including 5 real Browser Use Pi fallback tests and 10 CLI process tests",
    "the same 82 tests run on the user's machine (desktop Linux VM): 67 pass, 15 skipped for lack of a browser, 0 fail",
    "npm audit --omit=dev reports 0 vulnerabilities",
    "a baseline commit and a fixes commit exist locally; nothing was pushed"
  ],
  "partial": [
    "the third Pi approval layer is still a pattern match over generated JavaScript; the intent check and --review are the layers that do not depend on it",
    "cost accounting covers Pi legs only - the TypeSafe and text-model endpoints do not return a price, so fast-path calls consume steps and time but add 0 to the cost total",
    "verification is an independent call, not an independent model: same TypeSafe provider and model id as the decision heads",
    "doctor's provider-to-environment-variable table is local, because pi-ai's findEnvKeys is not in that package's exports; an unknown provider falls back to <PROVIDER>_API_KEY and doctor says so",
    "freshness comparisons still use in-page 64-bit-class digests, to fit the Pi cell's 1 MB stdout capture limit"
  ],
  "blocked": [
    "blocked_by_credentials: any online run of the Jev fast path (needs TYPESAFE_API_KEY and TEXT_MODEL_API_KEY)",
    "blocked_by_credentials: any online run of the Pi fallback against a real provider (needs e.g. OPENROUTER_API_KEY)",
    "blocked_by_environment: macOS-native execution. This session reaches the Mac only through the Cowork desktop Linux VM (Node v22.23.2, aarch64), not macOS itself, so nothing ran under macOS arm64 / Node v26.8.1. Run ./scripts/acceptance.sh on the Mac to produce that record.",
    "blocked_by_environment: browser-backed tests on the user's machine. The desktop VM has no Chrome and its egress policy blocked the Playwright download, so 15 browser tests skipped there; they all pass in the cloud container.",
    "not_implemented: the MCP server. Out of scope for this pass, as instructed."
  ],
  "commands": [
    "git init; git add -A; git commit (baseline, then fixes)",
    "npm ci",
    "npm run check",
    "npm test",
    "npm run build",
    "npm run smoke",
    "node dist/cli.js verify",
    "node dist/cli.js doctor --mode fast|hybrid|pi --json",
    "npm audit --omit=dev",
    "git status --short",
    "git log --oneline -n 3"
  ],
  "knownLimitations": [
    "not a sandbox: Pi runs model-authored JavaScript with filesystem and network access",
    "the Jev to Pi handoff is one-way; a run that reaches Pi ends there",
    "unsupported-page detection is heuristic",
    "a goal whose success is not visible on the final page returns INSUFFICIENT_EVIDENCE and is reported unverified"
  ]
}
```

---

# Pass 3 — shipping

## 10. What Pass 3 changed

Three correctness defects and one missing surface, in the order the brief
listed them.

### 10.1 An action was only recorded once it had succeeded

`executeStep` created its `ActionRecord` *after* `executor.act()` returned. Any
failure inside `act()` — a `page.evaluate` that never came back, a CDP batch
that applied some commands and then threw, a SELECT whose change handler
navigated the page away — produced **no history entry at all**, so the run
reported that nothing had been dispatched when something may well have been.

Fixed by making execution phases explicit and first-class:

```ts
export type ExecutionPhase =
  | 'preflight_failed'   // guards refused; nothing reached the page
  | 'dispatch_started'   // the first operation that could have an effect has begun
  | 'dispatched'         // the operation returned
  | 'effect_uncertain'   // it may or may not have taken effect
  | 'observed';          // the page was re-read afterwards
```

`JevExecutor.act()` takes an `onPhase` callback and emits
`dispatch_started` **before** the first possibly-side-effecting operation —
for SELECT that is the in-page script (it assigns the value and fires
`input`/`change` before it can report back), for CLICK and fill it is the CDP
batch. The router opens the `ActionRecord` on the first non-preflight phase and
pushes it into `history` immediately, so a record exists before the operation
can fail. Every phase is also written to the audit log as an `execution_phase`
record.

An `effect_uncertain` action is treated as having happened: it is counted
against the budget, carried into `mustNotRepeat`, surfaced in
`RunOutcome.uncertainActions` and in MCP `status`, and never retried or
re-planned. A `preflight_failed` action is the only one the run is allowed to
consider safe to re-plan.

Covered by `tests/unit.execution-phase.test.ts` (8 tests), including a real
`<select>` whose change handler calls `location.replace()` mid-mutation
(`fixtures/volatile.html`) and a CDP batch that succeeds part-way and then
fails.

### 10.2 `--timeout-ms` was not a run-level deadline

It bounded the router's own loop, not the calls inside it. A hanging
`page.evaluate`, TypeSafe request, retry backoff, text-model call, Pi leg or
verifier could outlive it indefinitely.

`BudgetTracker.createRunSignal()` now derives one `AbortSignal` from the
remaining wall clock and composes it with the caller's, and that signal is
threaded through every stage: the initial `goto`, observation, tab-count and
freshness probes, page evaluation and CDP, TypeSafe requests **and their retry
waits**, text-model requests, Jev dispatch, the Pi leg, the re-observation
after it, and the final verification call. Cleanup gets its own separate
allowance (`BUJB_CLEANUP_MS`, default 10 s) so closing is never truncated.

A deadline that fires reports `timeout`, a caller abort reports `cancelled`,
and a deadline that fires *during* dispatch produces `effect_uncertain` rather
than a claim that nothing ran. `run()` is now a thin wrapper that always writes
`run_end` and always returns a structured `RunOutcome`, even on an unhandled
exception.

Covered by `tests/unit.deadline.test.ts` (9 tests), all in tens of
milliseconds — no test waits out a real timeout.

### 10.3 The documentation gave unsafe re-run advice

Pass 2 shipped three claims that were wrong and dangerous:

> "the page is left as it was" · "stopped_by_approval — nothing was
> dispatched" · "Safe to re-run with --review"

Only the **declined action** is known not to have executed. Earlier steps in
the same run may already have changed the page, and if the run reached Browser
Use Pi, that leg's internal actions are not enumerated at all. All three
phrasings are gone from `README.md`, `docs/SECURITY.md`,
`docs/ARCHITECTURE.md` and `skill/SKILL.md`, replaced by: read the live page,
`history`/`steps` and the audit log first; treat everything in
`uncertainActions` as having happened; only an empty `history` shows that
nothing was dispatched.

`tests/unit.docs.test.ts` is a regression test over the shipped documents: it
fails the build if any of the banned phrasings comes back, and asserts that
every document states that Pi's internal actions are not enumerated.

### 10.4 The MCP server

New second front end, `bu-fast-mcp` (`src/mcp/`, built to `dist/mcp/`), on the
official `@modelcontextprotocol/sdk`, pinned at **1.30.0**. Stdio transport;
**stdout carries JSON-RPC and nothing else** — every log, warning and
diagnostic goes to stderr, and `BrowserUse.create` is given `log: false` so Pi
cannot print into the protocol stream either.

Seven tools: `browser_fast_doctor`, `browser_fast_start` (async; returns a
`sessionId` immediately), `browser_fast_status`, `browser_fast_approve`,
`browser_fast_cancel`, `browser_fast_verify`, `browser_fast_list_sessions`.
Schemas are zod `.strict()`, so unknown fields are refused rather than ignored,
and **no tool accepts an API key, token, cookie or Authorization header** —
there is no such input to smuggle one through. Full reference in
[`MCP.md`](MCP.md).

`SessionManager` (`src/mcp/session-manager.ts`) owns lifecycle and nothing
else: at most one active browser task by default, cryptographically random
`bfh_`/`apr_` ids, one pending approval per session, single-use approval ids,
approval waits that **time out into a denial**, a TTL sweep for finished
sessions, and idempotent cancellation that resolves pending approval promises,
closes the Pi session and clears every timer. SIGINT, SIGTERM, stdin close and
transport close all route to the same `close()`.

CLI and MCP share one core. `runTask`, the approval policy, the deadline, the
audit log, the redactor and the verifier are the same objects in both; MCP adds
session lifecycle and the cross-call approval channel and subtracts nothing.
`tests/unit.cli.test.ts` asserts that the CLI exit code and the MCP session
state agree for every outcome status.

---

## 11. Pass 3 in environment A (cloud container, with a browser)

```text
$ node --version && npm --version && uname -sm
v22.22.2
10.9.4
Linux x86_64
```

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | 0 | added 326 packages |
| `npm run check` | 0 | `tsc --noEmit` over `src` and `tests`, clean |
| `npm test` | 0 | **116 / 116 pass, 0 fail, 0 skipped** |
| `npm run build` | 0 | `dist/` emitted, including `dist/mcp/main.js` |
| `npm run smoke` | 0 | 10 checks across `[jev] [verifier] [pi] [approval] [mcp]` |
| `node dist/cli.js verify` | 0 | 9 / 9 offline invariants |
| `node scripts/mcp-handshake.mjs` | 0 | real `bu-fast-mcp`, 7 tools, stdout clean |
| `node dist/cli.js doctor --mode fast --json` | 4 | `not_ready` — no credentials |
| `node dist/cli.js doctor --mode hybrid --json` | 4 | `not_ready` — no credentials |
| `node dist/cli.js doctor --mode pi --json` | 4 | `not_ready` — no credentials |
| `npm audit --omit=dev` | 0 | found 0 vulnerabilities |
| `npm pack --dry-run --json` | 0 | 97 entries, 164 kB packed, 617 kB unpacked |

### 11.1 `npm test` — 116 tests

```text
1..116
# tests 116
# suites 0
# pass 116
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 83679.73634
```

The 13 MCP tests, verbatim from the TAP output:

```text
ok 21 - mcp — initialize and listTools expose every tool with an input schema
ok 22 - mcp — bad inputs are refused before anything starts
ok 23 - mcp — start, poll, complete
ok 24 - mcp — review mode routes every action through the approval channel
ok 25 - mcp — a high-risk action pauses without review, and declining stops the run
ok 26 - mcp — an unanswered approval times out as a denial
ok 27 - mcp — cancel is idempotent and releases the session
ok 28 - mcp — only one browser task may run at a time
ok 29 - mcp — a finished session expires after its TTL
ok 30 - mcp — an uncertain action is visible in status, history and the audit log
ok 31 - mcp — a real Pi fallback leg runs, is gated, and is terminal
ok 32 - mcp — a disconnecting client leaves nothing running
ok 33 - mcp — the production entry point writes only JSON-RPC to stdout
```

The execution-phase and deadline tests:

```text
ok 58 - the deadline aborts a hanging browser observation and the run reports timeout
ok 59 - the deadline aborts a hanging TypeSafe request
ok 60 - the deadline aborts a hanging text-model request
ok 61 - the deadline aborts a hanging Jev action, and the action is treated as uncertain
ok 62 - the deadline aborts a hanging Pi fallback leg
ok 63 - the deadline aborts a hanging verifier
ok 64 - caller cancellation is reported as cancelled, not timeout
ok 65 - retry backoff is interruptible
ok 66 - an unhandled failure still produces a structured outcome with run_end
ok 67 - regression — no document claims a stopped run left the page untouched
ok 68 - regression — the documents state the correct recovery semantics
ok 69 - every document mentions that Pi internal actions are not enumerated
ok 70 - a guard failure is a preflight failure — nothing was dispatched
ok 71 - a SELECT interrupted mid-mutation is effect_uncertain, not "not executed"
ok 72 - a SELECT that cannot confirm is effect_uncertain
ok 73 - a click whose CDP batch fails part-way is effect_uncertain
ok 74 - a successful click reports dispatch_started then dispatched
ok 75 - wait and scroll report phases but never claim a possible side effect
ok 76 - regression — an uncertain action lands in history and audit, and is never re-planned
ok 77 - a preflight failure is still safe to re-plan
```

**What is real in these tests.** The MCP transport, the SDK client and server,
the session manager, the approval channel, the router, the safety layers, the
Browser Use Pi agent loop and Chromium on local `file://` fixtures are all the
real components. The only substitutions are the two paid model endpoints
(TypeSafe and the text helper), which are driven by deterministic scripts, and
Pi's provider request, which is a scripted `streamFn` built on `pi-ai`'s public
`utils/event-stream` subpath. Pi's default transport is one that throws, so the
agent loop physically cannot reach a provider.

### 11.2 `npm run smoke`

```text
INFO  chrome at http://127.0.0.1:37329, workspace /tmp/bujb-smoke-s7gVgt
PASS  [jev] fast path reaches a verified completion
PASS  [jev] the occlusion guard stops a covered click in a real page
PASS  [verifier] a weak SATISFIED is not reported as completed
PASS  [pi] a real Pi fallback leg runs with its approval hook installed
PASS  [approval] a high-risk Pi tool call is refused and the page is untouched
PASS  [approval] the same call proceeds once a human approves it
PASS  [mcp] initialize and listTools over a real stdio transport
PASS  [mcp] start -> awaiting_approval -> approve -> completed
PASS  [mcp] declining stops the run and the declined action never executes
PASS  [mcp] cancel is idempotent and leaves nothing pending

smoke: ok in 11419 ms
```

### 11.3 MCP startup, initialize and listTools against the shipped entry point

`scripts/mcp-handshake.mjs` spawns `dist/mcp/main.js` — the binary Codex will
run, not a test double — over a real stdio transport with the official SDK
client, and separately over raw pipes to prove stdout purity.

```text
PASS  initialize + tools/list: browser_fast_approve, browser_fast_cancel, browser_fast_doctor, browser_fast_list_sessions, browser_fast_start, browser_fast_status, browser_fast_verify
PASS  every tool publishes a description and an object input schema
PASS  browser_fast_doctor over MCP: status=not_ready fast=not_ready pi=not_ready
PASS  an invalid start request is refused
PASS  stdout carried only JSON-RPC (2 frames, raw pipe)

mcp handshake: ok
```

### 11.4 `npm audit --omit=dev` and `npm pack --dry-run --json`

```text
$ npm audit --omit=dev
found 0 vulnerabilities
exit=0

$ npm pack --dry-run --json
entryCount 97  size 164267  unpackedSize 617483
exit=0
```

The packed file list contains `dist/`, `skill/`, `docs/`, `README.md` and
`LICENSES/` only. No `.env`, no audit log, no browser profile, no recording.

---

## 12. Pass 3 in environment B (the user's machine, Linux VM)

Environment B is the Cowork desktop Linux VM, which mounts the real
`/Users/keychron/Projects` and `/Users/keychron/.codex`. It is the environment
that touched the delivered files and the real Codex configuration. It has **no
Chrome**, and its egress policy allows only the npm registry, so the
browser-backed tests skip there.

```text
$ node --version && npm --version && uname -sm
v22.23.2
10.9.8
Linux aarch64
```

`npm ci` was run in a scratch copy at `$HOME/accept`, never in the delivered
folder, so the macOS-native `node_modules` there was not overwritten.

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | 0 | added 326 packages |
| `npm run check` | 0 | clean |
| `npm test` | 0 | 116 tests — **88 pass, 0 fail, 28 skipped** (all skips: no Chrome) |
| `npm run build` | 0 | `dist/` emitted |
| `npm run smoke` | **2** | `SKIP no Chrome/Chromium found` — the documented skip code |
| `node dist/cli.js verify` | 0 | 9 / 9 |
| `node scripts/mcp-handshake.mjs` | 0 | 7 tools, stdout clean — needs no browser |
| `node dist/cli.js doctor --mode hybrid --json` | 4 | `not_ready`: no Chrome, no credentials |
| `npm audit --omit=dev` | 0 | found 0 vulnerabilities |
| `npm pack --dry-run --json` | 0 | 97 entries |
| `./scripts/install-local.sh --dry-run` | 0 | see §13 |
| `./scripts/install-local.sh` | 0 | see §13 |
| `./scripts/doctor-local.sh` | 0 | see §13 |
| `git status --short` | 0 | see §15 |

```text
$ node dist/cli.js doctor --mode hybrid --json | head -14
{
  "status": "not_ready",
  "mode": "hybrid",
  "platform": "linux 6.8.0-138-generic",
  "node": "v22.23.2",
  "legs": {
    "fast": "not_ready",
    "pi": "not_ready"
  },
  "blockers": [
    "No Chrome/Chromium was found; set BUJB_CHROME_EXECUTABLE or install one.",
    "Neither the Jev fast path nor the Pi fallback has usable credentials."
  ],
```

That is the honest answer the brief asked for: with no credentials, `doctor`
returns `not_ready`, lists only the **names** of what is missing, and exits 4.

### 12.1 Completing the delivered `node_modules` for macOS

The delivered folder's `node_modules` was installed on macOS in an earlier pass
and did not contain the MCP SDK, which is new in Pass 3. `npm ci` could not be
run there from this Linux VM without replacing `@esbuild/darwin-arm64` with a
Linux binary and breaking the Mac's build.

What was done instead: the 117 lock entries missing from that tree were split
by the lock's own `os`/`cpu`/`hasInstallScript` metadata. 25 were `@esbuild/*`
packages for other platforms, which are *correctly* absent on macOS arm64 and
were left alone. The other **92 are pure JavaScript with no platform
constraints and no install scripts** — the `@modelcontextprotocol/sdk` closure
— and were materialised into the tree, then verified against the lock:

```text
checked 322 mismatches 0
still missing (non-platform): 0
platform packages present (top level): node_modules/@esbuild/darwin-arm64
node_modules/@esbuild/darwin-arm64/bin/esbuild: Mach-O 64-bit arm64 executable
```

Every non-platform package in `package-lock.json` is present at exactly the
locked version, and the only top-level platform binary is still the Mach-O
arm64 one. `npm ci` on macOS remains the canonical route and will reproduce the
same tree; running it is not required for the installation to work.

`npm run build` then ran against the delivered folder (exit 0) and produced
`dist/mcp/main.js`; `tsc` output is platform-independent.

### 12.2 Why the browser-backed tests skip here

```text
$ curl -o /dev/null --max-time 20 https://cdn.playwright.dev/
curl: (56) Received HTTP code 403 from proxy after CONNECT
$ curl -o /dev/null --max-time 20 https://registry.npmjs.org/
200
```

Only the npm registry is reachable from this VM, and no npm package ships a
Linux-aarch64 Chromium binary inside its tarball. This is
`blocked_by_environment`, not a test failure: the same 28 tests all pass in
environment A. To produce the record on macOS itself, run
`./scripts/acceptance.sh` on the Mac.

---

## 13. The local Codex installation

### 13.1 The real Codex configuration, inspected rather than guessed

```text
$ grep -n "^\[mcp_servers\|^\[plugins" ~/.codex/config.toml
...
88:[plugins."browser@openai-bundled"]
529:[mcp_servers.node_repl]
551:[mcp_servers.computer-use]
557:[mcp_servers.openaiDeveloperDocs]
560:[mcp_servers.open-knowledge]
```

Two facts decided the design. `browser` is a **bundled plugin**
(`[plugins."browser@openai-bundled"]`), not an MCP server, so registering a new
`[mcp_servers.…]` entry cannot collide with it. And skills live as
`~/.codex/skills/<name>/SKILL.md` with YAML front matter, which is the shape
`skill/SKILL.md` already has.

### 13.2 Rehearsed against a fake Codex home first

Before touching the real file, the full install → reinstall → uninstall cycle
was run against a throwaway `CODEX_HOME` containing a bundled-browser plugin
entry and an unrelated `node_repl` server:

```text
=== dry run ===            config md5 unchanged: yes, exit 0
=== real install ===       backed up config.toml -> config.toml.bak.20260920-173251
                           appended [mcp_servers.browser-fast-hybrid], exit 0
=== idempotent 2nd run === "the managed block is already present — leaving it
                            untouched (idempotent)"
=== toml still parses ===  mcp_servers: ['browser-fast-hybrid', 'node_repl']
                           plugins:     ['browser@openai-bundled']
                           cwd:         /Users/keychron/Projects/browser-use-jev-bridge
=== uninstall ===          mcp_servers after: ['node_repl']
                           plugins after:     ['browser@openai-bundled']
                           skills dir: empty
=== bad input rejected === --repo-root relative/path -> error, exit 1
```

### 13.3 The real install

```text
$ ./scripts/install-local.sh --dry-run --skip-deps --repo-root /Users/keychron/Projects/browser-use-jev-bridge
  ... dry run complete — nothing was written.
exit=0
config.toml md5 before: 2e7bbead2bcde5095b04a7dd3682b67b
config.toml md5 after : 2e7bbead2bcde5095b04a7dd3682b67b

$ ./scripts/install-local.sh --skip-deps --repo-root /Users/keychron/Projects/browser-use-jev-bridge
browser-fast-hybrid installer
  repository : /Users/keychron/Projects/browser-use-jev-bridge
  codex home : ~/.codex
  mode       : install

2) ~/.codex/config.toml
  backed up ~/.codex/config.toml -> ~/.codex/config.toml.bak.20260920-093514
  appended [mcp_servers.browser-fast-hybrid]
  other servers and plugins were not read, modified or removed

3) ~/.codex/skills/browser-fast-hybrid
  installed ~/.codex/skills/browser-fast-hybrid/SKILL.md

Installed.
exit=0
```

`--skip-deps` was used deliberately: dependencies and `dist/` were prepared
separately, as §12.1 describes, rather than letting a Linux `npm ci` overwrite
the Mac's tree. `--repo-root` was used because this shell sees the checkout at
a VM mount path while Codex will see `/Users/keychron/…`; the flag decides only
what is written into `cwd`, and the script still reads and checks the files
where they actually are.

After the install:

```text
mcp_servers: node_repl, node_repl.env, computer-use, openaiDeveloperDocs,
             open-knowledge, browser-fast-hybrid
plugins: 24 sections; browser bundled present: true
total sections: 175   (was 174 — exactly one added)
```

Nothing was removed, nothing was reformatted, and the timestamped backup
`~/.codex/config.toml.bak.20260920-093514` is the pre-install file.

### 13.4 `./scripts/doctor-local.sh`

```text
PASS  codex config.toml exists
PASS  MCP server registered (managed block)
PASS  skill installed
PASS  skill carries our install marker
PASS  bundled browser plugin still configured
PASS  registered cwd matches this repository
PASS  dist/mcp/main.js built
PASS  dist/cli.js built
PASS  node_modules installed

tool readiness (node dist/cli.js doctor --mode hybrid):
  PASS  typesafe endpoint: … (key unset) — not contacted
  PASS  text model endpoint: … (key unset) — not contacted
  PASS  workspace writable
  PASS  dotenv: .env: not present
  PASS  telemetry: disabled (default)
  PASS  recording: disabled (default)
  PASS  verification thresholds: minConfidence 0.8, minProbability 0.8

  mode=hybrid fast=not_ready pi=not_ready
  doctor: not_ready
    - No Chrome/Chromium was found; set BUJB_CHROME_EXECUTABLE or install one.
    - Neither the Jev fast path nor the Pi fallback has usable credentials.

MCP handshake (tools/list over a real stdio transport):
  tools: browser_fast_doctor, browser_fast_start, browser_fast_status,
         browser_fast_approve, browser_fast_cancel, browser_fast_verify,
         browser_fast_list_sessions

local doctor: ok
(Codex loads config.toml and skills at startup — restart it after an install.)
exit=0
```

The two `not_ready` blockers are environment B's, not the installation's: the
VM has no Chrome and the machine has no model credentials. The server itself
starts, speaks MCP and lists all seven tools.

### 13.5 Installed, awaiting restart

Codex reads `config.toml` and `~/.codex/skills/` **at startup**. The server and
the skill are written to disk and verified there. They are **not** loaded into
any Codex process that was already running. Nothing in this document claims
they are.

---

## 14. The online test that was not run

The brief permitted one strictly limited online test: `https://example.com`
only, `allowedDomains=["example.com"]`, no login, submission, message or
upload, `maxCostUsd <= 0.05`.

It was **not run**, because there are no credentials on this machine:

```text
"environment": {
  "OPENROUTER_API_KEY": "unset",
  "BROWSER_USE_API_KEY": "unset",
  "TYPESAFE_API_KEY": "unset",
  "TEXT_MODEL_API_KEY": "unset"
}
```

`.env` is not present. No online result, cost figure or transcript is reported
anywhere in this document, and `doctor` returns `not_ready` rather than
pretending otherwise. Status: `blocked_by_credentials`.

---

## 15. Secret-material scan and working tree

```text
$ git status --short
 M .env.example          M src/logging/audit-log.ts
 M README.md             M src/pi/fallback.ts
 M docs/ARCHITECTURE.md  M src/pi/session.ts
 M docs/SECURITY.md      M src/router/handoff.ts
 M fixtures/order.html   M src/router/hybrid-router.ts
 M package-lock.json     M src/testing/harness.ts
 M package.json          M src/types.ts
 M scripts/acceptance.sh M tests/helpers.ts
 M scripts/smoke.mjs     M tests/integration.fixtures.test.ts
 M skill/SKILL.md        M tests/unit.cli.test.ts
 M src/budget.ts        ?? docs/INSTALL.md
 M src/cli.ts           ?? docs/MCP.md
 M src/config.ts        ?? fixtures/volatile.html
 M src/index.ts         ?? scripts/_common.sh
 M src/jev/executor.ts  ?? scripts/doctor-local.sh
 M src/jev/policy.ts    ?? scripts/install-local.sh
 M src/jev/text-helper.ts ?? scripts/mcp-handshake.mjs
                        ?? scripts/uninstall-local.sh
                        ?? src/doctor.ts
                        ?? src/errors.ts
                        ?? src/mcp/
                        ?? src/testing/mcp-test-server.ts
                        ?? tests/integration.mcp.test.ts
                        ?? tests/unit.deadline.test.ts
                        ?? tests/unit.docs.test.ts
                        ?? tests/unit.execution-phase.test.ts
```

Every entry is source, tests, scripts or documentation. `.gitignore` covers
`node_modules/`, `dist/`, `.build-test/`, `.work/`, `work/`, `runs/`, `*.log`,
`.env`, `.env.*` (with `!.env.example`), `coverage/` and `.chrome-profile/`, so
no audit log, browser profile, recording, temporary file or credential can be
staged. `.env` does not exist on this machine. `.env.example` contains variable
**names** and empty values only.

---

## 16. Pass 3 structured summary

```json
{
  "pass": 3,
  "supersedes": "§9 (Pass 2), which recorded the MCP server as not_implemented",
  "environments": {
    "A": { "what": "cloud container", "os": "Linux x86_64", "node": "v22.22.2", "browser": "Chromium" },
    "B": { "what": "user's machine via the Cowork desktop Linux VM", "os": "Linux aarch64", "node": "v22.23.2", "browser": "none" },
    "C": { "what": "macOS itself", "status": "not reachable from this session" }
  },
  "results": {
    "npm ci": 0,
    "npm run check": 0,
    "npm test": { "exit": 0, "A": "116 pass / 0 fail / 0 skip", "B": "88 pass / 0 fail / 28 skip (no Chrome)" },
    "npm run build": 0,
    "npm run smoke": { "A": 0, "B": 2 },
    "bu-fast verify": 0,
    "mcp startup + initialize/listTools": 0,
    "mcp session/approval/cancel smoke": 0,
    "doctor --mode fast|hybrid|pi": 4,
    "npm audit --omit=dev": 0,
    "npm pack --dry-run --json": 0,
    "install-local.sh --dry-run": 0,
    "install-local.sh": 0,
    "doctor-local.sh": 0,
    "git status --short": "source, tests, scripts and docs only"
  },
  "onlineTest": "blocked_by_credentials: no TYPESAFE_API_KEY, TEXT_MODEL_API_KEY or provider key on this machine; nothing was faked",
  "macOSNative": "blocked_by_environment: this session reaches the Mac only through the desktop Linux VM; run ./scripts/acceptance.sh on the Mac for that record",
  "codex": {
    "server": "mcp_servers.browser-fast-hybrid, registered between markers",
    "skill": "~/.codex/skills/browser-fast-hybrid/SKILL.md",
    "backup": "~/.codex/config.toml.bak.20260920-093514",
    "browserPluginTouched": false,
    "state": "installed, awaiting restart — Codex loads config.toml and skills at startup"
  },
  "knownLimitations": [
    "not a sandbox: Pi runs model-authored JavaScript with filesystem and network access",
    "Pi's internal browser actions are not enumerated, so the Jev→Pi handoff is one-way and a run that reaches Pi ends there",
    "the third Pi approval layer is a pattern match over generated JavaScript; the intent check and review mode do not depend on it",
    "cost accounting covers the Pi legs only; the TypeSafe and text-model endpoints do not report a price",
    "verification is an independent call, not an independent model",
    "in-page freshness digests are 64-bit-class hashes",
    "unsupported-page detection is heuristic",
    "a goal whose success is not visible on the final page returns INSUFFICIENT_EVIDENCE and is reported unverified",
    "node_modules is platform-specific: npm ci must run on the machine that will run the server"
  ]
}
```
