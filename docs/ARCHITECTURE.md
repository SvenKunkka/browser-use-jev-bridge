# Architecture

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
                    ┌──────────────────────────────┐
  CLI / Codex tool  │  bu-fast run --url --goal     │
                    └───────────────┬──────────────┘
                                    │
                    ┌───────────────▼──────────────┐
                    │        Hybrid router          │
                    │  observe → route → decide →   │
                    │  risk → approve → guard →     │
                    │  execute → re-observe         │
                    └───────┬───────────────┬───────┘
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
| `src/cli.ts` | `run` / `verify` / `doctor`, flag parsing, exit codes. No credential ever arrives as a flag. |
| `src/config.ts` | Environment → `BridgeConfig`; `describeConfig()` produces a printable form where every secret collapses to `set`/`unset`. |
| `src/pi/session.ts` | The single owner. Wraps `BrowserUse`; exposes `evaluateInPage`, `cdp`, `cdpBatch`, `goto`, `info`, `tabCount`, `run`, `followUp`, `close`. |
| `src/pi/fallback.ts` | Renders the handoff, runs the Pi leg under a budget, and supplies the `beforeToolCall` inspection hook. |
| `src/jev/snapshot.ts` | The in-page sources: full observation, marker, node guard, pre-input target resolution, post-input settle. |
| `src/jev/action-space.ts` | One index per element; one target set per operation. |
| `src/jev/policy.ts` | One TypeSafe request per step; strict validation of both heads. |
| `src/jev/text-helper.ts` | The separate small model that writes field values, and nothing else. |
| `src/jev/freshness.ts` | Fingerprints, stale errors, guard comparison. |
| `src/jev/executor.ts` | Observation retries, guard enforcement, CDP input dispatch. |
| `src/router/hybrid-router.ts` | The loop, the routing rules, the counters, the budgets. |
| `src/router/handoff.ts` | `HandoffContext`, `mustNotRepeat`, the literal fallback prompt. |
| `src/safety/*` | Domain policy, risk classification and approval gates, redaction. |
| `src/verification/verifier.ts` | Deterministic checks plus one independent model verdict. |
| `src/logging/audit-log.ts` | Redacted JSONL, written synchronously. |
| `src/testing/harness.ts` | Offline harness: headless Chromium, a Pi session with a throwing model transport, scripted TypeSafe/text clients. |

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
| Step budget reached | Pi once, then a safe stop |
| `--mode fast` and any of the above | Safe stop, never a guess |

After a Pi leg the router **always** re-observes. The new observation produces a
new fingerprint and new node ids; any decision from before the handoff is dead
by construction, because a decision only executes against the fingerprint it
was made on.

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
   `thresholds.jevMaxSteps`; the run-level budget is separate and operator-set.

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
