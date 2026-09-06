import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_MS,
  MAX_INSTRUCTION_CHARS,
  MAX_JSON_BODY_BYTES,
  MAX_TEXT_CHARS,
  MAX_VOCABULARY_CHARS,
} from "../../../src/shared/limits";
import { buildCleanupMessages, buildRewriteMessages } from "../../../src/shared/prompts";
import { LANGUAGE_HEADER, type MeResponse, type TextResponse, type TranscribeResponse } from "../../../src/shared/wire";
import type { App } from "../app";
import { accountSuspended, emptyResult, invalidBody, notAuthenticated, payloadTooLarge, rateLimited, unsupportedMediaType } from "../errors";
import { consumeRateLimits, hourWindow, minuteWindow } from "../db/rateLimits";
import { requireClientHeader, requireSameSite } from "../http/guards";
import { readJsonBody, readString } from "../http/json";
import { clearedSessionCookie, readCookie, readSession, touchSession, SESSION_COOKIE, type SessionUser } from "../auth/session";
import { suspendUser } from "../db/users";
import { nextUtcMidnight, utcDay } from "../usage/clock";
import { chargeableSeconds, chatMicros, transcriptionMicros } from "../usage/pricing";
import { isServiceAvailable, readUsage, release, reserveChat, reserveTranscription, settle } from "../usage/quota";
import { audioFilename, isAllowedAudioType, readAudioBody } from "./upload";
import type { Context } from "hono";
import type { Deps } from "../deps";

const LANGUAGE_PATTERN = new RegExp("^[a-z]{2}(-[A-Za-z]{2})?$");

/** Anything longer than this cannot be a real recording from our own client. */
const IMPLAUSIBLE_DURATION_FACTOR = 1.2;

