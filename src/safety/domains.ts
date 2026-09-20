/**
 * Domain allow/deny policy.
 *
 * Implemented here (rather than only delegating to Pi) for three reasons:
 *  - the Jev fast path navigates and clicks without going through Pi's agent,
 *    so it needs the same gate applied host-side before every action;
 *  - it must be unit-testable offline;
 *  - the same object is handed to Pi via `allowedDomains` / `prohibitedDomains`
 *    so both halves of the hybrid enforce one configuration.
 *
 * Semantics (matching Pi's documented behaviour):
 *  - patterns are exact hosts, or `*.example.com` which also matches the apex;
 *  - a denial always wins over an allowance;
 *  - when an allow list is set, only http(s) URLs can pass.
 */

export interface DomainPolicyOptions {
  allowedDomains?: string[];
  prohibitedDomains?: string[];
}

export interface DomainVerdict {
  allowed: boolean;
  reason: string;
}

export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (!p || !h) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const apex = p.slice(2);
    return h === apex || h.endsWith(`.${apex}`);
  }
  return h === p;
}

export class DomainPolicy {
  readonly allowed: string[];
  readonly prohibited: string[];

  constructor(options: DomainPolicyOptions = {}) {
    this.allowed = (options.allowedDomains ?? []).filter(Boolean);
    this.prohibited = (options.prohibitedDomains ?? []).filter(Boolean);
  }

  get isEnforcing(): boolean {
    return this.allowed.length > 0 || this.prohibited.length > 0;
  }

  check(rawUrl: string): DomainVerdict {
    if (!this.isEnforcing) return { allowed: true, reason: 'no domain policy configured' };

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: `unparsable URL rejected under an active domain policy` };
    }

    const scheme = url.protocol.replace(':', '');
    if (this.allowed.length > 0 && scheme !== 'http' && scheme !== 'https') {
      return { allowed: false, reason: `scheme "${scheme}" is not http(s) and an allow list is active` };
    }

    const host = url.hostname;
    for (const pattern of this.prohibited) {
      if (hostMatches(pattern, host)) {
        return { allowed: false, reason: `host "${host}" matches prohibited pattern "${pattern}"` };
      }
    }
    if (this.allowed.length === 0) return { allowed: true, reason: `host "${host}" is not prohibited` };

    for (const pattern of this.allowed) {
      if (hostMatches(pattern, host)) {
        return { allowed: true, reason: `host "${host}" matches allowed pattern "${pattern}"` };
      }
    }
    return { allowed: false, reason: `host "${host}" is not in the allow list` };
  }

  assert(rawUrl: string): void {
    const verdict = this.check(rawUrl);
    if (!verdict.allowed) throw new DomainBlockedError(rawUrl, verdict.reason);
  }
}

export class DomainBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly detail: string,
  ) {
    super(`Navigation blocked by domain policy: ${detail}`);
    this.name = 'DomainBlockedError';
  }
}
