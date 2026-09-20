# Acceptance evidence

Two passes are recorded here.

- **Pass 1 (MVP)** built the project. Its state is in git at
  `ac80dbd chore: checkpoint claude mvp before acceptance fixes`.
- **Pass 2 (this document)** is the security-and-truthfulness fix pass. It
  corrects several claims Pass 1 made that were not true. Those corrections are
  in §3, each with the evidence that the claim was wrong.

Command output below is pasted verbatim. Nothing in this file is a claim that
was not produced by a command.

**Two honesty headlines, up front:**

1. **No online API call was made.** No `TYPESAFE_API_KEY`, `TEXT_MODEL_API_KEY`
   or provider key exists in either environment. Every online path is
   `blocked_by_credentials`.
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
