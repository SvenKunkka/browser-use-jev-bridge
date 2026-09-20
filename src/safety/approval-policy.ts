/**
 * Risk classification and the human-approval gate.
 *
 * The default posture is: a high-risk action is NOT executed unless a human
 * says so in this session. When nothing can ask a human (no TTY, --json,
 * scheduled run) the gate denies and the run stops safely rather than
 * proceeding. Denial never triggers an automatic retry.
 */

import { createInterface } from 'node:readline/promises';
import type {
  ApprovalDecision,
  ApprovalRequest,
  JevRawAction,
  RiskAssessment,
  RiskLevel,
} from '../types.js';
import type { Redactor } from './redaction.js';

/** Words that make an action consequential. English + Simplified Chinese. */
const HIGH_RISK_TERMS: { term: RegExp; why: string }[] = [
  { term: /\b(buy|purchase|order now|place order|checkout|check out|add to cart|pay|payment|pay now)\b/i, why: 'purchase or payment' },
  { term: /\b(subscribe|upgrade plan|start trial|renew)\b/i, why: 'recurring commitment' },
  { term: /\b(transfer|withdraw|deposit|send money|wire)\b/i, why: 'funds movement' },
  { term: /\b(send|reply|post|publish|tweet|comment|share)\b/i, why: 'outbound message or public content' },
  { term: /\b(delete|remove|erase|destroy|deactivate|close account|unsubscribe all)\b/i, why: 'destructive change' },
  { term: /\b(approve|sign|accept terms|agree|consent|authorize|grant access)\b/i, why: 'approval or consent' },
  { term: /\b(upload|attach file|choose file)\b/i, why: 'file upload' },
  { term: /\b(submit|confirm|place|apply now|book now|reserve)\b/i, why: 'irreversible submission' },
  { term: /(购买|下单|立即购买|加入购物车|结算|结账|付款|支付|充值|提现|转账|汇款)/, why: 'purchase or payment (zh)' },
  { term: /(发送|发布|回复|评论|分享|投稿)/, why: 'outbound message or public content (zh)' },
  { term: /(删除|移除|清空|注销|停用|解绑)/, why: 'destructive change (zh)' },
  { term: /(同意|授权|确认授权|签署|批准|审批|提交审批)/, why: 'approval or consent (zh)' },
  { term: /(上传|选择文件)/, why: 'file upload (zh)' },
  { term: /(提交|确认提交|立即预订|立即申请)/, why: 'irreversible submission (zh)' },
];

const MEDIUM_RISK_TERMS: { term: RegExp; why: string }[] = [
  { term: /\b(login|log in|sign in|sign up|register|continue with)\b/i, why: 'authentication step' },
  { term: /\b(settings|preferences|account|profile|security|privacy)\b/i, why: 'account or settings surface' },
  { term: /(登录|注册|绑定|设置|账户|账号|安全|隐私)/, why: 'authentication or settings (zh)' },
];

const SENSITIVE_FIELD_TERMS =
  /(password|passcode|pin\b|otp|one[- ]time|2fa|mfa|verification code|card number|cvv|cvc|iban|ssn|社保|密码|验证码|银行卡|身份证)/i;

export interface RiskInput {
  operation: string;
  action?: Pick<JevRawAction, 'label' | 'role' | 'kind' | 'href'>;
  url: string;
  /** Visible text near the target, if the caller has it. */
  context?: string;
  /** Free text of a Pi fallback instruction or JS cell, when source === 'pi'. */
  code?: string;
  /**
   * The operator's stated goal, or the handoff's purpose. Assessed before a
   * fallback leg starts so a consequential *intent* is caught even when no
   * generated code has been seen yet.
   */
  intent?: string;
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const reasons: string[] = [];
  let risk: RiskLevel = 'low';

