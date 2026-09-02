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
    const client = new GroqHttpClient({ fetcher });
    const audio = { blob: new Blob(["audio"], { type: "audio/mp4" }), mimeType: "audio/mp4", durationMs: 1000 };

    await expect(client.transcribe({ apiKey: "secret", audio, language: "" })).resolves.toEqual({ text: "hello" });
    const request = fetcher.mock.calls[0];
    const body = request[1]?.body as FormData;
    expect(request[0]).toContain("/audio/transcriptions");
    expect(body.get("model")).toBe("whisper-large-v3-turbo");
    expect(body.get("language")).toBeNull();
    expect((body.get("file") as File).name).toContain(".mp4");
  });

  it("maps unauthorized responses without exposing the key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    const client = new GroqHttpClient({ fetcher });

    const error = await client.cleanup({ apiKey: "secret-key", text: "hello" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "api-unauthorized" });
    expect(error.message).not.toContain("secret-key");
  });

  it("sends the fixed cleanup model and prompt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "Hello." } }] }));
    const client = new GroqHttpClient({ fetcher });

    await client.cleanup({ apiKey: "secret", text: "hello" });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain("hello");
  });

  it("sends a rewrite instruction separately from the transcript", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "Hello, world." } }] }),
    );
    const client = new GroqHttpClient({ fetcher });

    await expect(
      client.rewrite({ apiKey: "secret", text: "hello world", instruction: "Add punctuation" }),
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
    const client = new GroqHttpClient({ fetcher });

    await expect(client.rewrite({ apiKey: "secret", text: "hello", instruction: " " }))
      .rejects.toMatchObject({ code: "invalid-instruction" });
    await expect(client.rewrite({ apiKey: "secret", text: "x".repeat(20_001), instruction: "shorten" }))
      .rejects.toMatchObject({ code: "rewrite-too-large" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an empty rewrite response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "  " } }] }),
    );
    const client = new GroqHttpClient({ fetcher });

    await expect(client.rewrite({ apiKey: "secret", text: "hello", instruction: "shorten" }))
      .rejects.toMatchObject({ code: "empty-transcript" });
  });

  it("retries server failures up to three attempts", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({ text: "recovered" }));
    const client = new GroqHttpClient({ fetcher });
    const audio = { blob: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationMs: 1000 };

    await expect(client.transcribe({ apiKey: "secret", audio })).resolves.toEqual({ text: "recovered" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects oversized audio before calling fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GroqHttpClient({ fetcher });
    const audio = { blob: new Blob([new Uint8Array(26_214_401)], { type: "audio/webm" }), mimeType: "audio/webm", durationMs: 1000 };

    await expect(client.transcribe({ apiKey: "secret", audio })).rejects.toMatchObject({ code: "recording-too-large" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("times out a fetcher that does not resolve", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => undefined));
      const client = new GroqHttpClient({ fetcher, timeoutMs: 10 });
      const audio = { blob: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", durationMs: 1000 };
      const request = client.transcribe({ apiKey: "secret", audio });
      const result = expect(request).rejects.toMatchObject({ code: "api-timeout" });
      await vi.advanceTimersByTimeAsync(31);
      await result;
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
