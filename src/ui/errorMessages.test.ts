import { AdapterError } from "../platform/errors";
import type { AdapterErrorCode } from "../shared/errorCodes";
import { messageForError } from "./errorMessages";

/**
 * Five lines that catch every code nobody wrote copy for.
 *
 * Three of the twenty-one -- empty-transcript, clipboard-unavailable and
 * clipboard-denied -- fell through to the raw adapter message, which is
 * written for a developer reading a stack trace rather than for someone
 * holding a phone. The `satisfies` below is what makes a NEW code a
 * compile error rather than a silent regression.
 */
const ALL_CODES = [
  "mic-denied",
  "mic-unavailable",
  "recording-invalid",
  "recording-too-long",
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
  "cancelled",
  "clipboard-unavailable",
  "clipboard-denied",
] as const satisfies readonly AdapterErrorCode[];

// Fails to compile if AdapterErrorCode gains a member the list above lacks.
type Missing = Exclude<AdapterErrorCode, (typeof ALL_CODES)[number]>;
const _exhaustive: Missing extends never ? true : never = true;
void _exhaustive;

describe("messageForError", () => {
  it.each(ALL_CODES)("has copy written for %s", (code) => {
    const raw = "internal detail nobody should read";
    const message = messageForError(new AdapterError(raw, { code }));

    expect(message.title.length).toBeGreaterThan(0);
    expect(message.detail.length).toBeGreaterThan(0);
    // The tell for a fall-through: the developer-facing message, verbatim.
    expect(message.detail).not.toBe(raw);
  });
});
