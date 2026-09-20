# Security model

## What this is not

**This is not a sandbox.** Browser Use Pi runs model-authored JavaScript in a
Node worker with filesystem and network access, and this project drives a real
browser with a real profile. A task that reaches the Pi fallback can, in
principle, read files the process can read and make network requests the
process can make. Run untrusted tasks on an isolated machine, with a
throwaway browser profile, and with `--allowed-domain` set.

Page content is data, never instruction. The decision prompts say so, and the
fallback prompt says so, but a model can still be steered by a hostile page.
The layers below are what stand between that and a consequential action.

## Defaults

| Setting | Default | How to change it |
| --- | --- | --- |
| Pi anonymous telemetry | **off** (`telemetry: false`, and `DO_NOT_TRACK=1` is set if unset) | `BUJB_TELEMETRY=1` |
| Screen recording | **off** | `--record` or `BUJB_RECORD=1` |
| Action highlighting | off | `BUJB_HIGHLIGHT=1` |
| High-risk actions | blocked unless a human approves in this session | `--review` on a terminal |
| Domain policy | none (nothing restricted) | `--allowed-domain` / `--prohibited-domain` |
| Budgets | 40 steps, 300 s, $1 | `--max-steps` / `--timeout-ms` / `--max-cost-usd` |

## Credentials

- Every key is read from the environment. **No CLI flag accepts a credential**,
  so nothing lands in shell history or a process listing.
- The `bu-fast` CLI loads `./.env` at startup. A variable already present in
  the process environment always wins; the file never overrides it. The
  library entry point does not load `.env` implicitly — call `applyDotEnv()`.
  The loader reports the *names* it applied and skipped, never a value.
- `.env` is git-ignored; `.env.example` is the template and contains no values.
- The audit log, CLI output, `doctor` output and every error message pass
  through `Redactor`, which masks (a) every registered secret value and
  (b) credential-shaped strings: `Bearer …`, `Authorization: …`,
  `sk-/pk-/ghp_/github_pat_…`, `AKIA…`, JWTs, and `user:pass@` in URLs.
- `doctor` reports keys only as `set` or `unset`. It never prints a prefix,
  a length or a fingerprint.
- Pi is additionally given the literal secret values in its own `redact` list,
  so its history, events and saved transcripts are masked too.

## Secrets in fields

Three independent layers, in order:

1. The observation script **excludes `input[type=password]`, `type=file` and
   `type=hidden`** from the action space. The fast policy cannot see, choose or
   type into a password field at all.
2. A field whose label looks credential-like (password, PIN, OTP, 2FA,
   verification code, card number, CVV, IBAN, 密码, 验证码, 银行卡, 身份证 …) is
   refused by the router *before* the text model is called, and the step is
   handed to Pi.
3. Pi fills such a field only through **named secret injection**:
   `BUJB_SECRET_<NAME>` plus `BUJB_SECRET_DOMAINS_<NAME>`, passed to Pi as
   `sensitiveData`. The model sees the placeholder name, never the value, and
   Pi verifies the input document — not just the tab URL — before inserting it.

The text helper's own instructions forbid producing a credential, but the
instruction is the weakest of the four layers and is not relied on.

## Approval

`assessRisk()` classifies each action from its label, its link target and, for
the fallback, the code about to run. High risk covers purchase and payment,
funds movement, outbound messages and public posts, deletion, approval and
consent, file upload and irreversible submission — in English and Simplified
Chinese.

- **Default gate (`DenyHighRiskGate`)**: a high-risk action is refused and the
  run stops with exit code 3. Nothing is retried.
- **`--review` on a terminal**: every action is shown before it runs — current
  URL, policy source (Jev or Pi), action type, target element, a redacted
  summary of any text to be entered, and the risk level with its reasons.
- `--review` is rejected outright when stdin is not a TTY or `--json` is set,
  rather than silently degrading to "approve everything".

### Over MCP

The MCP server adds no security path of its own. It is the same `runTask`, the
same gate, the same budget and the same redactor; the only addition is that an
approval is asked over one MCP call and answered over another.

- no tool accepts an `apiKey`, `token`, `cookie` or `headers` input;
- unknown fields are rejected, so a mistyped budget is an error, not a default;
- `approvalId` is single-use, strictly matched, and refused on replay or from
  another session;
- an unanswered approval is **denied** when it times out;
- every MCP result passes through the redactor before it leaves the process;
- stdout carries JSON-RPC only — diagnostics are on stderr, and Pi's own
  logging is disabled.

### On the Pi leg

The hook is real and installed. `PiApprovalController.hook` is handed to
`BrowserUse.create` (the only place Pi accepts `beforeToolCall`), its type is
derived from that call's own parameter type, and it reads Pi 0.1.0's actual
context — `context.toolCall.name` and `context.args`. A refusal returns
`{ block: true, terminate: true }` *and* aborts the leg, so the model cannot
simply reword the action on its next turn. The run then ends
`stopped_by_approval` with exit code 3.

Three layers apply, in order:

1. **Intent, before the leg starts.** The operator's goal is risk-assessed
   before Pi is given anything. A goal about buying, paying, sending,
   deleting, publishing, approving or uploading needs a human first — no
   generated code is required for this to trigger.
2. **Every tool call, in `--review`.** Not only pattern matches: every call,
   including `finish`.