  const haystacks = [
    input.action?.label ?? '',
    input.action?.href ?? '',
    input.code ?? '',
    input.intent ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  for (const { term, why } of HIGH_RISK_TERMS) {
    if (term.test(haystacks)) {
      risk = 'high';
      if (!reasons.includes(why)) reasons.push(why);
    }
  }
  if (risk !== 'high') {
    for (const { term, why } of MEDIUM_RISK_TERMS) {
      if (term.test(haystacks)) {
        risk = 'medium';
        if (!reasons.includes(why)) reasons.push(why);
      }
    }
  }

  // Typing into something that looks like a credential field is always high
  // risk: the value must come from a named secret, never from the text model.
  if (input.operation === 'TYPE_TEXT' && SENSITIVE_FIELD_TERMS.test(input.action?.label ?? '')) {
    risk = 'high';
    reasons.push('credential-like field');
  }

  if (input.operation === 'PI_FALLBACK' && /\b(Input\.dispatchMouseEvent|click\(|submit\(\))/.test(input.code ?? '')) {
    if (risk === 'low') {
      risk = 'medium';
      reasons.push('fallback performs direct input');
    }
  }

  return { risk, reasons, requiresApproval: risk === 'high' };
}

export interface ApprovalGate {
  readonly name: string;
  request(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Called once per step in --review mode even for low-risk actions. */
  review?(request: ApprovalRequest): Promise<ApprovalDecision>;
  close?(): void;
}

/** Default: no human is reachable, so a high-risk action is refused. */
export class DenyHighRiskGate implements ApprovalGate {
  readonly name = 'deny-high-risk';
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!request.assessment.requiresApproval) return { approved: true, reason: 'not high risk', by: 'policy' };
    return {
      approved: false,
      reason:
        'High-risk action requires human confirmation and no interactive approver is attached. ' +
        'Re-run with --review on a terminal to approve individual actions.',
      by: 'policy',
    };
  }
}

/** Interactive terminal gate used by --review and by high-risk prompts on a TTY. */
export class TerminalApprovalGate implements ApprovalGate {
  readonly name = 'terminal';
  private rl: ReturnType<typeof createInterface> | undefined;

  constructor(
    private readonly redactor: Redactor,
    private readonly input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stderr,
  ) {}

  private reader() {
    this.rl ??= createInterface({ input: this.input as never, output: this.output as never });
    return this.rl;
  }

  private render(request: ApprovalRequest): string {
    const lines = [
      '',
      '──────────────────────────────────────────────────────────────',
      `  URL            : ${this.redactor.redact(request.url)}`,
      `  Policy source  : ${request.source === 'jev' ? 'Jev fast policy' : 'Browser Use Pi fallback'}`,
      `  Action type    : ${request.operation}`,
      `  Target element : ${this.redactor.redact(request.targetDescription)}`,
      `  Text to enter  : ${request.textSummary ?? '(none)'}`,
      `  Risk level     : ${request.assessment.risk}${
        request.assessment.reasons.length ? ` (${request.assessment.reasons.join('; ')})` : ''
      }`,
      '──────────────────────────────────────────────────────────────',
    ];
    return lines.join('\n');
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.output.write(`${this.render(request)}\n`);
    const answer = (await this.reader().question('  Execute this action? [y/N] ')).trim().toLowerCase();
    const approved = answer === 'y' || answer === 'yes';
    return {
      approved,
      reason: approved ? 'operator approved' : 'operator declined',
      by: 'operator',
    };
  }

  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.request(request);
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }
}

/** Test-only gate. Never selected by the CLI. */
export class ScriptedApprovalGate implements ApprovalGate {
  readonly name = 'scripted';
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answers: boolean[] | ((request: ApprovalRequest) => boolean)) {}
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(request);
    const approved =
      typeof this.answers === 'function' ? this.answers(request) : (this.answers.shift() ?? false);
    return { approved, reason: approved ? 'scripted approve' : 'scripted deny', by: 'operator' };
  }
  async review(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.request(request);
  }
}
