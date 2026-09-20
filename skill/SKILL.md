---
name: browser-fast-hybrid
description: Drive a browser with a fast decision policy in front of a Browser Use Pi fallback. Use for deterministic, observable web tasks on ordinary HTML pages where the result must be independently verified before it is reported as done.
---

# browser-use-jev-bridge (bu-fast)

A hybrid browser tool. A fast policy handles ordinary HTML controls in one
model call per step; anything it cannot model is handed to a general-purpose
Browser Use Pi agent running in the **same** browser session.

**The handoff is one-way.** Once Pi takes over, the run re-observes, verifies
and ends. It does not go back to the fast path. Expect at most one Pi leg per
run, and treat `piFallbacks: 1` as "the run finished inside Pi".

A run is reported complete only when a separate verification call confirms it
from a page observed *after* the completion claim, with confidence and
probability above the configured thresholds.

## When to call this tool

Call it for:

- form filling, search, filtering, sorting and pagination on ordinary HTML;
- reading state from a page that needs a few interactions to reach;
- multi-step navigation where each step must be recorded and auditable.

Prefer something else for:

- anything that needs a login you cannot supply through named secret injection;
- bulk scraping of a static page (fetch it instead);
- tasks whose success cannot be seen on the final page — the verifier will
  return `INSUFFICIENT_EVIDENCE` and the run will be reported `unverified`.

Do **not** call it to perform a purchase, a payment, a message send, a
deletion, a publication, an approval submission or a sensitive file upload.
Those are blocked by default and the run will stop.

## Invocation

```
bu-fast run --url <START_URL> --goal "<what must be true at the end>"
```

Useful flags:

```
--mode fast|hybrid|pi     hybrid is the default; fast disables the fallback
--review                  ask before every action (needs a terminal)
--allowed-domain HOST     repeatable; strongly recommended
--prohibited-domain HOST  repeatable; denials win
--max-steps N --timeout-ms N --max-cost-usd N
--json                    machine-readable result
```

Write the goal as a **verifiable end state**, not as a click script.
Good: `"the results list is filtered to In stock and sorted by price ascending"`.
Poor: `"click the stock filter then the sort dropdown"`.

## When review mode is mandatory

Always pass `--review` — and stay at the terminal — when the task touches:

- an authenticated session or an account the user owns;
- a cart, an order, a payment method or a subscription;
- anything that sends, posts, publishes or shares;
- anything that deletes, deactivates or unsubscribes;
- an approval or consent flow;
- a file upload.

Without `--review` the run does not silently proceed. Three things are gated:

- a **goal** about buying, paying, sending, publishing, deleting, approving or
  uploading is refused *before* Pi is even started;
- a high-risk action on the fast path is refused;
- a high-risk Pi tool call is refused, the leg is aborted, and the page is left
  as it was.

Each of these exits with code 3. That is the intended behaviour, not a failure
to work around. With `--review`, every fast-path action **and** every Pi tool
call is shown before it runs.

## Reading the result

Exit codes:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Goal reached **and** independently verified | Report success; quote `finalUrl` and the verifier's evidence |
| 1 | Finished without verified success (`unverified`, `blocked`, `step_limit`, `timeout`, `error`) | Report honestly; do not claim the task is done |
| 2 | Usage error | Fix the invocation |
| 3 | An action (or the goal itself) needed approval and none was available | Tell the user exactly what was refused, and offer to re-run with `--review` |
| 4 | Environment problem | Run `bu-fast doctor` |

**Only exit code 0 means the task is done.** `status: "completed"` always comes
with `verification.verified: true`; any other status means the goal was not
demonstrated. Never upgrade `unverified` to "probably worked": the verifier
already looked at the final page and declined to say so.

## Handling failure

- `blocked` — the page needs something neither policy could do. Read
  `fallbackReasons` and `notes`, then either narrow the goal or do the step
  manually.
- `step_limit` / `timeout` / `cost_limit` — the one run-wide budget ran out.
  `budget` in the result shows limits, used and remaining. Partial work may
  exist: inspect the page, do not re-run blindly.
- `unverified` — an action may well have happened; the *evidence* was missing.
  Re-read the final page before doing anything else, and never re-run the same
  goal blindly: a re-run can repeat an action that already took effect.
- `stopped_by_approval` — nothing was dispatched. Safe to re-run with
  `--review`.
In every failure case the `history` array lists what the **fast path**
dispatched. A Pi leg appears as a single record with its step count and an
explicit note that the individual browser actions are not enumerated — so if a
run ended inside Pi, re-read the live page before doing anything else. Never
assume `history` tells you what Pi clicked.

## Before the first run

```
bu-fast doctor --mode hybrid --json
```

It returns `ready`, `partial` or `not_ready` for the mode you name, with a
`blockers` list, and exits 4 on `not_ready`. It reports the Node version, the
`@browser_use/pi` version, Chrome availability and remote-debugging status,
whether each credential is `set` or `unset` (never the value), the configured
endpoints, workspace writability, whether `.env` was loaded (names only), and
the current telemetry/recording settings.

Do not start a run when `doctor` says `not_ready`; tell the user what the
blockers are.

## Audit

Each run writes a redacted JSONL audit log; its path is in the result as
`auditLogPath`. `bu-fast verify --audit <path>` re-checks offline that a
completion claim is backed by a verification result and that the log contains
no credential-shaped material.
