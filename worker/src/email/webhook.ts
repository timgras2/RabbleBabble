import { safeEqual } from "../auth/crypto";
import { redactAddresses } from "./port";

/**
 * Verification and parsing for Resend's delivery webhooks.
 *
 * This is the only channel that can answer the question the send path
 * structurally cannot: whether the receiver *kept* the mail. A 200 from
 * `POST /emails` means Resend accepted the message, nothing more. After that
 * the message can be deferred, rejected at the far end, or - the case that
 * looks most like a working system - accepted and filed somewhere the
 * recipient never looks. Worse, a hard bounce puts the address on Resend's
 * suppression list, after which every later send still returns 200 with a
 * fresh id and is silently discarded. Without these events an address can be
 * permanently undeliverable while the logs say `email-sent` every time.
 *
 * Resend signs with the Standard Webhooks scheme (Svix): an HMAC-SHA256 over
 * `id.timestamp.body`, keyed by the base64 body of a `whsec_` secret.
 */

/** Replay window. Svix's own default, and generous for a webhook. */
const TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = "whsec_";
const MAX_DETAIL_CHARS = 300;

/** Svix's own header names, and the vendor-neutral ones it also accepts. */
const ID_HEADERS = ["svix-id", "webhook-id"] as const;
const TIMESTAMP_HEADERS = ["svix-timestamp", "webhook-timestamp"] as const;
const SIGNATURE_HEADERS = ["svix-signature", "webhook-signature"] as const;

export interface EmailEvent {
  /** For example "email.bounced". */
  readonly type: string;
  /** Resend's id for the message: the same value `email-sent` logs. */
  readonly emailId: string | null;
  /** The raw recipient. Hashed before it reaches a log line, never stored. */
  readonly recipient: string | null;
  readonly bounceType: string | null;
  readonly bounceSubType: string | null;
  /** The remote MTA's diagnostic, with any addresses stripped out. */
  readonly detail: string | null;
}

export type VerifyResult = "ok" | "unsigned" | "stale" | "mismatch" | "unusable-secret";

function firstHeader(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

/**
 * Distinguishes the failure modes rather than returning a boolean, because
 * they mean different things to an operator: `mismatch` is a wrong secret or a
 * forgery, `stale` is a replay or a clock, `unsigned` is usually someone
 * poking the endpoint by hand.
 */
export async function verifyWebhookSignature(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds: number,
): Promise<VerifyResult> {
  const id = firstHeader(headers, ID_HEADERS);
  const timestamp = firstHeader(headers, TIMESTAMP_HEADERS);
  const signatures = firstHeader(headers, SIGNATURE_HEADERS);
  if (id === null || timestamp === null || signatures === null) {
    return "unsigned";
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > TOLERANCE_SECONDS) {
    return "stale";
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decodeBase64(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // A secret that is not base64 is a deployment mistake, not a bad request.
    return "unusable-secret";
  }

  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = encodeBase64(new Uint8Array(mac));

  // Space-delimited `v1,<base64>` pairs: a secret being rotated signs twice.
  for (const entry of signatures.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") {
      continue;
    }
    if (safeEqual(entry.slice(comma + 1), expected)) {
      return "ok";
    }
  }
  return "mismatch";
}

/** `null` for a body that is not an event at all. */
export function parseEmailEvent(payload: unknown): EmailEvent | null {
  const root = asRecord(payload);
  const type = typeof root.type === "string" ? root.type : null;
  if (type === null) {
    return null;
  }

  const data = asRecord(root.data);
  const bounce = asRecord(data.bounce);
  const failed = asRecord(data.failed);
  const recipients = Array.isArray(data.to) ? data.to : [];
  const detail =
    readString(bounce.message) ?? readString(failed.reason) ?? readString(asRecord(data.complaint).message);

  return {
    type,
    emailId: readString(data.email_id),
    recipient: typeof recipients[0] === "string" ? recipients[0] : null,
    bounceType: readString(bounce.type),
    bounceSubType: readString(bounce.subType) ?? readString(bounce.sub_type),
    detail: detail === null ? null : redactAddresses(detail).slice(0, MAX_DETAIL_CHARS),
  };
}

/**
 * Which events are worth a log line, and at what level.
 *
 * `email.opened` and `email.clicked` are deliberately absent. They only fire
 * when open or click tracking is on, that tracking works by rewriting links
 * and embedding a pixel - both of which cost deliverability, which is the
 * problem this endpoint exists to solve - and neither says anything this
 * application has a use for.
 */
export function severityOf(type: string): "error" | "info" | null {
  if (type === "email.bounced" || type === "email.complained" || type === "email.failed") {
    return "error";
  }
  if (type === "email.sent" || type === "email.delivered" || type === "email.delivery_delayed") {
    return "info";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
