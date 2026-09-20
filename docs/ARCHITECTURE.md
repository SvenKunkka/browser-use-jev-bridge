# Architecture

> **Current shape:** the Pi fallback is **terminal** (one-way), the Pi approval
> hook is installed and typed from Pi's own signature, one budget and one
> deadline cover the whole run, every action carries an explicit execution
> phase, and an MCP server ships alongside the CLI. See `docs/ACCEPTANCE.md`
> for what changed and why.

## The one rule everything else follows

**Browser Use Pi owns the browser.** One `BrowserUse` instance is created per
run. It owns the Chrome/CDP connection, the tab, the persistent V8 cell and the
workspace directory. The Jev fast policy does not open a browser, does not hold
a CDP socket and does not have a tab of its own: its DOM work is executed
*inside Pi's cell*, against Pi's `page` binding, through
`BrowserUse.execute()`.

That is what makes the hybrid safe. Both policies see the same tab, in the same
state, and they can never race for it, because the router never runs them
concurrently.

```
       ┌──────────────────────────┐   ┌────────────────────────────────────┐
       │ bu-fast (CLI)            │   │ bu-fast-mcp (MCP, stdio)           │
       │ run / verify / doctor    │   │ start · status · approve · cancel  │
       └────────────┬─────────────┘   └───────────────┬────────────────────┘
                    │      one engine, two front ends │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼─────────────┐
                    │        Hybrid router         │
                    │  observe → route → decide →  │
                    │  risk → approve → guard →    │
                    │  execute → re-observe        │
                    └───────┬──────────────┬───────┘
             fast path      │               │      fallback
        ┌───────────────────▼──┐     ┌──────▼─────────────────┐
        │ Jev fast policy       │     │ Browser Use Pi agent   │
        │ snapshot              │     │ agent.run / followUp   │
        │ dynamic action space  │     │ iframes, uploads,      │
        │ TypeSafe op+target    │     │ canvas, shadow DOM,    │
        │ text helper (fields)  │     │ popups, recovery       │
        │ guards + freshness    │     │                        │
        └───────────────────┬──┘     └──────┬─────────────────┘
                            │               │
                    ┌───────▼───────────────▼───────┐
                    │  ONE Pi session (PiSession)    │
                    │  agent.execute(...) │ agent.run │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────▼──────────────┐
                    │  One Chrome tab, one CDP link │
                    └───────────────┬──────────────┘
                                    │
       ┌────────────────────────────▼───────────────────────────┐
       │ Independent verifier · approval policy · audit log      │
       └─────────────────────────────────────────────────────────┘
```

