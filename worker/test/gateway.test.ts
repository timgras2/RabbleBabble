import { describe, expect, it, vi } from "vitest";
import { GroqGateway } from "../src/groq/gateway";

/**
 * The most complex logic in the Worker, and until now the least exercised:
 * every other test hands GroqGateway a `mockResolvedValue`, which succeeds on
 * the first attempt and therefore never retries, never backs off and never
 * times out.
 */
function gateway(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return new GroqGateway({ baseUrl: "https://groq.test/v1", apiKey: "test-key", fetcher });
}

function transcription(body: Record<string, unknown>): Response {
  return Response.json(body);
}

function audio() {
  return { audio: new ArrayBuffer(64), mimeType: "audio/webm", filename: "r.webm" };
}

describe("GroqGateway retry", () => {
  it("retries a 5xx once and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("upstream boom", { status: 503 }))
        .mockResolvedValueOnce(transcription({ text: "second attempt", duration: 3 }));

      const pending = gateway(fetcher).transcribe(audio());
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toMatchObject({ text: "second attempt" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the attempt budget and reports the last failure", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(async () => new Response("still down", { status: 502 }));

      const pending = gateway(fetcher).transcribe(audio());
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);

      const error = await settled;
      // The failure that mattered used to be logged as `internal: "undefined"`,
      // because lastError was only ever assigned in the catch branch.
      expect(String((error as { internal?: unknown }).internal)).toContain("502");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never re-uploads audio after a transcription timeout", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });

    await expect(gateway(fetcher).transcribe(audio())).rejects.toMatchObject({ reason: "upstream-timeout" });
    // Re-sending 25 MB on a metered connection is worse than failing.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does retry a chat timeout, where there is nothing to re-upload", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(async () => {
        throw new DOMException("timed out", "TimeoutError");
      });

      const pending = gateway(fetcher).chat([{ role: "user", content: "hi" }]);
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(settled).resolves.toMatchObject({ reason: "upstream-timeout" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a 4xx", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("nope", { status: 400 }));

    await expect(gateway(fetcher).chat([{ role: "user", content: "hi" }])).rejects.toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("duration reading", () => {
  it("prefers the reported duration", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => transcription({ text: "x", duration: 12.5, segments: [{ end: 3 }] }));
    await expect(gateway(fetcher).transcribe(audio())).resolves.toMatchObject({ durationSeconds: 12.5 });
  });

  it("falls back to the last segment end", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      transcription({ text: "x", segments: [{ end: 4 }, { end: 9.25 }, { end: 7 }] }),
    );
    await expect(gateway(fetcher).transcribe(audio())).resolves.toMatchObject({ durationSeconds: 9.25 });
  });

  it("reports null rather than a guess when the response has neither", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => transcription({ text: "x" }));
    // The route bills on an estimate from here, and -- since V3 -- refuses to
    // suspend anyone on it.
    await expect(gateway(fetcher).transcribe(audio())).resolves.toMatchObject({ durationSeconds: null });
  });

  it("ignores a non-finite duration and a malformed segment list", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      transcription({ text: "x", duration: "twelve", segments: [null, { end: "late" }] }),
    );
    await expect(gateway(fetcher).transcribe(audio())).resolves.toMatchObject({ durationSeconds: null });
  });
});
