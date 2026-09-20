/**
 * Append-only audit log.
 *
 * One JSON object per line, written synchronously so a crash mid-run still
 * leaves an accurate record of what reached the browser. Every record passes
 * through the redactor first; the log is designed to be readable by a reviewer
 * who is not allowed to see the operator's credentials.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Redactor } from '../safety/redaction.js';

export type AuditEventType =
  | 'run_start'
  | 'config'
  | 'observation'
  | 'decision'
  | 'execution_phase'
  | 'mcp'
  | 'risk'
  | 'approval'
  | 'execution'
  | 'stale'
  | 'fallback_start'
  | 'fallback_end'
  | 'verification'
  | 'run_end'
  | 'error'
  | 'note';

export interface AuditEvent {
  type: AuditEventType;
  [key: string]: unknown;
}

export class AuditLog {
  readonly path: string;
  private sequence = 0;
  readonly entries: (AuditEvent & { sequence: number; timestamp: string })[] = [];

  /**
   * `onRecord` receives every already-redacted record. The MCP layer uses it
   * as its live progress feed, so there is exactly one place where run events
   * are produced and exactly one redaction pass over them.
   */
  onRecord: ((record: AuditEvent & { sequence: number; timestamp: string }) => void) | undefined;

  constructor(
    directory: string,
    private readonly redactor: Redactor,
    private readonly runId: string,
    private readonly persist = true,
  ) {
    this.path = join(directory, `audit-${runId}.jsonl`);
    if (this.persist) mkdirSync(dirname(this.path), { recursive: true });
  }

  write(event: AuditEvent): void {
    const record = {
      ...this.redactor.redactValue(event),
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(record as AuditEvent & { sequence: number; timestamp: string });
    try {
      this.onRecord?.(record as AuditEvent & { sequence: number; timestamp: string });
    } catch {
      // A broken observer must never break the run.
    }
    if (!this.persist) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Losing the log must never abort a run that is already in flight.
    }
  }
}

/** In-memory log used by tests. */
export class MemoryAuditLog extends AuditLog {
  constructor(redactor: Redactor, runId = 'test') {
    super('/dev/null-not-used', redactor, runId, false);
  }
}
