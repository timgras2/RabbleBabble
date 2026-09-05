import { AdapterError } from "../errors";
import type { AuthSession, AuthState } from "../auth/types";
import { BackendClient } from "./backendClient";

const SIGNED_IN: AuthState = {
  status: "signed-in",
  account: { email: "user@example.com" },
  quota: null,
  checking: false,
  error: null,
};

function fakeSession(overrides: Partial<AuthSession> = {}, state: AuthState = SIGNED_IN): AuthSession {
  return {
    get: () => state,
    refresh: vi.fn(async () => state),
    ensureSignedIn: vi.fn(async () => undefined),
    requestMagicLink: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    markSignedOut: vi.fn(),
    updateQuota: vi.fn(),
    subscribe: () => () => undefined,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function apiError(code: string, status: number, retryable = false): Response {
  return jsonResponse({ error: { code, reason: "invalid-body", message: "nope", retryable, requestId: "r1" } }, status);
}

const audio = { blob: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationMs: 1000 };

describe("BackendClient", () => {
  it("posts raw audio bytes with no credential of its own", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ text: "hello", durationSeconds: 5 }));
    const client = new BackendClient({ fetcher, session: fakeSession() });

    await expect(client.transcribe({ audio, language: "nl" })).resolves.toEqual({ text: "hello" });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/v1/transcribe");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    // The session is an HttpOnly cookie, so there is nothing to attach here.
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-RB-Client")).toBe("1");
    expect(headers.get("Content-Type")).toBe("audio/webm");
    expect(headers.get("X-RB-Language")).toBe("nl");
    // Raw bytes, not multipart: the Worker owns the Groq form.
    expect(init?.body).toBe(audio.blob);
  });

  it("omits the language header when no hint is set", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ text: "hello", durationSeconds: 5 }));
    const client = new BackendClient({ fetcher, session: fakeSession() });

    await client.transcribe({ audio, language: "   " });

    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("X-RB-Language")).toBeNull();
  });

  it("records a lost session once, without an extra round trip", async () => {
    const markSignedOut = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => apiError("not-authenticated", 401));
    const client = new BackendClient({ fetcher, session: fakeSession({ markSignedOut }) });

    await expect(client.transcribe({ audio })).rejects.toMatchObject({ code: "not-authenticated" });
    expect(markSignedOut).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry a quota refusal", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => apiError("quota-exceeded", 429, true));
    const client = new BackendClient({ fetcher, session: fakeSession() });

    await expect(client.cleanup({ text: "words" })).rejects.toMatchObject({ code: "quota-exceeded" });
    // Retrying would just burn the user's remaining allowance faster.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to the status code when the body is not our error envelope", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("<html>gateway</html>", { status: 413 }));
    const client = new BackendClient({ fetcher, session: fakeSession() });

    await expect(client.cleanup({ text: "words" })).rejects.toMatchObject({ code: "recording-too-large" });
  });

  it("keeps the quota snapshot fresh from every success", async () => {
    const updateQuota = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        text: "tidy",
        quota: {
          day: "2026-09-05",
          audioSecondsUsed: 120,
          audioSecondsLimit: 10_800,
          transcribeCallsUsed: 2,
          transcribeCallsLimit: 400,
          chatCallsUsed: 3,
          chatCallsLimit: 200,
          resetsAtEpochSeconds: 1_760_000_000,
        },
      }),
    );
    const client = new BackendClient({ fetcher, session: fakeSession({ updateQuota }) });

    await client.cleanup({ text: "words" });

    // So Settings shows real usage without polling for it.
    expect(updateQuota).toHaveBeenCalledWith(
      expect.objectContaining({ audioSecondsUsed: 120, audioSecondsLimit: 10_800, chatCallsUsed: 3 }),
    );
  });

  it("refuses oversized audio before spending the upload", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new BackendClient({ fetcher, session: fakeSession() });
    const huge = {
      blob: new Blob([new Uint8Array(26_214_401)], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationMs: 1000,
    };

    await expect(client.transcribe({ audio: huge })).rejects.toMatchObject({ code: "recording-too-large" });
    // The server checks too, but not before the bytes have left a phone.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the rewrite validation branches the browser used to own", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new BackendClient({ fetcher, session: fakeSession() });

    await expect(client.rewrite({ text: " ", instruction: "tighten" })).rejects.toMatchObject({ code: "empty-transcript" });
    await expect(client.rewrite({ text: "words", instruction: " " })).rejects.toMatchObject({ code: "invalid-instruction" });
    await expect(client.rewrite({ text: "x".repeat(20_001), instruction: "tighten" })).rejects.toMatchObject({
      code: "rewrite-too-large",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  describe("ensureReady", () => {
    it("defers to the session", async () => {
      const ensureSignedIn = vi.fn(async () => {
        throw new AdapterError("nope", { code: "not-authenticated" });
      });
      const client = new BackendClient({ fetcher: vi.fn<typeof fetch>(), session: fakeSession({ ensureSignedIn }) });

      await expect(client.ensureReady()).rejects.toMatchObject({ code: "not-authenticated" });
    });

    it("refuses before recording when the day's allowance is already spent", async () => {
      const spent: AuthState = {
        ...SIGNED_IN,
        quota: {
          audioSecondsUsed: 10_800,
          audioSecondsLimit: 10_800,
          chatCallsUsed: 0,
          chatCallsLimit: 200,
          resetsAtEpochSeconds: 1_760_000_000,
        },
      };
      const client = new BackendClient({
        fetcher: vi.fn<typeof fetch>(),
        session: fakeSession({}, spent),
      });

      // Better here than after a minute of speech.
      await expect(client.ensureReady()).rejects.toMatchObject({ code: "quota-exceeded" });
    });
  });
});
