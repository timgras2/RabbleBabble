/**
 * The error currency of the whole app, and the wire contract with the Worker.
 *
 * The Worker returns one of these codes verbatim, so BackendClient maps a
 * failure by reading a field rather than by maintaining a translation table.
 */
export type AdapterErrorCode =
  | "mic-denied"
  | "mic-unavailable"
  | "recording-invalid"
  | "recording-too-long"
  | "recording-too-large"
  | "offline"
  | "missing-api-key"
  | "not-authenticated"
  | "not-invited"
  | "quota-exceeded"
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

/**
 * A machine-readable sub-code carried alongside the AdapterErrorCode.
 *
 * It exists so the UI can say "your daily limit is used up" rather than
 * "rate limited" without widening AdapterErrorCode into something the
 * recorder screen has to exhaustively switch over.
 */
export type BackendErrorReason =
  | "not-authenticated"
  | "session-expired"
  | "account-suspended"
  | "origin-rejected"
  | "invalid-body"
  | "payload-too-large"
  | "unsupported-media-type"
  | "email-invalid"
  | "invite-required"
  | "invite-invalid"
  | "auth-rate-limited"
  | "link-invalid"
  | "link-expired"
  | "link-consumed"
  | "link-wrong-device"
  | "user-daily-quota"
  | "global-spend-cap"
  | "upstream-rate-limited"
  | "upstream-unavailable"
  | "upstream-timeout"
  | "upstream-invalid"
  | "empty-result"
  | "internal";