3. **High-risk tool calls, always.** A code-shape backstop on the cell's
   source.

**Honest limitation.** Layer 3 is a pattern match over generated JavaScript, so
a determined model could express a consequential action in code it does not
catch. Layers 1 and 2 do not depend on pattern matching, which is why they
exist. For a hard guarantee on a given site, use `--prohibited-domain`, or run
`--mode fast`, where there is no fallback at all.

**What is not claimed.** This project does not enumerate the individual browser
actions inside a Pi cell. `history` records one entry per Pi leg, and
`mustNotRepeat` covers Jev actions only. That is also why the fallback is
terminal — see `docs/ARCHITECTURE.md`.

## Not repeating actions, and knowing what may have happened

An action has five possible fates, and "we do not know" is one of them:

| `executionPhase` | Meaning | Recorded in history? | Safe to re-plan? |
| --- | --- | --- | --- |
| `preflight_failed` | refused before anything could have an effect | no — nothing reached the browser | yes |
| `dispatch_started` | the next operation can have a side effect; written *before* it runs | yes | no |
| `dispatched` | input was handed to the browser and the call returned | yes | no |
| `effect_uncertain` | it may or may not have landed | yes | **no** |
| `observed` | a post-action observation exists | yes | n/a |

Three real cases produce `effect_uncertain`, and each has a test:

- a `SELECT` applies its value *inside* the in-page script, before any CDP
  input, so a change handler that navigates can interrupt the call after the
  value was set and `change` already fired;
- a click or a fill is several CDP calls in one cell, so the mouse press can
  land and `Input.insertText` can then fail;
- the run deadline can fire between those calls.

An uncertain action is never retried and never re-planned: the run hands over
to Pi (or stops), the record and its phase trail go into `history` and the
audit log, and the action is carried into `mustNotRepeat`.

Pi's *internal* browser actions are **not enumerated**. A Pi leg is one history
record with its step count and an explicit note saying so. That is exactly why
control never returns to the fast path afterwards.

## What "stopped" does and does not mean

When a run ends with `stopped_by_approval` (CLI exit 3, MCP state `blocked`):

- **only the declined action** is known not to have been dispatched;
- **earlier steps in the same run may already have changed the page** — read
  `history` / `steps` and the audit log to see which;
- if the run had already reached Browser Use Pi, its internal actions are not
  enumerated, so what happened inside that leg cannot be reconstructed from the
  record;
- a re-run is **not** automatically safe. Inspect the live page first. A second
  run plans from scratch and can repeat something that already took effect.

The only case in which nothing at all was dispatched is an approval that was
refused before any action ran — visible as an empty `history` and a single
approval record in the audit log. `browser_fast_status` shows both. Failure never triggers an
automatic replay: a stale page means observe again, an unsafe action means hand
over, and a rejected CDP call is treated as *possibly executed*.

## Audit

Each run writes `audit-<uuid>.jsonl` into the workspace (mode 0600),
synchronously, one redacted JSON object per line: observations (digests and
counts, not raw DOM), decisions, risk assessments, approvals, executions,
staleness, handoffs, verification and the final status.
`bu-fast verify --audit <file>` re-checks that log offline: a `completed`
status must carry `verified: true`, and the file must contain no
credential-shaped strings.

## Budgets and the deadline

One `BudgetTracker` covers the whole run — Jev steps, Pi steps, wall clock and
model cost. A fallback leg is offered only what is left, never the initial
limits. Cost accounting covers the Pi legs; the fast path's two endpoints do
not report a price.

`--timeout-ms` is a **run-level deadline**, not a per-call one. One
`AbortSignal` is created at run start and bound to every stage:

- the initial navigation, every observation, `tabCount` and both freshness
  probes (the browser backend is bound once, so page evaluation and CDP calls
  are covered);
- TypeSafe decision requests **and their retry backoff**;
- text-model requests;
- Jev input dispatch;
- the Pi fallback leg, and the re-observation after it;
- the final verification call.

Closing gets its own small budget (`BUJB_CLEANUP_MS`, default 10 s) so an
already-expired deadline cannot prevent Chrome from being released. A run
therefore overruns `--timeout-ms` by at most that cleanup allowance.

An expired budget is reported as `timeout`; a caller cancelling is reported as
`cancelled`. They are different signals and are never conflated. An action
interrupted by the deadline is marked `effect_uncertain`.

## Reporting

There is no completion claim without evidence. `status: "completed"` is emitted
only when **all** of the following hold:

1. the verdict is `SATISFIED`;
2. every deterministic check passed;
3. the answer's confidence is at least `BUJB_VERIFY_MIN_CONFIDENCE` (0.80);
4. the probability mass on `SATISFIED` is at least
   `BUJB_VERIFY_MIN_PROBABILITY` (0.80);
5. the observation used was taken *after* the completion claim.

Everything else is `unverified`, `blocked`, `stopped_by_approval`,
`step_limit`, `timeout`, `cost_limit` or `error`.

The verification call is an **independent call**, not an independent model: it
goes to the same TypeSafe provider and model id as the decision heads, and is
shown only the goal and a fresh page. A systematic bias in that model is shared
by both sides. Point a different `TYPESAFE_MODEL` at the verifier if that
matters for your use.
