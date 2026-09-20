# MCP tool reference

`bu-fast-mcp` is a stdio Model Context Protocol server built on the official
`@modelcontextprotocol/sdk`, pinned at an exact version (1.30.0). It exposes the same engine the CLI uses:
one router, one approval policy, one budget, one redactor, one verifier. The
MCP layer adds exactly two things — session lifecycle and a cross-call approval
channel — and takes nothing away.

**stdout carries JSON-RPC and nothing else.** Diagnostics go to stderr, and
Browser Use Pi's own logging is disabled at session creation for the same
reason. A test asserts that every line the production entry point writes to
stdout parses as a JSON-RPC message.

**No tool accepts a credential.** There is no `apiKey`, `token`, `cookie` or
`headers` input anywhere. Keys come from the environment and from `./.env`,
loaded once at startup, and the process environment always wins.

**Unknown fields are rejected.** `--max-setps 3` would be a typo that silently
kept the default budget; `{"maxSetps": 3}` over MCP is an error.

---

## The shape of a run

```
browser_fast_start   ->  { sessionId, state: "running" }        returns immediately
browser_fast_status  ->  poll until state is terminal
   state === "awaiting_approval"  ->  browser_fast_approve
browser_fast_cancel  ->  stop early; idempotent
browser_fast_verify  ->  re-read a finished run, or check an audit log
```

At most one browser task runs at a time by default
(`BUJB_MCP_MAX_SESSIONS`), so two tasks can never fight over one Chrome
profile.

### States

| State | Meaning |
| --- | --- |
| `created` | the session exists, the run has not started |
| `running` | the run is working |
| `awaiting_approval` | an action needs a human; answer with `browser_fast_approve` |
| `completed` | the goal was reached **and** verified — the only success state |
| `unverified` | the run finished but the verifier did not confirm the goal |
| `blocked` | stopped: refused approval, a step limit, or neither policy could continue |
| `timeout` | the run budget's wall clock expired |
| `cost_limit` | the model spend cap was reached |
| `cancelled` | the caller cancelled, or the client disconnected |
| `failed` | an unhandled error; see `error` and the audit log |
| `expired` | a finished session passed its retention TTL and was dropped |

`outcomeStatus` carries the router's own finer-grained status
(`stopped_by_approval`, `step_limit`, …) alongside the state.

---

## Tools

### `browser_fast_doctor`

```jsonc
{ "mode": "fast" | "hybrid" | "pi" }   // all optional; default hybrid
```

Returns `status` (`ready` | `partial` | `not_ready`), per-leg readiness,
`blockers`, and a check list. Credentials appear only as `set` or `unset`.

### `browser_fast_start`

```jsonc
{
  "url": "https://example.com/search",   // required, http(s) or file
  "goal": "the results are filtered to In stock",  // required, a verifiable end state
  "mode": "hybrid",                       // fast | hybrid | pi
  "review": false,                        // true = approve EVERY action and every Pi tool call
  "allowedDomains": ["*.example.com"],
  "prohibitedDomains": ["ads.example.com"],
  "maxSteps": 40, "timeoutMs": 300000, "maxCostUsd": 1,
  "record": false
}
```

Returns `{ sessionId, state, budget, auditPath, … }` immediately. The run
continues in the background.

Write the goal as an **end state**, not a click script: the verifier is shown
the goal and the final page, so "the cart shows two items" can be checked and
"click the plus button twice" cannot.

### `browser_fast_status`

```jsonc
{ "sessionId": "bfh_…" }
```

Returns the state, the current URL, a step summary (each with its
`executionPhase` and `effectUncertain` flag), `uncertainActions`, the budget,
the audit path, any `pendingApproval`, and — once finished — the full
`RunOutcome`.

### `browser_fast_approve`

```jsonc
{ "sessionId": "bfh_…", "approvalId": "apr_…", "approved": true, "reason": "optional" }
```

`approvalId` is single-use and must match the session's current pending
approval. A replay, a stale id or an id from another session is refused.
`approved: false` stops the run safely.

Without `review`, high-risk actions still pause here; nothing is
auto-approved.

### `browser_fast_cancel`

```jsonc
{ "sessionId": "bfh_…" }
```

Aborts the run, denies any pending approval, releases Chrome and the timers.
Idempotent.

### `browser_fast_verify`

```jsonc
{ "sessionId": "bfh_…" }   // or  { "auditPath": "/…/audit-<uuid>.jsonl" }
```

Exactly one of the two. Both report `freshObservation: false` and a
`verificationMode` of `recorded_run_result` or `audit_only`: neither re-opens
the page, and neither is presented as a live check.

### `browser_fast_list_sessions`

No input. State only — no page content, no secrets.

---

## Approval workflow

```jsonc
// 1
→ browser_fast_start { "url": "https://shop.example/cart", "goal": "the order is placed", "review": true }
← { "sessionId": "bfh_ab12…", "state": "running" }

// 2
→ browser_fast_status { "sessionId": "bfh_ab12…" }
← { "state": "awaiting_approval",
    "pendingApproval": { "approvalId": "apr_7f…", "source": "jev", "operation": "CLICK",
                         "actionLabel": "Place order", "risk": "high",
                         "riskReasons": ["purchase or payment"],
                         "url": "https://shop.example/cart" } }

// 3
→ browser_fast_approve { "sessionId": "bfh_ab12…", "approvalId": "apr_7f…", "approved": true }
← { "applied": true, "state": "running" }

// 4
→ browser_fast_status { "sessionId": "bfh_ab12…" }
← { "state": "completed", "outcome": { "verification": { "verified": true, … } } }
```

Declining at step 3 ends the run with `state: "blocked"` and
`outcomeStatus: "stopped_by_approval"`. **That means the declined action was
not dispatched. It does not mean the page is unchanged** — read `steps` to see
what ran before it.

---

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUJB_MCP_MAX_SESSIONS` | 1 | concurrent browser tasks |
| `BUJB_MCP_APPROVAL_TIMEOUT_MS` | 300000 | unanswered approvals are **denied** after this |
| `BUJB_MCP_SESSION_TTL_MS` | 900000 | how long a finished session stays readable |

Everything else — model endpoints, budgets, domains, verification thresholds —
is the same configuration the CLI uses. See `.env.example`.

---

## Shutdown

SIGINT, SIGTERM, a closed stdin and a closed transport all cancel every
session, release Chrome and let the process exit. A client that disconnects
mid-run does not leave a browser task behind; a test asserts this by taking the
browser again from a fresh server immediately afterwards.