## Module map

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | `run` / `verify` / `doctor`, strict flag parsing, `.env` loading, exit codes. No credential ever arrives as a flag. |
| `src/doctor.ts` | Readiness, shared by the CLI and MCP so they cannot disagree. |
| `src/budget.ts` | One `BudgetTracker` per run: Jev steps, Pi steps, wall clock, cost, and the run-level abort signal. |
| `src/errors.ts` | `RunAbortedError`, shared by the session and the policies. |
| `src/mcp/server.ts` | The seven MCP tools, their strict schemas, and one redaction pass on the way out. |
| `src/mcp/session-manager.ts` | Session lifecycle, the cross-call approval channel, TTL, concurrency and shutdown. |
| `src/mcp/main.ts` | `bu-fast-mcp`: stdio transport, stderr logging, signal handling. |
| `src/config.ts` | Environment → `BridgeConfig`; `describeConfig()` produces a printable form where every secret collapses to `set`/`unset`. |
| `src/pi/session.ts` | The single owner. Wraps `BrowserUse`; exposes `evaluateInPage`, `cdp`, `cdpBatch`, `goto`, `info`, `tabCount`, `run`, `followUp`, `close`. |
| `src/pi/fallback.ts` | `PiApprovalController` (the `beforeToolCall` hook, typed from `BrowserUse.create`), the handoff render, and the Pi leg under the *remaining* budget. |
| `src/jev/snapshot.ts` | The in-page sources: full observation, marker, node guard, pre-input target resolution, post-input settle. |
| `src/jev/action-space.ts` | One index per element; one target set per operation. |
| `src/jev/policy.ts` | One TypeSafe request per step; strict validation of both heads. |
| `src/jev/text-helper.ts` | The separate small model that writes field values, and nothing else. |
| `src/jev/freshness.ts` | Fingerprints, stale errors, guard comparison. |
| `src/jev/executor.ts` | Observation retries, guard enforcement, CDP input dispatch. |
| `src/router/hybrid-router.ts` | The loop, the routing rules, the counters, the budgets. |
| `src/router/handoff.ts` | `HandoffContext`, `mustNotRepeat`, the literal fallback prompt. |
| `src/safety/*` | Domain policy, risk classification and approval gates, redaction. |
| `src/verification/verifier.ts` | Deterministic checks plus one independent verification *call*, with confidence and probability thresholds. |
| `src/logging/audit-log.ts` | Redacted JSONL, written synchronously. |
| `src/testing/mcp-test-server.ts` | A real MCP server whose only substitution is the paid model transports, driven by `BUJB_TEST_PLAN`. |
| `src/testing/harness.ts` | Offline harness: headless Chromium, a Pi session with a throwing model transport, scripted TypeSafe/text clients. |

## Two front ends, one core

`bu-fast` (CLI) and `bu-fast-mcp` (MCP over stdio) are two callers of the same
`runTask`. The router, the approval policy, the budget and its deadline, the
audit log, the redactor and the verifier are the same objects behind both, so
there is no path where one is safer than the other.

What the MCP layer adds, and all it adds:

- **Session lifecycle.** A run outlives a single tool call, so it needs an id,
  a state machine and a place to live. `SessionManager` holds at most one
  active browser task by default, which is also what stops two tasks fighting
  over one Chrome profile.
- **A cross-call approval channel.** The CLI can ask a human on a terminal; MCP
  cannot, so an approval becomes a single-use `apr_…` id published in
  `browser_fast_status` and answered by `browser_fast_approve`. An unanswered
  approval times out into a **denial**.

What it does not add: no tool accepts a credential, no schema allows unknown
fields, no result escapes the redactor, and no high-risk action runs without an
answer. Session state is derived from the same redacted audit stream the CLI
writes, so the MCP surface cannot see more than the audit log does.

`src/mcp/main.ts` writes every log line to stderr and passes `log: false` to
`BrowserUse.create`, because on stdio a single stray `console.log` would
corrupt the JSON-RPC stream.

## One step, in order

1. **Observe.** `SNAPSHOT_SOURCE` runs in the page and returns the visible text,
   the modelled controls, a marker digest, a form-control page key, one guard
   digest per node and the unsupported-control signals. The host computes a
   sha256 `fingerprint` over `(url, text, actions, scroll)`.
2. **Route.** `detectUnsupported()` decides, deterministically, whether this
   page belongs to Pi. See the table below.
3. **Decide.** One TypeSafe request carries an operation head and one target
   head per supported operation. Both heads are validated: the choice must be
   an offered id, the probability vector must cover exactly the offered ids,
   sum to 1 (±0.02) and put the choice at the arg-max. A failure raises, and
   nothing is executed.
4. **Generate text**, only for `TYPE_TEXT`, only from the separate small model,
   only after the page's marker is confirmed unchanged, and never for a
   credential-like field.
5. **Classify and approve.** Risk is derived from the action label, the link
   target and (for Pi) the code. High risk requires a human. `--review` asks
   for every action.
6. **Guard.** For `CLICK`/`SELECT` the node guard *and* the form-control page
   key must still match. For everything else the whole-page marker must match.
7. **Execute.** `actTargetSource` re-checks connectivity, visibility, disabled
   and read-only state, viewport bounds and occlusion, and resolves geometry at
   that instant. `SELECT` is applied in-page and confirmed; clicks and typing
   go out as CDP input events in one cell so a press/release pair cannot split.
