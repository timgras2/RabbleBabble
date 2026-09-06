import { HttpAuthSession } from "./httpAuthSession";

function meResponse(email = "user@example.com"): Response {
  return new Response(
    JSON.stringify({
      user: { id: "u1", email },
      quota: {
        day: "2026-09-05",
        audioSecondsUsed: 60,
        audioSecondsLimit: 10_800,
        transcribeCallsUsed: 1,
        transcribeCallsLimit: 400,
        chatCallsUsed: 0,
        chatCallsLimit: 200,
        resetsAtEpochSeconds: 1_760_000_000,
      },
      limits: { maxAudioBytes: 26_214_400, maxAudioSeconds: 300, maxTextChars: 20_000, maxInstructionChars: 2_000 },
      service: { available: true },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: { code: "not-authenticated", reason: "not-authenticated", message: "Sign in.", retryable: false, requestId: "r" } }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

function session(fetcher: typeof fetch) {
  return new HttpAuthSession({ fetcher, revalidateOnFocus: false });
}

describe("HttpAuthSession", () => {
  it("reports a signed-in account with its quota", async () => {
    const auth = session(vi.fn<typeof fetch>(async () => meResponse()));

    const state = await auth.refresh();

    expect(state.status).toBe("signed-in");
    expect(state.account?.email).toBe("user@example.com");
    expect(state.quota?.audioSecondsLimit).toBe(10_800);
  });

  it("treats a 401 as signed out", async () => {
    const auth = session(vi.fn<typeof fetch>(async () => unauthorized()));

    await expect(auth.refresh()).resolves.toMatchObject({ status: "signed-out", account: null });
    expect(() => auth.requireSignedIn()).toThrowError(expect.objectContaining({ code: "not-authenticated" }));
  });

  /**
   * The distinction that matters: offline is not signed out. Showing a
   * sign-in form to someone whose session is fine but whose network is not
   * is both a lie and a dead end - signing in is exactly what they cannot do.
   */
  it("stays unknown when the network fails, rather than claiming signed out", async () => {
    const auth = session(vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    }));

    const state = await auth.refresh();

    expect(state.status).toBe("unknown");
    expect(state.error).not.toBeNull();
    expect(() => auth.requireSignedIn()).toThrowError(expect.objectContaining({ retryable: true }));
  });

  it("shares one request between concurrent callers", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => meResponse());
    const auth = session(fetcher);

    const [first, second] = await Promise.all([auth.refresh(), auth.refresh()]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  /**
   * useSyncExternalStore compares snapshots by identity. Returning a fresh
   * object each call is not a subtle bug: React throws on an infinite loop.
   */
  it("returns the identical snapshot object while nothing changes", async () => {
    const auth = session(vi.fn<typeof fetch>(async () => meResponse()));
    await auth.refresh();

    expect(auth.get()).toBe(auth.get());
  });

  it("notifies subscribers when another adapter reports a lost session", async () => {
    const auth = session(vi.fn<typeof fetch>(async () => meResponse()));
    await auth.refresh();
    const listener = vi.fn();
    auth.subscribe(listener);

    auth.markSignedOut();
    auth.markSignedOut();

    // Idempotent: a second 401 on a parallel request must not re-render again.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(auth.get().status).toBe("signed-out");
  });

  it("sends a sign-in request once, so a flaky server cannot send two emails", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
    const auth = session(fetcher);

    await expect(auth.requestMagicLink({ email: "a@b.com", inviteCode: "ABCD" })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ email: "a@b.com", inviteCode: "ABCD" });
  });

  it("surfaces a rejected invite code by its own name", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ error: { code: "not-invited", reason: "invite-invalid", message: "no", retryable: false, requestId: "r" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    const auth = session(fetcher);

    await expect(auth.requestMagicLink({ email: "a@b.com", inviteCode: "NOPE" })).rejects.toMatchObject({
      code: "not-invited",
    });
  });

  it("signs out locally even when the server call fails", async () => {
    const auth = session(vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await auth.signOut();

    expect(auth.get().status).toBe("signed-out");
  });
});
