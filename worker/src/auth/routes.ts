import { MAX_AUTH_BODY_BYTES } from "../../../src/shared/limits";
import type { RequestLinkResponse } from "../../../src/shared/wire";
import type { App } from "../app";
import { ApiError, invalidBody, rateLimited } from "../errors";
import { requireClientHeader, requireSameSite } from "../http/guards";
import { readJsonBody, readOptionalString, readString } from "../http/json";
import { createUser, findUserByEmail, isPlausibleEmail, normaliseEmail } from "../db/users";
import { consumeRateLimits, dayWindow, hourWindow } from "../db/rateLimits";
import { EmailSendError, magicLinkEmail } from "../email/port";
import { hashIp, isWellFormedToken, sha256Hex } from "./crypto";
import { consumeMagicLink, issueMagicLink } from "./magicLink";
import { consumeInvite, hashInviteCode, isInviteUsable } from "./invites";
import { interstitialResponse } from "./interstitial";
import {
  clearedLinkNonceCookie,
  clearedSessionCookie,
  issueSession,
  readCookie,
  revokeAllSessions,
  revokeSession,
  serializeLinkNonceCookie,
  serializeSessionCookie,
  LINK_NONCE_COOKIE,
  SESSION_COOKIE,
} from "./session";

const LINK_NONCE_TTL_SECONDS = 1_800;

