import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_MS,
  MAX_INSTRUCTION_CHARS,
  MAX_JSON_BODY_BYTES,
  MAX_TEXT_CHARS,
} from "../../../src/shared/limits";
import { buildCleanupMessages, buildRewriteMessages } from "../../../src/shared/prompts";
import { LANGUAGE_HEADER, type MeResponse, type TextResponse, type TranscribeResponse } from "../../../src/shared/wire";
import type { App } from "../app";
import { accountSuspended, emptyResult, invalidBody, notAuthenticated, payloadTooLarge, unsupportedMediaType } from "../errors";
import { requireClientHeader, requireSameSite } from "../http/guards";
import { readJsonBody, readString } from "../http/json";
import { readCookie, readSession, touchSession, SESSION_COOKIE, type SessionUser } from "../auth/session";
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
      user: { id: user.id, email: user.email },
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
      });

      const observed = result.durationSeconds ?? estimateSecondsFromBytes(audio.byteLength);
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
      if (observed > (MAX_AUDIO_MS / 1000) * IMPLAUSIBLE_DURATION_FACTOR) {
        console.error(`[transcribe] implausible duration ${observed}s for user ${user.id}; suspending`);
        await suspendUser(db, user.id);
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

  c.set("session", user);
  await touchSession(db, token, now).catch(() => undefined);
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
