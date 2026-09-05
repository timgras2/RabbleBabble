import { AdapterError } from "../errors";
import { GroqHttpClient } from "./groqClient";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GroqHttpClient", () => {
  it("sends native multipart audio and omits an empty language", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ text: "hello" }));
    const client = new GroqHttpClient({ fetcher, apiKey: () => "secret" });
    const audio = { blob: new Blob(["audio"], { type: "audio/mp4" }), mimeType: "audio/mp4", durationMs: 1000 };

    await expect(client.transcribe({ audio, language: "" })).resolves.toEqual({ text: "hello" });
    const request = fetcher.mock.calls[0];
    const body = request[1]?.body as FormData;
    expect(request[0]).toContain("/audio/transcriptions");
    expect(body.get("model")).toBe("whisper-large-v3-turbo");
    expect(body.get("language")).toBeNull();
    expect((body.get("file") as File).name).toContain(".mp4");
  });

  it("maps unauthorized responses without exposing the key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    const client = new GroqHttpClient({ fetcher, apiKey: () => "secret-key" });

    const error = await client.cleanup({ text: "hello" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "api-unauthorized" });
    expect(error.message).not.toContain("secret-key");
  });

  it("sends the fixed cleanup model and prompt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "Hello." } }] }));
    const client = new GroqHttpClient({ fetcher, apiKey: () => "secret" });

    await client.cleanup({ text: "hello" });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain("hello");
  });

  it("sends a rewrite instruction separately from the transcript", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "Hello, world." } }] }),
    );
    const client = new GroqHttpClient({ fetcher, apiKey: () => "secret" });

    await expect(
      client.rewrite({ text: "hello world", instruction: "Add punctuation" }),
    ).resolves.toEqual({ text: "Hello, world." });

    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.messages[0].content).toContain("Preserve facts and meaning");
    expect(JSON.parse(body.messages[1].content.match(/\{[\s\S]*\}/)?.[0] ?? "{}")).toEqual({
      instruction: "Add punctuation",
      transcript: "hello world",
    });
  });

  it("rejects invalid rewrite input before calling fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GroqHttpClient({ fetcher, apiKey: () => "secret" });

    await expect(client.rewrite({ text: "hello", instruction: " " }))
      .rejects.toMatchObject({ code: "invalid-instruction" });
    await expect(client.rewrite({ text: "x".repeat(20_001), instruction: "shorten" }))
      .rejects.toMatchObject({ code: "rewrite-too-large" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an empty rewrite response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "  " } }] }),
    );
    const client = new GroqHttpClient({ fetcher, apiKey: () => "secret" });

    await expect(client.rewrite({ text: "hello", instruction: "shorten" }))
      .rejects.toMatchObject({ code: "empty-transcript" });
  });

  it("retries server failures up to three attempts", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 502))
        .mockResolvedValueOnce(jsonResponse({ text: "recovered" }));
      const client = new GroqHttpClient({ fetcher, apiKey: () => "secret" });
      const audio = { blob: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationMs: 1000 };
      const request = client.transcribe({ audio });

      await vi.runAllTimersAsync();
      await expect(request).resolves.toEqual({ text: "recovered" });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized audio before calling fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GroqHttpClient({ fetcher, apiKey: () => "secret" });
    const audio = { blob: new Blob([new Uint8Array(26_214_401)], { type: "audio/webm" }), mimeType: "audio/webm", durationMs: 1000 };

    await expect(client.transcribe({ audio })).rejects.toMatchObject({ code: "recording-too-large" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("times out a fetcher that does not resolve", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }));
      const client = new GroqHttpClient({ fetcher, apiKey: () => "secret", transcriptionTimeoutMs: 10 });
      const audio = { blob: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationMs: 1000 };
      const request = client.transcribe({ audio });
      const result = expect(request).rejects.toMatchObject({ code: "api-timeout" });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(11);
      await result;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off between retryable chat timeouts", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }));
      const client = new GroqHttpClient({ fetcher, apiKey: () => "secret", timeoutMs: 10 });
      const request = client.cleanup({ text: "hello" });

      await Promise.resolve();
      const result = expect(request).rejects.toMatchObject({ code: "api-timeout" });
      await vi.runAllTimersAsync();
      await result;
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports readiness from the current key without calling fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    let key = "";
    const client = new GroqHttpClient({ fetcher, apiKey: () => key });

    await expect(client.ensureReady()).rejects.toMatchObject({ code: "missing-api-key" });
    key = "a-key";
    await expect(client.ensureReady()).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads the key at request time, so editing it in Settings takes effect at once", async () => {
    // A fresh Response per call: a body can only be read once.
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    let key = "first-key";
    const client = new GroqHttpClient({ fetcher, apiKey: () => key });

    await client.cleanup({ text: "hello" });
    key = "second-key";
    await client.cleanup({ text: "hello" });

    const authorization = (index: number) =>
      new Headers(fetcher.mock.calls[index][1]?.headers).get("Authorization");
    expect(authorization(0)).toBe("Bearer first-key");
    expect(authorization(1)).toBe("Bearer second-key");
  });
});