8. **Record, then observe.** The execution record is appended *before* the
   post-action observation, so a navigation that interrupts observation cannot
   erase the fact that the action was dispatched.
9. **Account.** Page changed → progress. Unchanged non-WAIT action → strike.

## Routing rules

| Condition | Route |
| --- | --- |
| Ordinary visible HTML controls are modelled | Jev fast path |
| Fast policy answers `BLOCKED` | Pi |
| A new page-type tab appears during the run (popup / target=_blank) | Pi |
| A modal `<dialog>` is open and nothing is modelled | Pi |
| Nothing is modelled and the page has iframes, canvas or shadow roots | Pi |
| A cross-origin iframe and nothing is modelled | Pi |
| The goal mentions upload/attach and the page has a file input | Pi |
| Two consecutive stale/fingerprint failures | Pi |
| Three consecutive non-WAIT actions with no page change | Pi |
| A credential-like field must be filled | Pi (named secret injection only) |
| No valid decision could be produced | Pi |
| Jev's own step ceiling reached | Pi |
| Global budget exhausted | Safe stop with `step_limit` / `timeout` / `cost_limit` |
| `--mode fast` and any of the above | Safe stop, never a guess |

## Jev → Pi is one-way

Handing a step to Pi **ends the run**. The router re-observes the page, runs the
verifier against that fresh observation, and returns. Control is not handed
back to the fast path.

This is a deliberate safety choice, not an oversight. Pi's tool is "execute
this JavaScript": a single cell can click, type and submit several times, and
those individual browser actions **are not enumerated** by this project. That
means it cannot populate `mustNotRepeat` for them. Handing control back to a
policy that would then plan its own next click, without knowing what Pi already
did, is exactly the "never repeat an action that may already have taken effect"
rule being broken. So the run stops instead.

`history` therefore contains one record per Pi leg, labelled with the number of
Pi steps and an explicit note that the individual browser actions are not
enumerated. It is not a list of what Pi clicked.

Restoring a two-way handoff needs real evidence, not a code change: every
click, keystroke and submission Pi performs must produce an `ActionRecord`,
effect-uncertain ones must reach `mustNotRepeat`, and an integration test must
show that Jev does not repeat them. Until that exists, the fallback stays
terminal.

## Approval, on both legs

| | Jev fast path | Browser Use Pi fallback |
| --- | --- | --- |
| What is gated | one resolved element, with its label, role and link target | one tool call, by name and validated arguments |
| Default mode | high-risk actions need a human; no human ⇒ refused | the stated **goal** is assessed before the leg starts, and each high-risk tool call is assessed again; no human ⇒ refused |
| `--review` | every action | every tool call, including the delivery call |
| On refusal | nothing is dispatched; run ends `stopped_by_approval` (exit 3) | the call is blocked with `terminate: true`, the leg is aborted, run ends `stopped_by_approval` (exit 3) |

The hook is `PiApprovalController.hook`, whose type is derived from
`Parameters<typeof BrowserUse.create>[0]['beforeToolCall']`. It is passed to
`BrowserUse.create` — the only place Pi accepts it — and it reads Pi 0.1.0's
real context: `context.toolCall.name` and `context.args`.
`tests/integration.pi-fallback.test.ts` drives the actual Pi agent loop and
asserts that shape at runtime.

## Execution phases

`JevExecutor.act` reports, through a typed callback, how far an action got:
`preflight_failed`, `dispatch_started`, `dispatched`, `effect_uncertain`,
`observed`. The router opens the history record at the **first phase that
could have a side effect**, not after `act()` returns, so a dispatch that
throws half-way is still recorded. `docs/SECURITY.md` has the table and the
three real cases that produce `effect_uncertain`.

## One budget and one deadline for the whole run

`BudgetTracker` holds the limits and the spend:

