export class ApplicationError extends Error {
  constructor(code, message, { details = [], exitCode = 2, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
    this.retryable = retryable;
  }
}

export function publicError(error) {
  if (error instanceof ApplicationError) return error;
  const known = {
    IDEMPOTENCY_CONFLICT: ['IDEMPOTENCY_CONFLICT', 'The key already identifies a different plan.', 2],
    NOT_FOUND: ['NOT_FOUND', 'Experiment not found in this project.', 2],
    SNAPSHOT_INTEGRITY_ERROR: ['INTEGRITY_ERROR', 'Stored snapshot integrity check failed.', 1],
    EVIDENCE_INTEGRITY_ERROR: ['INTEGRITY_ERROR', 'Stored evidence integrity check failed.', 1],
    INVOCATION_INTEGRITY_ERROR: ['INTEGRITY_ERROR', 'Stored invocation integrity check failed.', 1],
    ASSESSMENT_INTEGRITY_ERROR: ['INTEGRITY_ERROR', 'Stored assessment integrity check failed.', 1],
  };
  const entry = known[error?.message];
  if (entry) return new ApplicationError(entry[0], entry[1], { exitCode: entry[2] });
  // Never return arbitrary exception messages (file contents, paths and credentials can occur there).
  return new ApplicationError('INTERNAL_ERROR', 'Operation failed. Check local storage and runtime configuration.', { exitCode: 1 });
}
