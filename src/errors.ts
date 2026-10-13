/** Stable machine-readable error codes. Documented in docs/API.md. */
export type ErrorCode =
  | 'bad_request'
  | 'payload_too_large'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'unknown_game'
  | 'unsupported_build'
  | 'ruleset_disabled'
  | 'run_active'
  | 'run_not_active'
  | 'sequence_conflict'
  | 'timing_rejected'
  | 'run_rejected'
  | 'rate_limited'
  | 'capacity'
  | 'internal';

export const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  payload_too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unknown_game: 404,
  unsupported_build: 422,
  ruleset_disabled: 422,
  run_active: 409,
  run_not_active: 409,
  sequence_conflict: 409,
  timing_rejected: 422,
  run_rejected: 422,
  rate_limited: 429,
  capacity: 503,
  internal: 500,
};

export type Failure = { ok: false; code: ErrorCode; message: string; details?: unknown };
export type Result<T> = ({ ok: true } & T) | Failure;

export const fail = (code: ErrorCode, message: string, details?: unknown): Failure =>
  details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };

export class ApiError extends Error {
  readonly failure: Failure;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.failure = fail(code, message, details);
  }
}