- Jev reports one step per executed action.
- A Pi leg is offered `remaining()`, never the initial limits, and afterwards
  reports the `steps` and `usage.cost.total` it actually consumed.
- The wall clock is enforced with an `AbortSignal`, so an in-flight Pi run is
  cut off at the deadline rather than at the top of the next loop iteration.
- Exhaustion maps to `timeout`, `cost_limit` or `step_limit`, in that order.
- `RunOutcome.budget` and the audit log carry limits, used and remaining.

Cost accounting covers the Pi legs only: the TypeSafe and text-model endpoints
do not return a price, so fast-path calls consume steps and time but contribute
0 to the cost total.

## Why a decision cannot be executed twice

- A `Decision` carries the fingerprint of the observation it was made on.
- `assertDecisionFresh` runs before any mutation and the router clears the
  pending decision in the same step.
- A retry therefore has nothing to re-execute; it must observe and decide again.
- On failure the router never retries the browser action. `StalePageError`
  means "observe again"; `UnsafeActionError` means "hand over"; neither means
  "try once more".
- `mustNotRepeat` carries every dispatched, effect-uncertain action into the
  fallback prompt, including ones where no page change was observed.

## Porting notes (differences from upstream Jev)

1. **Transport.** Upstream talks to Browser Harness over its own CDP helper.
   Here every DOM call travels through a Pi cell. The JSON channel is the
   cell's stdout between sentinels, because `BrowserUse.execute()` is the
   public API and does not expose the worker's private JSON capture path.
2. **Digests.** `marker`, `page_key` and each `guard` are hashed *inside the
   page*. Upstream returns them verbatim; that payload (each guard carries up
   to 6 000 characters of scope text, for up to 250 nodes) exceeds the cell's
   1 MB capture limit. Only equality is ever tested on these values.
   Trade-off: a hash collision would mask a real change. The digest mixes two
   32-bit accumulators and the serialised length; for the page-local, short-
   lived comparisons it is used for, this is an accepted risk and it is the
   one place where the port is weaker than the original.
3. **Rectangles** are rounded to whole pixels so sub-pixel reflow does not
   invalidate a fingerprint.
4. **Unsupported signals** (iframes, cross-origin iframes, file inputs, canvas,
   shadow roots, open dialogs, password fields) are new, and exist only to feed
   the routing rules.
5. **Platform modifier.** Upstream picks the select-all modifier from
   `sys.platform` of the Python process. Here it is probed from the *page*
   (`navigator.userAgentData.platform`), because Pi may be driving a browser on
   another machine.
6. **Budgets.** Upstream's demo budget (`MAX_STEPS = 60`) survives as
   `thresholds.jevMaxSteps`; the run-level budget is separate, operator-set and
   shared with the Pi legs.

## Known upstream-vs-prompt differences

The task brief assumed a few things that the live sources do not support. Each
was resolved in favour of the live source:

- `Browser.chrome` exists, but `openBrowser()` and `chromeProfileDirs()` are
  **not** re-exported from the package entry point. This project therefore never
  calls them.
- `agent.execute()` does not return a JSON value; only the private
  `BrowserRuntime.readResult` path does. Hence the stdout sentinel channel.
- Pi's `redact` option takes literal secret **values**, not names, and values
  from `sensitiveData` are added to it automatically.
- Jev is a Python project. Nothing of it runs at runtime here; it is ported to
  TypeScript, and there is no second process.
- `findEnvKeys()` in `@earendil-works/pi-ai` would be the authoritative
  provider→environment-variable map, but that module is not in the package's
  `exports`, and this project does not import private paths. `doctor` therefore
  uses a local table (`PROVIDER_ENV` in `src/config.ts`) and says so when a
  provider is not in it.
- `@browser_use/pi`'s `exports` map has no `require` condition and does not
  expose `./package.json`, so `doctor` locates the manifest by walking up to
  `node_modules/@browser_use/pi/package.json` rather than resolving it.
