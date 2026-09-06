import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  APP_ORIGIN,
  appHeaders,
  buildTestApp,
  createInvite,
  alwaysTranscribes,
  signIn,
  type TestApp,
} from "./helpers/app";

async function usageFor(address: string) {
  return env.DB.prepare(
    `SELECT u.audio_seconds, u.audio_seconds_reserved
       FROM usage_daily u JOIN users s ON s.id = u.user_id
      WHERE s.email = ?1`,
  )
    .bind(address)
    .first<{ audio_seconds: number; audio_seconds_reserved: number }>();
}

function postAudio(testApp: TestApp, cookie: string) {
  const body = new ArrayBuffer(2_048);
  return testApp.app.request(`${APP_ORIGIN}/v1/transcribe`, {
    method: "POST",
    headers: appHeaders({
      "Content-Type": "audio/webm",
      "Content-Length": "2048",
      Cookie: cookie,
    }),
    body,
  });
}

async function signedIn(testApp: TestApp, address: string): Promise<string> {
  const code = await createInvite();
  return signIn(testApp, address, { inviteCode: code });
}

describe("per-user quota", () => {
  it("refuses the next request once the daily allowance is gone", async () => {
    // One transcription's pessimistic reservation is 300s, so a 600s
    // allowance is exactly two calls.
    const testApp = buildTestApp({ userDailyAudioSeconds: 600, transcribeReserveSeconds: 300 });
    const cookie = await signedIn(testApp, "capped@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 300));

    expect((await postAudio(testApp, cookie)).status).toBe(200);
    expect((await postAudio(testApp, cookie)).status).toBe(200);

    const refused = await postAudio(testApp, cookie);
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "quota-exceeded", reason: "user-daily-quota", retryable: true },
    });
  });

  /**
   * This used to assert the opposite, and asserting the opposite was the bug:
   * a 30-second recording against a 60-second allowance was refused, because
   * admission demanded room for a whole 300-second worst case on top. The user
   * could afford the recording they were making and was turned away anyway.
   */
  it("accepts a first recording that fits in the allowance, even below the reserve", async () => {
    const testApp = buildTestApp({ userDailyAudioSeconds: 60, transcribeReserveSeconds: 300 });
    const cookie = await signedIn(testApp, "firstcall@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 30));

    expect((await postAudio(testApp, cookie)).status).toBe(200);
    expect(await usageFor("firstcall@example.com")).toMatchObject({ audio_seconds: 30 });
  });

  /**
   * SQLite never evaluates an ON CONFLICT ... WHERE guard on the INSERT path,
   * so the first request of a day still needs an explicit check in application
   * code. Under the admission rule that check is "is there an allowance at
   * all", and an audio_seconds_override of 0 is the way to have none.
   */
  it("refuses the first call of the day when the allowance is zero", async () => {
    const testApp = buildTestApp();
    const cookie = await signedIn(testApp, "noallowance@example.com");
    await env.DB.prepare("UPDATE users SET audio_seconds_override = 0 WHERE email = ?1")
      .bind("noallowance@example.com")
      .run();

    const response = await postAudio(testApp, cookie);

    expect(response.status).toBe(429);
    expect(testApp.groqFetch).not.toHaveBeenCalled();
  });

  it("counts chat calls separately from audio", async () => {
    const testApp = buildTestApp({ userDailyChatCalls: 1 });
    const cookie = await signedIn(testApp, "chatcap@example.com");
    testApp.groqFetch.mockImplementation(async () => Response.json({ choices: [{ message: { content: "tidy" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    );

    const cleanup = () =>
      testApp.app.request(`${APP_ORIGIN}/v1/cleanup`, {
        method: "POST",
        headers: appHeaders({ "Content-Type": "application/json", Cookie: cookie }),
        body: JSON.stringify({ text: "some words" }),
      });

    expect((await cleanup()).status).toBe(200);
    expect((await cleanup()).status).toBe(429);
  });
});

describe("global spend cap", () => {
  it("fails closed once the daily budget is committed", async () => {
    // A cap smaller than a single reservation: nothing may get through.
    const testApp = buildTestApp({ globalDailySpendMicros: 10 });
    const cookie = await signedIn(testApp, "capped-global@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 30));

    const response = await postAudio(testApp, cookie);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "quota-exceeded", reason: "global-spend-cap" },
    });
    // The point of failing closed: no money was spent finding out.
    expect(testApp.groqFetch).not.toHaveBeenCalled();
  });

  it("tells the client the service is unavailable rather than letting it try", async () => {
    const testApp = buildTestApp({ globalDailySpendMicros: 1_000 });
    const cookie = await signedIn(testApp, "status@example.com");

    const day = new Date(testApp.clock.nowSeconds() * 1000).toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO spend_daily (day, micros_spent, micros_reserved, updated_at) VALUES (?1, 5000, 0, ?2)",
    )
      .bind(day, testApp.clock.nowSeconds())
      .run();

    const me = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: appHeaders({ Cookie: cookie }),
    });

    await expect(me.json()).resolves.toMatchObject({
      service: { available: false, reason: "global-spend-cap" },
    });
  });

  it("lets exactly one of two simultaneous requests through at the boundary", async () => {
    // Budget for one reservation and no more.
    const testApp = buildTestApp({ transcribeReserveSeconds: 300 });
    const oneReservation = Math.ceil((300 * testApp.config.priceTranscribeMicrosPerHour) / 3600);
    const bounded = buildTestApp({ transcribeReserveSeconds: 300, globalDailySpendMicros: oneReservation });
    const cookie = await signedIn(bounded, "race@example.com");
    bounded.groqFetch.mockImplementation(alwaysTranscribes("words", 30));

    const [first, second] = await Promise.all([postAudio(bounded, cookie), postAudio(bounded, cookie)]);
    const statuses = [first.status, second.status].sort();

    // The compare-and-increment is what makes this deterministic; a
    // read-then-write would let both through.
    expect(statuses).toEqual([200, 429]);
  });
});

