import { AdapterError } from "../errors";
import { RetryingHttp } from "./httpRetry";
import type { HttpErrorMapper } from "./httpRetry";

const errors: HttpErrorMapper = {
  fromResponse: (response) =>
    Promise.resolve(
      new AdapterError(`status ${response.status}`, {
        code: response.status >= 500 ? "api-server" : "api-invalid",
        retryable: response.status >= 500,
      }),
    ),
  unreachable: (cause) => new AdapterError("unreachable", { code: "api-server", retryable: true, cause }),
  timedOut: (cause) => new AdapterError("timed out", { code: "api-timeout", retryable: true, cause }),
  invalidBody: (cause) => new AdapterError("invalid body", { code: "api-invalid", cause }),
};

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function status(code: number): Response {
  return new Response("{}", { status: code, headers: { "Content-Type": "application/json" } });
}

/** A fetcher that never settles until its signal aborts. */
function hangingFetcher() {
  return vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }));
}

describe("RetryingHttp", () => {
  it("does not re-issue a timed-out request when retryTimeouts is false", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = hangingFetcher();
      const http = new RetryingHttp({ fetcher, errors });
      const request = http.send("https://example.test", {}, { timeoutMs: 10, retryTimeouts: false });
      const result = expect(request).rejects.toMatchObject({ code: "api-timeout" });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(11);
      await result;

      // The whole point: a 25 MB upload is never silently sent twice.
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues exactly one request when maxAttempts is 1", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(status(500));
    const http = new RetryingHttp({ fetcher, errors });

    await expect(http.send("https://example.test", {}, { timeoutMs: 50, maxAttempts: 1 }))
      .rejects.toMatchObject({ code: "api-server" });
    // Auth posts rely on this: a flaky 5xx must not send a second email.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps a final server error through the caller's mapper", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(status(503));
      const http = new RetryingHttp({ fetcher, errors });
      const request = http.send("https://example.test", {}, { timeoutMs: 50 });
      const result = expect(request).rejects.toMatchObject({ code: "api-server", message: "status 503" });

      await vi.runAllTimersAsync();
      await result;
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a client error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(status(429));
    const http = new RetryingHttp({ fetcher, errors });

    await expect(http.send("https://example.test", {}, { timeoutMs: 50 }))
      .rejects.toMatchObject({ code: "api-invalid", message: "status 429" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports an already-aborted signal as cancelled without fetching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ok());
    const http = new RetryingHttp({ fetcher, errors });
    const controller = new AbortController();
    controller.abort();

    await expect(http.send("https://example.test", { signal: controller.signal }, { timeoutMs: 50 }))
      .rejects.toMatchObject({ code: "cancelled" });
  });

  it("gives up promptly when the caller aborts during the backoff wait", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(status(500));
      const http = new RetryingHttp({ fetcher, errors });
      const controller = new AbortController();
      const request = http.send("https://example.test", { signal: controller.signal }, { timeoutMs: 50 });
      const result = expect(request).rejects.toMatchObject({ code: "cancelled" });

      // Land inside the 1s backoff, then abort. Cancelling must not wait it out.
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("short-circuits when the device is offline", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = new RetryingHttp({ fetcher, errors });
    const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });

    try {
      await expect(http.send("https://example.test", {}, { timeoutMs: 50 }))
        .rejects.toMatchObject({ code: "offline", retryable: true });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      if (onLine) {
        Object.defineProperty(Navigator.prototype, "onLine", onLine);
      }
      delete (navigator as unknown as Record<string, unknown>).onLine;
    }
  });

  it("maps an unparseable success body through the caller's mapper", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json", { status: 200 }));
    const http = new RetryingHttp({ fetcher, errors });
    const response = await http.send("https://example.test", {}, { timeoutMs: 50 });

    await expect(http.readJson(response)).rejects.toMatchObject({ code: "api-invalid" });
  });
});
