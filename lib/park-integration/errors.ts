export type ParkErrorCode =
  | "unauthenticated"
  | "invalid_request"
  | "unknown_field"
  | "unsupported_version"
  | "unsupported_capability"
  | "unsupported_operation"
  | "forbidden"
  | "unmapped"
  | "asset_mismatch"
  | "job_not_succeeded"
  | "not_publishable"
  | "not_found"
  | "conflict"
  | "duplicate_request"
  | "event_conflict"
  | "unbound_request"
  | "disabled"
  | "lock_busy"
  | "store_unavailable"
  | "store_corrupt"
  | "invalid_transport_result"
  | "transport_unknown"
  | "internal_error";

const DEFAULT_MESSAGES: Record<ParkErrorCode, string> = {
  unauthenticated: "Connection is not authenticated.",
  invalid_request: "Request shape is invalid.",
  unknown_field: "Request contains an unknown field.",
  unsupported_version: "Contract version is not supported.",
  unsupported_capability: "Capability is not supported.",
  unsupported_operation: "Operation is not supported in this direction.",
  forbidden: "Connection is not authorized for this object.",
  unmapped: "Object reference is not mapped to a known object.",
  asset_mismatch: "Mapped asset does not match the configured binding.",
  job_not_succeeded: "Mapped generation job has not succeeded.",
  not_publishable: "Release classification does not permit publication.",
  not_found: "Request was not found.",
  conflict: "Request id was reused with different content.",
  duplicate_request: "Request was already recorded with different content.",
  event_conflict: "Event id was reused with different content.",
  unbound_request: "Event is not bound to a recorded request.",
  disabled: "Outbound transport is not configured; adapter is disabled.",
  lock_busy: "Durable store lock is held; failing closed.",
  store_unavailable: "Durable store is unavailable.",
  store_corrupt: "Durable store contents are invalid.",
  invalid_transport_result: "Transport result failed strict validation.",
  transport_unknown: "Transport result is unknown.",
  internal_error: "Adapter failed closed.",
};

export class ParkError extends Error {
  readonly code: ParkErrorCode;

  constructor(code: ParkErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "ParkError";
    this.code = code;
  }
}

export type ParkFailure = {
  ok: false;
  error: {
    code: ParkErrorCode;
    message: string;
  };
};

export type ParkSuccess<T> = {
  ok: true;
  duplicate?: boolean;
  result: T;
};

export type ParkOutcome<T> = ParkSuccess<T> | ParkFailure;

export function parkOk<T>(result: T, duplicate?: boolean): ParkSuccess<T> {
  return duplicate === undefined ? { ok: true, result } : { ok: true, duplicate, result };
}

export function parkFail(
  code: ParkErrorCode,
  message?: string,
): ParkFailure {
  return {
    ok: false,
    error: { code, message: message ?? DEFAULT_MESSAGES[code] },
  };
}
