---
name: browser-fast-hybrid
description: "Drive a browser from a goal, with a fast policy in front of a Browser Use Pi fallback, human approval for consequential actions, and independent verification before anything is called done. Use when asked to fill a form, search, filter, paginate, or read state that needs a few interactions — and whenever a browser task must be auditable or must pause for approval. Prefer the browser_fast_* MCP tools; the bu-fast CLI is the diagnostic and terminal-review fallback."
---

# browser-fast-hybrid

A hybrid browser tool. A fast policy handles ordinary HTML controls in one
model call per step; anything it cannot model is handed to a general-purpose
Browser Use Pi agent in the **same** browser session.

Three things shape how you should use it:

1. **The handoff to Pi is one-way.** Once Pi takes over, the run re-observes,
   verifies and ends. Expect at most one Pi leg per run.
2. **Pi's internal browser actions are not enumerated.** A Pi leg is one
   history record with a step count. If a run ended inside Pi, read the live
   page before doing anything else.
3. **Only `completed` means done.** It requires a verification call, shown the
   goal and a page observed *after* the completion claim, to return SATISFIED
   with enough confidence.

## Prefer the MCP tools

| Tool | Use |
| --- | --- |
| `browser_fast_doctor` | before the first run in a session: `ready` / `partial` / `not_ready` + blockers |
| `browser_fast_start` | start a task; returns a `sessionId` immediately |
| `browser_fast_status` | poll; carries state, steps, budget, pending approval, final outcome |
| `browser_fast_approve` | answer the one pending approval; single-use `approvalId` |
| `browser_fast_cancel` | stop early; idempotent |
| `browser_fast_verify` | re-read a finished run, or check an audit log offline |

Full reference, including the state machine: `docs/MCP.md`.

The `bu-fast` CLI is the fallback: use it for diagnostics (`bu-fast doctor
--mode hybrid --json`) and when a human is at a terminal and wants
`--review` prompts inline. Never run both against the same Chrome profile at
once.

## When to call this tool

Good fits: form filling, search, filtering, sorting, pagination on ordinary
HTML; reading state that needs a few interactions; any browser task that must
be auditable or must pause for approval.

Poor fits: a login you cannot supply through named secret injection; bulk
scraping of a static page (fetch it instead); anything whose success is not
visible on the final page — the verifier will return
`INSUFFICIENT_EVIDENCE` and the run will be `unverified`.

Write the goal as a **verifiable end state**, not a click script.
Good: `"the results list is filtered to In stock and sorted by price ascending"`.
Poor: `"click the stock filter then the sort dropdown"`.

## Approval

Set `review: true` whenever the task touches an authenticated session, a cart,
a payment method, anything that sends, posts, publishes, deletes, approves or
uploads — or any account you would not want changed by accident. Then **every**
fast-path action and **every** Pi tool call pauses for you.

Even without `review`, these pause on their own and are never auto-approved:

- a goal about buying, paying, sending, publishing, deleting, approving or
  uploading — refused *before* Pi is started at all;
- a high-risk action on the fast path;
- a high-risk Pi tool call.

When `state` is `awaiting_approval`, read `pendingApproval` — it carries the
URL, the policy source (`jev` or `pi`), the operation, the target, a redacted
summary of any text to be entered, and the risk with its reasons — then call
`browser_fast_approve`. An unanswered approval is **denied** after the timeout.

## Reading the result

| State (MCP) | CLI exit | What it means | What to do |
| --- | --- | --- | --- |
| `completed` | 0 | goal reached **and** verified | report success; quote `finalUrl` and the verifier's evidence |
| `unverified` | 1 | finished, but the goal was not demonstrated | do not claim success; re-read the page |
| `blocked` | 1 or 3 | refused approval, step limit, or neither policy could continue | read `notes` and `fallbackReasons` |
| `timeout` / `cost_limit` | 1 | the run budget ran out | partial work may exist; inspect |
| `cancelled` | 1 | the caller cancelled or the client disconnected | inspect |
| `failed` | 1 | unhandled error | read `error` and the audit log |

`outcomeStatus` carries the finer-grained router status
(`stopped_by_approval`, `step_limit`, …). CLI exit 3 and
`outcomeStatus: "stopped_by_approval"` are the same event.

## After a stop, before re-running

**Do not re-run blindly.** A refusal means the *declined action* was not
dispatched. It does not mean the page is unchanged.

Before re-running, always:

1. read `steps` / `history` — each entry carries an `executionPhase` and an
   `effectUncertain` flag;
2. treat every entry in `uncertainActions` as **having happened**: it may have
   landed and the run could not confirm it;
3. if `piFallbacks > 0`, remember Pi's internal actions are not enumerated —
   open the live page and look;
4. only conclude that nothing was dispatched when `history` is empty.

Then, if you do re-run, narrow the goal so a repeated action cannot do damage,
or do the step yourself.

## Failure modes

- `awaiting_approval` that you cannot answer → `browser_fast_cancel`, and tell
  the user which action was waiting.
- `unverified` → the action may well have happened; the *evidence* was missing.
  Re-read the final page. Never re-run the same goal blindly.
- `timeout` → the whole-run deadline fired. An action in flight at that moment
  is marked `effect_uncertain`.
- `not_ready` from `doctor` → do not start a run; report the blockers.

## Before the first run

```
browser_fast_doctor { "mode": "hybrid" }
```

`not_ready` means it cannot run: report the blockers rather than starting.
`partial` will start but something is degraded (for example no text model, so
`TYPE_TEXT` steps will fail).

## Audit

Every run writes a redacted JSONL audit log; its path is in `auditPath`.
`browser_fast_verify { "auditPath": "…" }` re-checks it offline: a `completed`
claim must carry a verified result, and the log must contain no
credential-shaped material. Both verification modes report
`freshObservation: false` — neither re-opens the page.
