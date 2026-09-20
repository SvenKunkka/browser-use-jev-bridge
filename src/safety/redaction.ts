/**
 * Redaction is applied at the boundary of every sink that can persist or print
 * text: audit log, CLI output, error messages and run summaries.
 *
 * Two layers:
 *  1. Registered values — named secrets and any env value we were told about.
 *     These are replaced by "«REDACTED:NAME»" wherever they appear.
 *  2. Shape heuristics — strings that look like credentials even though we were
 *     never told about them (provider key prefixes, bearer headers).
 *
 * Layer 1 is exact and authoritative. Layer 2 is best effort and exists so an
 * accidental leak through a third-party error message is still unlikely to be
 * written to disk. Neither layer is a substitute for not putting secrets in
 * places they do not belong.
 */

const MIN_REGISTERED_LENGTH = 6;

/** Ordered so longer, more specific patterns win. */
const SHAPE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'BEARER', pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'AUTH_HEADER', pattern: /("?[Aa]uthorization"?\s*[:=]\s*")([^"]{6,})(")/g },
  { name: 'PROVIDER_KEY', pattern: /\b(?:sk|pk|rk|xai|gsk|ghp|ghs|github_pat)[-_][A-Za-z0-9_-]{12,}/g },
  { name: 'AWS_KEY', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'URL_CREDENTIALS', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi },
];

export class Redactor {
  private readonly registered = new Map<string, string>();

  /** Register a literal secret value under a stable display name. */
  register(name: string, value: string | undefined | null): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length < MIN_REGISTERED_LENGTH) return;
    this.registered.set(trimmed, name.toUpperCase());
  }

  /** Register every environment variable whose name looks credential-bearing. */
  registerEnvironment(env: NodeJS.ProcessEnv = process.env): void {
    const suspicious = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION)/i;
    for (const [name, value] of Object.entries(env)) {
      if (suspicious.test(name)) this.register(name, value);
    }
  }

  get registeredCount(): number {
    return this.registered.size;
  }

  redact(input: string): string {
    if (!input) return input;
    let output = input;
    // Longest first: a short secret that is a substring of a longer one must
    // not break the longer replacement.
    const values = [...this.registered.keys()].sort((a, b) => b.length - a.length);
    for (const value of values) {
      if (!output.includes(value)) continue;
      output = output.split(value).join(`«REDACTED:${this.registered.get(value)}»`);
    }
    for (const { name, pattern } of SHAPE_PATTERNS) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, (match, ...groups) => {
        if (name === 'AUTH_HEADER') return `${groups[0]}«REDACTED:AUTH_HEADER»${groups[2]}`;
        if (name === 'URL_CREDENTIALS') return `${groups[0]}«REDACTED:URL_CREDENTIALS»@`;
        return `«REDACTED:${name}»`;
      });
    }
    return output;
  }

  /** Deep-redact any JSON-serialisable value. Keys are preserved. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item)) as unknown as T;
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = this.redactValue(item);
      }
      return output as unknown as T;
    }
    return value;
  }

  /**
   * A short, non-sensitive description of text that is about to be typed.
   * Never returns the text itself when it matches a registered secret.
   */
  summarizeTyped(text: string): string {
    const redacted = this.redact(text);
    if (redacted !== text) return `«secret value, ${text.length} chars»`;
    const oneLine = redacted.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= 60) return oneLine;
    return `${oneLine.slice(0, 57)}… (${oneLine.length} chars)`;
  }
}

export const defaultRedactor = new Redactor();