export function registerV1Routes(app: App): void {
  app.get("/v1/me", async (c) => {
    const user = await authenticate(c);
    const { config, db, clock } = c.get("deps");
    const now = clock.nowSeconds();
    const day = utcDay(now);

    const usage = await readUsage(db, user.id, day);
    const available = await isServiceAvailable(db, day, config.globalDailySpendMicros);

    const body: MeResponse = {
      user: { id: user.id, email: user.email, vocabulary: user.vocabulary },
      quota: {
        day,
        audioSecondsUsed: usage.audio_seconds,
        audioSecondsLimit: user.audioSecondsOverride ?? config.userDailyAudioSeconds,
        transcribeCallsUsed: usage.transcribe_calls,
        transcribeCallsLimit: config.userDailyTranscribeCalls,
        chatCallsUsed: usage.chat_calls,
        chatCallsLimit: config.userDailyChatCalls,
        resetsAtEpochSeconds: nextUtcMidnight(now),
      },
      limits: {
        maxAudioBytes: MAX_AUDIO_BYTES,
        maxAudioSeconds: Math.round(MAX_AUDIO_MS / 1000),
        maxTextChars: MAX_TEXT_CHARS,
        maxInstructionChars: MAX_INSTRUCTION_CHARS,
      },
      service: available ? { available: true } : { available: false, reason: "global-spend-cap" },
    };

    return c.json(body);
  });

  /**
   * The one piece of user data worth storing server-side.
   *
   * Validated here rather than trusted, and it reaches Groq only as the
   * transcription `prompt` -- a biasing hint, not an instruction channel. It
   * must never reach the chat models, where the JSON.stringify framing in
   * src/shared/prompts.ts is what keeps a hostile transcript inert.
   */
  app.patch("/v1/me", async (c) => {
    const user = await authenticate(c);
    const { db } = c.get("deps");

    const payload = await readJsonBody(c.req.raw, MAX_JSON_BODY_BYTES);
    const vocabulary = readString(payload, "vocabulary").trim();
    if (vocabulary.length > MAX_VOCABULARY_CHARS) {
      throw payloadTooLarge("That vocabulary list is too long.", "rewrite-too-large");
    }

    await db.prepare("UPDATE users SET vocabulary = ?1 WHERE id = ?2").bind(vocabulary, user.id).run();
    return c.json({ vocabulary });
  });

  /**
   * Erasure, in one statement.
   *
   * ON DELETE CASCADE is already declared on auth_tokens, sessions and
   * usage_daily, so removing the user row removes everything about them. The
   * IP pepper protects what is in D1; Cloudflare's own platform logs carry the
   * unpeppered client IP and are outside this deletion.
   */
  app.delete("/v1/me", async (c) => {
    const user = await authenticate(c);
    const { db } = c.get("deps");

    await db.prepare("DELETE FROM users WHERE id = ?1").bind(user.id).run();

    c.header("Set-Cookie", clearedSessionCookie());
    return c.body(null, 204);
  });

  /**
   * Takes raw audio bytes as the body, not multipart.
   *
   * The Worker never parses multipart (no CPU, no parser attack surface),
   * Content-Length is exact before a byte is read, and the Worker builds the
   * Groq form itself - so a client cannot downgrade response_format to dodge
   * duration metering, or choose a different model.
   */
  app.post("/v1/transcribe", async (c) => {
    const user = await authenticate(c);
    const { config, db, clock, groq } = c.get("deps");

    const mimeType = (c.req.header("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!isAllowedAudioType(mimeType)) {
      throw unsupportedMediaType("That audio format is not supported.");
    }

    const language = c.req.header(LANGUAGE_HEADER)?.trim() ?? "";
    const audio = await readAudioBody(c.req.raw);

    const now = clock.nowSeconds();
    const audioSecondsLimit = user.audioSecondsOverride ?? config.userDailyAudioSeconds;
    const reservation = await reserveTranscription(db, config, user.id, now, audioSecondsLimit);
    let settled = false;

    try {
      const result = await groq.transcribe({
        audio,
        mimeType,
        filename: audioFilename(mimeType),
        ...(LANGUAGE_PATTERN.test(language) ? { language } : {}),
        // From the session row, never from the request body.
        ...(user.vocabulary === "" ? {} : { prompt: user.vocabulary }),
      });

      // Kept apart on purpose: `measured` is what Groq actually reported, and
      // it is the ONLY thing allowed to suspend an account. The estimate below
      // bills, and nothing more.
      const measured = result.durationSeconds;
      const observed = measured ?? estimateSecondsFromBytes(audio.byteLength);
      const billed = chargeableSeconds(observed);
      await settle(
        db,
        reservation,
        { audioSeconds: billed, micros: transcriptionMicros(billed, config.priceTranscribeMicrosPerHour) },
        clock.nowSeconds(),
      );
      settled = true;

      // A 25 MB file at a very low bitrate can be hours of audio, which Groq
      // will happily transcribe before we ever see the duration. The byte cap
      // is only a lower bound, so the account is stopped after the fact.
      //
      // Only on a measured duration. The estimate is byteLength / 4000, so a
      // normal two-minute recording clears 360s at about 1.44 MB: if Groq ever
      // stopped returning `duration` and `segments`, this branch would suspend
      // every account on the service, and there is no self-serve way back.
      if (measured !== null && measured > (MAX_AUDIO_MS / 1000) * IMPLAUSIBLE_DURATION_FACTOR) {
        console.error(`[transcribe] implausible duration ${measured}s for user ${user.id}; suspending`);
        await suspendUser(db, user.id);
      } else if (measured === null) {
        console.warn(
          JSON.stringify({
            requestId: c.get("requestId"),
            event: "transcribe-duration-missing",
            estimatedSeconds: observed,
          }),
        );
      }

      if (result.text.trim() === "") {
        // Groq billed us either way, so the charge above stands.
        throw emptyResult("Nothing was said in that recording.");
      }

      const body: TranscribeResponse = {
        text: result.text,
        durationSeconds: observed,
        quota: await quotaBody(c, user, clock.nowSeconds()),
      };
      return c.json(body);
    } catch (error) {
      // Only if the charge never landed. Releasing an already-settled
      // reservation would subtract budget belonging to other in-flight requests.
      if (!settled) {
        await release(db, reservation, clock.nowSeconds()).catch(() => undefined);
      }
      throw error;
    }
  });

  app.post("/v1/cleanup", async (c) => {
    const user = await authenticate(c);
    const payload = await readJsonBody(c.req.raw, MAX_JSON_BODY_BYTES);
    const text = readString(payload, "text");

    if (text.trim() === "") {
      throw invalidBody("There is no transcript to clean up.", "empty-transcript");
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw payloadTooLarge("That transcript is too long.", "rewrite-too-large");
    }

    return runChat(c, user, buildCleanupMessages(text), "Cleanup returned nothing.");
  });

  app.post("/v1/rewrite", async (c) => {
    const user = await authenticate(c);
    const payload = await readJsonBody(c.req.raw, MAX_JSON_BODY_BYTES);
    const text = readString(payload, "text");
    const instruction = readString(payload, "instruction");

    // Same branches, and the same codes per branch, as the browser adapter
    // used to apply, so the two never disagree about which failure this is.
    if (text.trim() === "") {
      throw invalidBody("There is no transcript to rewrite.", "empty-transcript");
    }
    if (instruction.trim() === "") {
      throw invalidBody("Enter an instruction for the rewrite.", "invalid-instruction");
    }
    if (text.length > MAX_TEXT_CHARS || instruction.length > MAX_INSTRUCTION_CHARS) {
      throw payloadTooLarge("The transcript or rewrite instruction is too long.", "rewrite-too-large");
    }

    return runChat(c, user, buildRewriteMessages(text, instruction), "The rewrite returned nothing.");
  });
}

type RouteContext = Context<{ Bindings: Env; Variables: { deps: Deps; requestId: string; session?: SessionUser } }>;

async function runChat(
  c: RouteContext,
  user: SessionUser,
  messages: ReturnType<typeof buildCleanupMessages>,
  emptyMessage: string,
): Promise<Response> {
  const { config, db, clock, groq } = c.get("deps");
  const reservation = await reserveChat(db, config, user.id, clock.nowSeconds());
  let settled = false;

  try {
    const result = await groq.chat(messages);
    await settle(
      db,
      reservation,
      {
        micros: chatMicros(
          result.promptTokens,
          result.completionTokens,
          config.priceChatInMicrosPerMTok,
          config.priceChatOutMicrosPerMTok,
        ),
        tokensIn: result.promptTokens,
        tokensOut: result.completionTokens,
      },
      clock.nowSeconds(),
    );
    settled = true;

    if (result.text.trim() === "") {
      throw emptyResult(emptyMessage);
    }

    const body: TextResponse = { text: result.text, quota: await quotaBody(c, user, clock.nowSeconds()) };
    return c.json(body);
  } catch (error) {
    if (!settled) {
      await release(db, reservation, clock.nowSeconds()).catch(() => undefined);
    }
    throw error;
  }
}

async function authenticate(c: RouteContext): Promise<SessionUser> {
  const { config, db, clock } = c.get("deps");
  requireSameSite(c.req.raw, config.appOrigin);
  requireClientHeader(c.req.raw);

  const token = readCookie(c.req.raw, SESSION_COOKIE);
  if (token === null) {
    throw notAuthenticated();
  }

  const now = clock.nowSeconds();
  const user = await readSession(db, token, now);
  if (user === null) {
    throw notAuthenticated("session-expired");
  }
  if (user.status !== "active") {
    throw accountSuspended();
  }

  // Daily quotas cap the day; nothing capped the minute. One valid session
  // could make the whole day's global budget of calls inside sixty seconds.
  // Same mechanism as /auth/*: the window is baked into the bucket key, so
  // there is no rollover bug and no second thing to reason about.
  const verdict = await consumeRateLimits(
    db,
    [
      { bucket: `user:${user.id}:${minuteWindow(now)}`, limit: 12, windowSeconds: 60 },
      { bucket: `user:${user.id}:${hourWindow(now)}`, limit: 120, windowSeconds: 3_600 },
    ],
    now,
  );
  if (!verdict.allowed) {
    throw rateLimited("auth-rate-limited", "Too many requests. Slow down a moment.", verdict.retryAfterSeconds);
  }

  c.set("session", user);
  await touchSession(db, token, now, config.sessionTtlSeconds).catch(() => undefined);
  return user;
}

async function quotaBody(c: RouteContext, user: SessionUser, now: number) {
  const { config, db } = c.get("deps");
  const day = utcDay(now);
  const usage = await readUsage(db, user.id, day);
  return {
    day,
    audioSecondsUsed: usage.audio_seconds,
    audioSecondsLimit: user.audioSecondsOverride ?? config.userDailyAudioSeconds,
    transcribeCallsUsed: usage.transcribe_calls,
    transcribeCallsLimit: config.userDailyTranscribeCalls,
    chatCallsUsed: usage.chat_calls,
    chatCallsLimit: config.userDailyChatCalls,
    resetsAtEpochSeconds: nextUtcMidnight(now),
  };
}

/**
 * Last-resort metering when Groq returns no duration. Deliberately generous
 * (32 kbps), so the fallback errs towards over-charging rather than giving
 * away audio for free.
 */
function estimateSecondsFromBytes(byteLength: number): number {
  return byteLength / 4_000;
}
