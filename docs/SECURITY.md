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

**Honest limitation.** On the Jev side, approval gates a specific, resolved
element. On the Pi side, the tool is "run this JavaScript", so the gate is a
code inspection (`buildBeforeToolCall`) plus a prohibition stated in the
handoff prompt. A determined model could express a high-risk action in code the
pattern does not match. If you need a hard guarantee for a given site, use
`--prohibited-domain`, or run in `--mode fast`, where there is no fallback.

## Not repeating actions

Every dispatched action that could have taken effect is recorded before the
next observation and is carried into any handoff under `mustNotRepeat`,
including actions where no page change was observed. Failure never triggers an
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

## Reporting

There is no completion claim without evidence. `status: "completed"` is emitted
only when the independent verifier returns `SATISFIED` from a fresh
observation taken after the claim. Everything else is `unverified`, `blocked`,
`stopped_by_approval`, `step_limit`, `timeout` or `error`.
