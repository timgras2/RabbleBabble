import type { App } from "../app";
import { ApiError, payloadTooLarge } from "../errors";
import { normaliseEmail } from "../db/users";
import { sha256Hex } from "../auth/crypto";
import { parseEmailEvent, severityOf, verifyWebhookSignature } from "./webhook";

/**
 * A bounce payload is a type, two enum-ish fields and one diagnostic line.
 * Larger than a sign-in body, nowhere near a transcript.
 */
const MAX_WEBHOOK_BODY_BYTES = 32_768;

/**
 * Resend's delivery events.
 *
 * The path sits under `/auth/` for one unglamorous reason: `wrangler.jsonc`
 * lists `/auth/*` and `/v1/*` in `run_worker_first`, and everything else is
 * served by the asset handler with single-page-application fallback. A webhook
 * on any other prefix would get 200 and the app shell, which Resend would
 * record as a successful delivery of nothing. It is not an auth route and
 * carries none of the auth guards - see below.
 */
export function registerEmailRoutes(app: App): void {
  app.post("/auth/email-events", async (c) => {
    const { config, clock } = c.get("deps");

    // Fail closed. A deployment with no secret has no endpoint, rather than an
    // endpoint that accepts anything.
    if (config.resendWebhookSecret === "") {
      throw new ApiError({
        status: 404,
        code: "api-invalid",
        reason: "invalid-body",
        message: "Unknown endpoint.",
      });
    }

    // No requireSameSite and no requireClientHeader, deliberately: this is a
    // server-to-server POST from Resend with no Origin at all, and both guards
    // would reject every real call. The HMAC below is the whole authentication.
    const body = await readBoundedText(c.req.raw);
    const verdict = await verifyWebhookSignature(config.resendWebhookSecret, c.req.raw.headers, body, clock.nowSeconds());

    if (verdict !== "ok") {
      console.error(
        JSON.stringify({
          requestId: c.get("requestId"),
          event: "email-event-rejected",
          reason: verdict,
        }),
      );
      // 401 rather than 400, so Svix retries: the common cause is a secret
      // that was rotated in one place and not the other.
      throw new ApiError({
        status: 401,
        code: "not-authenticated",
        reason: "not-authenticated",
        message: "That webhook was not signed by Resend.",
      });
    }

    const event = parseEmailEvent(safeParse(body));
    const severity = event === null ? null : severityOf(event.type);

    if (event !== null && severity !== null) {
      const line = JSON.stringify({
        requestId: c.get("requestId"),
        event: "email-event",
        provider: "resend",
        type: event.type,
        providerMessageId: event.emailId,
        // The same digest `auth/request-link` rate-limits on, so an operator
        // can join a bounce to a sign-in attempt without either log line ever
        // carrying the address. Resolving it back to a person is a deliberate
        // act with `scripts/user.mjs`, not something a log reader does by
        // accident.
        recipientHash: event.recipient === null ? null : await sha256Hex(normaliseEmail(event.recipient)),
        bounceType: event.bounceType,
        bounceSubType: event.bounceSubType,
        detail: event.detail,
      });
      if (severity === "error") {
        console.error(line);
      } else {
        console.log(line);
      }
    }

    // 204 for anything correctly signed, including an event type this does not
    // log. A 4xx would make Resend retry a payload that will never be wanted.
    return c.body(null, 204);
  });
}

async function readBoundedText(request: Request): Promise<string> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    throw payloadTooLarge("That request body is too large.", "api-invalid");
  }
  // The exact bytes, not a re-serialised object: the signature covers the
  // body as sent, so `JSON.parse` then `JSON.stringify` would never verify.
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_WEBHOOK_BODY_BYTES) {
    throw payloadTooLarge("That request body is too large.", "api-invalid");
  }
  return text;
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