export function registerAuthRoutes(app: App): void {
  /**
   * Always answers 202 with the same body: for a known account, an unknown
   * one, a suspended one, and one whose email failed to send. That uniformity
   * is the whole no-enumeration property. The only 4xx responses here are for
   * malformed input, which is independent of whether an account exists - and
   * the invite code is checked BEFORE any user lookup, so it cannot become an
   * account-existence oracle either.
   */
  app.post("/auth/request-link", async (c) => {
    const { config, db, clock, email } = c.get("deps");
    requireSameSite(c.req.raw, config.appOrigin);
    requireClientHeader(c.req.raw);

    const now = clock.nowSeconds();
    const payload = await readJsonBody(c.req.raw, MAX_AUTH_BODY_BYTES);
    const address = normaliseEmail(readString(payload, "email"));
    const inviteCode = readOptionalString(payload, "inviteCode")?.trim() ?? "";

    if (!isPlausibleEmail(address)) {
      throw new ApiError({
        status: 400,
        code: "api-invalid",
        reason: "email-invalid",
        message: "That does not look like an email address.",
      });
    }

    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const ipHash = await hashIp(ip, config.ipHashPepper);
    const emailHash = await sha256Hex(address);
    const verdict = await consumeRateLimits(
      db,
      [
        { bucket: `ip:${ipHash}:${hourWindow(now)}`, limit: 10, windowSeconds: 3_600 },
        { bucket: `ip:${ipHash}:${dayWindow(now)}`, limit: 30, windowSeconds: 86_400 },
        { bucket: `email:${emailHash}:${hourWindow(now)}`, limit: 3, windowSeconds: 3_600 },
        { bucket: `email:${emailHash}:${dayWindow(now)}`, limit: 8, windowSeconds: 86_400 },
      ],
      now,
    );
    if (!verdict.allowed) {
      throw rateLimited("auth-rate-limited", "Too many sign-in requests. Try again later.", verdict.retryAfterSeconds);
    }

    if (inviteCode !== "" && !(await isInviteUsable(db, inviteCode, now))) {
      throw new ApiError({
        status: 400,
        code: "not-invited",
        reason: "invite-invalid",
        message: "That invite code did not work.",
      });
    }

    const user = await findUserByEmail(db, address);
    let userId: string | null = null;

    if (user !== null) {
      // A suspended account falls through silently, like an unknown one.
      if (user.status === "active") {
        userId = user.id;
      }
    } else if (config.signupMode === "open") {
      userId = (await createUser(db, address, now, null)).id;
    } else if (config.signupMode === "invite" && inviteCode !== "") {
      if (await consumeInvite(db, inviteCode, now)) {
        userId = (await createUser(db, address, now, await hashInviteCode(inviteCode))).id;
      }
    }

    const response: { status: "sent"; devLink?: string } = { status: "sent" };

    if (userId !== null) {
      const link = await issueMagicLink(db, userId, now, config.magicLinkTtlSeconds, ipHash);
      const url = `${config.appOrigin}/auth/callback?token=${link.token}`;
      try {
        await email.send(magicLinkEmail(address, url, Math.round(config.magicLinkTtlSeconds / 60)));
      } catch (error) {
        // Only reachable for an account that exists, so surfacing it would
        // itself leak. Logged and swallowed - with the requestId, so it lines
        // up with the request line app.ts writes for the same invocation.
        // providerStatus, not status: app.ts already uses `status` for our own
        // HTTP status, and two meanings for one key makes filtering useless.
        console.error(
          JSON.stringify({
            requestId: c.get("requestId"),
            event: "magic-link-send-failed",
            providerStatus: error instanceof EmailSendError ? error.status : null,
            detail: error instanceof EmailSendError ? error.detail : String(error),
          }),
        );
      }
      c.header("Set-Cookie", serializeLinkNonceCookie(link.nonce, LINK_NONCE_TTL_SECONDS));

      // Console mode only, and note what it costs: a devLink present for a
      // known address and absent for an unknown one IS an account-existence
      // oracle. Acceptable while the operator is the only user; it must never
      // appear once real mail is being sent.
      if (config.emailMode === "console") {
        response.devLink = url;
      }
    }

    return c.json(response satisfies RequestLinkResponse, 202);
  });

  /**
   * Renders the confirm page. Deliberately has no side effects at all.
   *
   * No same-site guard here, and that is the point: a magic link is opened
   * from an email client, so this navigation is cross-site by design.
   * Guarding it would reject every real sign-in from Gmail. It is safe
   * because nothing is redeemed until the POST below - this handler only
   * echoes a token that has already been matched against a strict
   * base64url pattern into an inert page with a locked-down CSP.
   */
  app.get("/auth/callback", (c) => {
    const token = c.req.query("token") ?? "";
    if (!isWellFormedToken(token)) {
      throw invalidBody("That sign-in link is not valid.", "not-authenticated");
    }
    return interstitialResponse(token);
  });

  /**
   * Redeems the link. No X-RB-Client here: this is a plain form post from the
   * interstitial, which cannot set custom headers. It is protected by the
   * same-site guard and by the SameSite=Lax device nonce.
   */
  app.post("/auth/callback", async (c) => {
    const { config, db, clock } = c.get("deps");
    requireSameSite(c.req.raw, config.appOrigin);

    const now = clock.nowSeconds();
    const contentType = c.req.header("Content-Type") ?? "";
    const token = contentType.includes("application/json")
      ? readString(await readJsonBody(c.req.raw, MAX_AUTH_BODY_BYTES), "token")
      : String((await c.req.parseBody()).token ?? "");

    if (!isWellFormedToken(token)) {
      throw invalidBody("That sign-in link is not valid.", "not-authenticated");
    }

    const result = await consumeMagicLink(db, token, now, {
      nonce: readCookie(c.req.raw, LINK_NONCE_COOKIE),
      requireSameDevice: config.requireSameDeviceLink,
    });

    if (!result.ok) {
      throw new ApiError({
        status: 400,
        code: "not-authenticated",
        reason: result.reason,
        message:
          result.reason === "link-wrong-device"
            ? "Open this link on the device where you asked for it."
            : "That sign-in link has expired or was already used. Ask for a new one.",
      });
    }

    const session = await issueSession(
      db,
      result.userId,
      now,
      config.sessionTtlSeconds,
      c.req.header("User-Agent") ?? null,
    );
    await db.prepare("UPDATE users SET last_seen_at = ?1 WHERE id = ?2").bind(now, result.userId).run();

    c.header("Set-Cookie", serializeSessionCookie(session.token, config.sessionTtlSeconds), { append: true });
    c.header("Set-Cookie", clearedLinkNonceCookie(), { append: true });

    if ((c.req.header("Accept") ?? "").includes("application/json")) {
      return c.json({ status: "signed-in" }, 200);
    }
    return c.redirect("/", 303);
  });

  /** Idempotent by design: logging out must never fail. */
  app.post("/auth/logout", async (c) => {
    const { config, db } = c.get("deps");
    requireSameSite(c.req.raw, config.appOrigin);
    requireClientHeader(c.req.raw);

    const token = readCookie(c.req.raw, SESSION_COOKIE);
    if (token !== null) {
      const allDevices = readOptionalString(await safeJson(c.req.raw), "allDevices") === "true";
      if (allDevices) {
        const session = await db
          .prepare("SELECT user_id FROM sessions WHERE session_hash = ?1")
          .bind(await sha256Hex(token))
          .first<{ user_id: string }>();
        if (session !== null) {
          await revokeAllSessions(db, session.user_id);
        }
      }
      await revokeSession(db, token);
    }

    c.header("Set-Cookie", clearedSessionCookie());
    return c.body(null, 204);
  });
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return {};
  }
}
