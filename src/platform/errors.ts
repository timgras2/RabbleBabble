import type { AdapterErrorCode } from "../shared/errorCodes";

export type { AdapterErrorCode };

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
