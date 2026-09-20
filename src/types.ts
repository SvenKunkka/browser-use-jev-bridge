/**
 * Shared vocabulary for the hybrid bridge.
 *
 * The Jev-derived shapes (JevRawAction, JevSnapshot, ActionSpace) mirror the
 * upstream jev-ultrafast data model so the ported policy code stays readable
 * next to its Python original. See LICENSES/ and docs/ARCHITECTURE.md.
 */

export type JevOperation =
  | 'CLICK'
  | 'TYPE_TEXT'
  | 'SELECT'
  | 'SCROLL_UP'
  | 'SCROLL_DOWN'
  | 'WAIT'
  | 'DONE'
  | 'BLOCKED';

export const JEV_OPERATIONS: readonly JevOperation[] = [
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'WAIT',
  'DONE',
  'BLOCKED',
];

/** Action kinds produced by the in-page snapshot script. */
export type JevActionKind = 'click' | 'fill' | 'select' | 'scroll' | 'wait';

export interface JevRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One concrete, observed, executable action. `node` is a code-owned DOM id. */
export interface JevRawAction {
  id: string;
  kind: JevActionKind;
  label: string;
  /** Present for DOM-bound actions; absent for scroll/wait pseudo-actions. */
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  href?: string | null;
  rect?: JevRect;
  /** Scroll delta in CSS pixels, for kind === 'scroll'. */
  delta?: number;
}

/** Page-level signals the router uses to decide "Jev cannot own this page". */
export interface UnsupportedSignals {
  iframes: number;
  crossOriginIframes: number;
  fileInputs: number;
  canvases: number;
  shadowRoots: number;
  openDialogs: number;
  passwordFields: number;
}

/** What the in-page snapshot script returns, after in-page digesting. */
export interface JevSnapshot {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  scroll: { y: number; height: number };
  actions: JevRawAction[];
  /** Digest of the full semantic marker (identity + meaning of the page). */
  marker: string;
  /** Digest of form-control state only. */
  pageKey: string;
  /** node id -> digest of that node's guard tuple. */
  guards: Record<string, string | null>;
  omittedActions: number;
  unsupported: UnsupportedSignals;
  tabCount?: number;
  /** sha256 over (url, text, actions, scroll) — computed host-side. */
  fingerprint: string;
  observedAt: number;
}

export interface ActionSpaceElement {
  index: string;
  label: string;
  role?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  operations: JevOperation[];
  options?: { index: string; label: string; value: string }[];
}

export interface ActionSpace {
  elements: ActionSpaceElement[];
  /** operation -> (target index -> concrete action) */
  targets: Partial<Record<JevOperation, Record<string, JevRawAction>>>;
  /** control operation name (SCROLL_DOWN/SCROLL_UP/WAIT) -> concrete action */
  controls: Partial<Record<JevOperation, JevRawAction>>;
}

export interface TypeSafeAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface TypeSafeResponse {
  answers: Record<string, TypeSafeAnswer>;
  model?: string;
  usage?: Record<string, unknown>;
}

/** A decision is valid only for the exact page fingerprint it was made on. */
export interface Decision {
  /** Action id (e.g. "e7", "scroll_down", "wait") or 'DONE' / 'BLOCKED'. */
  choice: string;
  operation: JevOperation;
  target: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  model?: string;
  usage?: Record<string, unknown>;
  latencyMs: number;
  /** Fingerprint of the snapshot this decision was computed from. */
  fingerprint: string;
}

export type ActionSource = 'jev' | 'pi';

/** Append-only record of something that reached, or may have reached, the browser. */
export interface ActionRecord {
  step: number;
  source: ActionSource;
  operation: JevOperation | 'PI_FALLBACK';
  kind: JevActionKind | 'pi';
  actionId: string;
  label: string;
  url: string;
  /** Redacted summary of typed text; never the raw secret. */
  textSummary?: string;
  risk: RiskLevel;
  approved?: boolean;
  pageChanged: boolean | null;
  fingerprintBefore: string;
  fingerprintAfter?: string;
  startedAt: number;
  finishedAt: number;
  /** True when the action may already have taken effect (never auto-replay). */
  effectUncertain: boolean;
  /** How far this action got. See ExecutionPhase. */
  executionPhase: ExecutionPhase;
  /** Ordered trail of phase transitions, for the audit log and for reviewers. */
  phases: ExecutionPhaseEvent[];
}

/**
 * How far an action got. The point of this enum is that "we do not know" is a
 * first-class answer: an action that may already have changed the page must
 * never be filed as "not executed" and must never be re-planned.
 */
export type ExecutionPhase =
  /** Refused before anything could have a side effect. Definitely not executed. */
  | 'preflight_failed'
  /** The next operation can have a side effect. Recorded BEFORE it runs. */
  | 'dispatch_started'
  /** Input was handed to the browser and the call returned. */
  | 'dispatched'
  /** It may or may not have taken effect. Treat as executed. */
  | 'effect_uncertain'
  /** A post-action observation exists. */
  | 'observed';

export interface ExecutionPhaseEvent {
  phase: ExecutionPhase;
  detail: string;
  /** True once a side effect is possible. Once true it never goes back to false. */
  effectPossible: boolean;
  at: number;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  risk: RiskLevel;
  reasons: string[];
  requiresApproval: boolean;
}

export interface ApprovalRequest {
  url: string;
  source: ActionSource;
  operation: string;
  actionLabel: string;
  targetDescription: string;
  /** Non-sensitive summary only. */
  textSummary?: string;
  assessment: RiskAssessment;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
  /** 'operator' when a human answered; 'policy' when the gate decided. */
  by: 'operator' | 'policy';
}

/** Structured context handed to the Pi fallback. Required by the spec. */
export interface HandoffContext {
  goal: string;
  currentUrl: string;
  completedActions: ActionRecord[];
  fallbackReason: string;
  mustNotRepeat: string[];
  stopCondition: string;
}

export type FallbackReason =
  | 'jev_blocked'
  | 'unsupported_page'
  | 'stale_repeated'
  | 'no_progress'
  | 'step_limit'
  | 'decision_error'
  | 'text_helper_unavailable'
  | 'credential_field'
  | 'uncertain_effect'
  | 'operator_request';

export interface VerificationResult {
  verified: boolean;
  verdict: 'SATISFIED' | 'NOT_SATISFIED' | 'INSUFFICIENT_EVIDENCE' | 'NOT_RUN';
  confidence: number | null;
  /** Probability mass the verifier put on SATISFIED, when a verdict was obtained. */
  satisfiedProbability?: number;
  reasons: string[];
  evidence: {
    url: string;
    title: string;
    fingerprint: string;
    textExcerpt: string;
    observedAt: number;
  } | null;
  deterministicChecks: { name: string; passed: boolean; detail: string }[];
}

export type RunStatus =
  | 'completed'
  | 'unverified'
  | 'blocked'
  | 'stopped_by_approval'
  | 'step_limit'
  | 'timeout'
  | 'cost_limit'
  | 'cancelled'
  | 'error';

export interface RunOutcome {
  status: RunStatus;
  goal: string;
  startUrl: string;
  finalUrl: string;
  steps: number;
  jevSteps: number;
  piFallbacks: number;
  history: ActionRecord[];
  verification: VerificationResult;
  fallbackReasons: FallbackReason[];
  durationMs: number;
  /** Initial, used and remaining budget for the whole run. */
  budget?: import('./budget.js').BudgetReport;
  auditLogPath?: string;
  /** Present only for failures; already redacted. */
  error?: string;
  notes: string[];
}
