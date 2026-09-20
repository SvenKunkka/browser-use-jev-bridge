/**
 * Errors shared between the browser session and the policies above it.
 * Kept in their own module so `pi/session.ts` and `jev/executor.ts` can both
 * throw and catch them without importing each other at runtime.
 */

/** The run's deadline fired, or the caller cancelled. */
export class RunAbortedError extends Error {
  constructor(
    message: string,
    /** 'deadline' when the run budget expired, 'caller' when the caller cancelled. */
    readonly reason: 'deadline' | 'caller' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'RunAbortedError';
  }
}
