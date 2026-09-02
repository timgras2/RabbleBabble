export type AdapterErrorCode =
  | "mic-denied"
  | "mic-unavailable"
  | "recording-invalid"
  | "recording-too-long"
  | "recording-too-large"
  | "offline"
  | "missing-api-key"
  | "api-unauthorized"
  | "api-rate-limited"
  | "api-invalid"
  | "api-server"
  | "api-timeout"
  | "empty-transcript"
  | "invalid-instruction"
  | "rewrite-too-large"
  | "cancelled"
  | "clipboard-unavailable"
  | "clipboard-denied";

export interface AdapterErrorOptions {
  readonly code: AdapterErrorCode;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(message: string, options: AdapterErrorOptions) {
    super(message);
    this.name = "AdapterError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}
