import type { AdapterErrorCode, BackendErrorReason } from "../../src/shared/errorCodes";
import type { ApiErrorBody } from "../../src/shared/wire";

/**
 * Every failure the Worker returns is one of these.
 *
 * `code` is an AdapterErrorCode taken verbatim from the browser's own error
 * vocabulary, so BackendClient maps a failure by reading a field rather than
 * maintaining a translation table that can drift. `reason` carries the extra
 * resolution the UI needs for good copy without widening that union.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: AdapterErrorCode;
  readonly reason: BackendErrorReason;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** Logged, never sent. Keeps upstream detail out of the user's face. */
  readonly internal?: unknown;

  constructor(options: {
    readonly status: number;
    readonly code: AdapterErrorCode;
    readonly reason: BackendErrorReason;
    readonly message: string;
    readonly retryable?: boolean;
    readonly retryAfterSeconds?: number;
    readonly internal?: unknown;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.reason = options.reason;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.internal = options.internal;
  }
}

export function toErrorBody(error: ApiError, requestId: string): ApiErrorBody {
  return {
    error: {
      code: error.code,
      reason: error.reason,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      requestId,
    },
  };
}

// Named constructors, so a route reads as policy rather than as status codes.

export const notAuthenticated = (reason: BackendErrorReason = "not-authenticated") =>
  new ApiError({
    status: 401,
    code: "not-authenticated",
    reason,
    message: "Sign in to continue.",
  });

export const accountSuspended = () =>
  new ApiError({
    status: 403,
    code: "api-unauthorized",
    reason: "account-suspended",
    message: "This account is not active.",
  });

export const originRejected = () =>
  new ApiError({
    status: 403,
    code: "api-unauthorized",
    reason: "origin-rejected",
    message: "This request did not come from the app.",
  });

export const invalidBody = (message: string, code: AdapterErrorCode = "api-invalid") =>
  new ApiError({ status: 400, code, reason: "invalid-body", message });

export const payloadTooLarge = (message: string, code: AdapterErrorCode) =>
  new ApiError({ status: 413, code, reason: "payload-too-large", message });

export const unsupportedMediaType = (message: string) =>
  new ApiError({ status: 415, code: "api-invalid", reason: "unsupported-media-type", message });

export const rateLimited = (reason: BackendErrorReason, message: string, retryAfterSeconds?: number) =>
  new ApiError({
    status: 429,
    code: reason === "user-daily-quota" || reason === "global-spend-cap" ? "quota-exceeded" : "api-rate-limited",
    reason,
    message,
    retryable: true,
    retryAfterSeconds,
  });

export const emptyResult = (message: string) =>
  new ApiError({ status: 502, code: "empty-transcript", reason: "empty-result", message });

export const upstreamUnavailable = (internal?: unknown) =>
  new ApiError({
    status: 502,
    code: "api-server",
    reason: "upstream-unavailable",
    message: "The transcription service is having trouble. Try again.",
    retryable: true,
    internal,
  });

export const upstreamTimeout = (internal?: unknown) =>
  new ApiError({
    status: 504,
    code: "api-timeout",
    reason: "upstream-timeout",
    message: "The transcription service took too long.",
    retryable: true,
    internal,
  });

export const upstreamInvalid = (internal?: unknown) =>
  new ApiError({
    status: 502,
    code: "api-invalid",
    reason: "upstream-invalid",
    message: "The transcription service rejected the request.",
    internal,
  });

/**
 * A bad central Groq key is our configuration bug, not the user's. Reporting it
 * as api-unauthorized would tell them to fix an API key setting that no longer
 * exists in the hosted app, so it surfaces as a plain server error and shouts
 * in the logs instead.
 */
export const internalError = (internal?: unknown) =>
  new ApiError({
    status: 500,
    code: "api-server",
    reason: "internal",
    message: "Something went wrong on our side.",
    retryable: true,
    internal,
  });