describe("GET /v1/me", () => {
  it("reports usage and the limits the server actually enforces", async () => {
    const testApp = buildTestApp({ userDailyAudioSeconds: 10_800 });
    const cookie = await signedIn(testApp, "me@example.com");
    testApp.groqFetch.mockImplementation(alwaysTranscribes("words", 42));
    await postAudio(testApp, cookie);

    const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
      headers: appHeaders({ Cookie: cookie }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { email: string };
      quota: { audioSecondsUsed: number; audioSecondsLimit: number; resetsAtEpochSeconds: number };
      limits: { maxAudioBytes: number };
    };
    expect(body.user.email).toBe("me@example.com");
    expect(body.quota.audioSecondsUsed).toBe(42);
    expect(body.quota.audioSecondsLimit).toBe(10_800);
    // Returned so the client renders the truth rather than a compiled-in guess.
    expect(body.limits.maxAudioBytes).toBe(26_214_400);
    expect(body.quota.resetsAtEpochSeconds).toBeGreaterThan(testApp.clock.nowSeconds());
  });
});

describe("burst limits on /v1/*", () => {
  /**
   * Rate limiting existed only for /auth/*. Daily quotas capped the day, and
   * nothing capped the minute -- so one valid session could make the whole
   * day's global budget of calls inside sixty seconds.
   */
  it("refuses a burst from one session inside a single minute", async () => {
    const testApp = buildTestApp();
    const cookie = await signIn(testApp, "burst@example.com", { inviteCode: await createInvite() });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await testApp.app.request(`${APP_ORIGIN}/v1/me`, {
        headers: appHeaders({ Cookie: cookie }),
      });
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses[0]).toBe(200);
  });
});

describe("the tail of the daily allowance", () => {
  /**
   * Reported from staging: "I've only used 5 of 10 minutes and it says the
   * limit is reached."
   *
   * Every transcription reserves TRANSCRIBE_RESERVE_SECONDS pessimistically --
   * the recorder's own hard cap, because the real duration is not known until
   * Groq answers. The admission guard then demanded room for that whole
   * worst-case recording ON TOP of everything already spent, which makes the
   * usable allowance `cap - reserve` rather than `cap`. On staging that is
   * 600 - 300 = exactly the five minutes that got used.
   *
   * settle() is already documented as allowed to push the day's total past the
   * limit -- an in-flight request is never killed, the next one is refused
   * instead. Admission now follows the same rule: if there is any allowance
   * left, the recording is accepted.
   */
  it("still accepts a recording when some allowance is left, however little", async () => {
    const testApp = buildTestApp({ userDailyAudioSeconds: 600, transcribeReserveSeconds: 300 });
    const cookie = await signIn(testApp, "tail@example.com", { inviteCode: await createInvite() });

    // Five minutes and ten seconds of the ten-minute allowance, spent.
    testApp.groqFetch.mockImplementation(alwaysTranscribes("first", 310));
    expect((await postAudio(testApp, cookie)).status).toBe(200);

    const usage = await usageFor("tail@example.com");
    expect(usage?.audio_seconds).toBe(310);
    expect(usage?.audio_seconds_reserved).toBe(0);

    // 290 seconds remain. The user is told "5 of 10 minutes", so being refused
    // here is the server disagreeing with what the app just showed them.
    testApp.groqFetch.mockImplementation(alwaysTranscribes("second", 20));
    expect((await postAudio(testApp, cookie)).status).toBe(200);
  });

  it("refuses once the allowance is genuinely gone", async () => {
    const testApp = buildTestApp({ userDailyAudioSeconds: 600, transcribeReserveSeconds: 300 });
    const cookie = await signIn(testApp, "spent@example.com", { inviteCode: await createInvite() });

    // Two full-length recordings, each within the implausibility threshold, so
    // this exercises the quota rather than the abuse check.
    testApp.groqFetch.mockImplementation(alwaysTranscribes("all of it", 300));
    expect((await postAudio(testApp, cookie)).status).toBe(200);
    expect((await postAudio(testApp, cookie)).status).toBe(200);

    // Nothing left, so the next one is the one that pays for the overshoot.
    expect((await postAudio(testApp, cookie)).status).toBe(429);
  });

  it("bounds how many recordings can be in flight at once", async () => {
    const testApp = buildTestApp({ userDailyAudioSeconds: 600, transcribeReserveSeconds: 300 });
    const cookie = await signIn(testApp, "concurrent@example.com", { inviteCode: await createInvite() });

    // Never settled, so each holds its full pessimistic reservation.
    testApp.groqFetch.mockImplementation(
      (() => new Promise(() => undefined)) as unknown as typeof fetch,
    );
    void postAudio(testApp, cookie);
    void postAudio(testApp, cookie);
    await vi.waitUntil(async () => (await usageFor("concurrent@example.com"))?.audio_seconds_reserved === 600);

    // Two reservations of 300 fill the 600-second cap; a third has no room.
    testApp.groqFetch.mockImplementation(alwaysTranscribes("third", 10));
    expect((await postAudio(testApp, cookie)).status).toBe(429);
  });
});
