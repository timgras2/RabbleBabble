import type { AdapterErrorCode } from "../../shared/errorCodes";
import { AdapterError } from "../errors";
import { isRecord } from "./httpRetry";

/**
 * The Worker speaks AdapterErrorCode on the wire, so a failure is read off a
 * field rather than translated through a table that can drift out of step with
 * the server.
 */
export interface ParsedApiError {
  readonly error: AdapterError;
  readonly code: AdapterErrorCode;
}

const KNOWN_CODES = new Set<string>([
  "recording-invalid",
  "recording-too-large",
  "offline",
  "missing-api-key",
  "not-authenticated",
  "not-invited",
  "quota-exceeded",
  "api-unauthorized",
  "api-rate-limited",
  "api-invalid",
  "api-server",
  "api-timeout",
  "empty-transcript",
  "invalid-instruction",
  "rewrite-too-large",
]);

/**
 * Reads the shared error envelope. Returns null when the body is not one -
 * a proxy error page, say - so the caller can fall back to the status code.
 */
export async function parseApiError(response: Response): Promise<ParsedApiError | null> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);

  if (!isRecord(body) || !isRecord(body.error)) {
    return null;
  }

  const detail = body.error;
  if (typeof detail.code !== "string" || !KNOWN_CODES.has(detail.code)) {
    return null;
  }

  const code = detail.code as AdapterErrorCode;
  // Only used as supporting detail, and only when short: the server's wording
  // is a hint, never the headline the user reads.
  const message = typeof detail.message === "string" && detail.message.length <= 160 ? detail.message : "";

  return {
    code,
    error: new AdapterError(message, {
      code,
      retryable: detail.retryable === true,
    }),
  };
}
