import type { AudioRecorder, AudioRecording, RecordingState } from "../platform/audio/types";
import type { GroqClient } from "../platform/inference/types";
import type { Settings, SettingsRepository } from "../platform/storage/types";
import { DictationFlowService } from "./dictationFlow";

function settingsRepository(value: Settings): SettingsRepository {
  return {
    get: () => value,
    update: (patch) => Object.assign(value, patch),
    clearApiKey: () => value,
    reset: () => value,
    subscribe: () => () => undefined,
  };
}

function recorder(): AudioRecorder & { states: RecordingState[] } {
  const states: RecordingState[] = [];
  return {
    states,
    state: "idle",
    start: vi.fn(async () => { states.push("recording"); }),
    stop: vi.fn(async (): Promise<AudioRecording> => ({
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationMs: 1000,
    })),
    cancel: vi.fn(async () => undefined),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
}

describe("DictationFlowService", () => {
  it("runs transcription and cleanup in order", async () => {
    const audio = recorder();
    const groq: GroqClient = {
      transcribe: vi.fn(async () => ({ text: "hello world" })),
      cleanup: vi.fn(async () => ({ text: "Hello, world." })),
    };
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ groqApiKey: "key", cleanupEnabled: true, language: "" }),
      groq,
    });

    await flow.start();
    const result = await flow.stop();

    expect(result).toEqual({ rawText: "hello world", finalText: "Hello, world.", cleanupApplied: true, cleanupFailed: false });
    expect(flow.state).toBe("completed");
  });

  it("falls back to raw text when cleanup fails", async () => {
    const groq: GroqClient = {
      transcribe: vi.fn(async () => ({ text: "raw words" })),
      cleanup: vi.fn(async () => { throw new Error("cleanup failed"); }),
    };
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ groqApiKey: "key", cleanupEnabled: true, language: "" }),
      groq,
    });

    await flow.start();
    await expect(flow.stop()).resolves.toMatchObject({ rawText: "raw words", finalText: "raw words", cleanupFailed: true });
  });

  it("rejects a start without a key before using the microphone", async () => {
    const audio = recorder();
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ groqApiKey: "", cleanupEnabled: true, language: "" }),
      groq: { transcribe: vi.fn(), cleanup: vi.fn() },
    });

    await expect(flow.start()).rejects.toMatchObject({ code: "missing-api-key" });
    expect(audio.states).toEqual([]);
  });

  it("does not start a duplicate stop operation", async () => {
    const audio = recorder();
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ groqApiKey: "key", cleanupEnabled: false, language: "" }),
      groq: { transcribe: vi.fn(async () => ({ text: "hello" })), cleanup: vi.fn() },
    });
    await flow.start();
    const first = flow.stop();

    await expect(flow.stop()).rejects.toMatchObject({ code: "recording-invalid" });
    await first;
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight transcription without retaining a result", async () => {
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ groqApiKey: "key", cleanupEnabled: false, language: "" }),
      groq: {
        transcribe: vi.fn(({ signal }): Promise<{ text: string }> => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
        })),
        cleanup: vi.fn(),
      },
    });
    await flow.start();
    const stopping = flow.stop();
    const handled = stopping.catch(() => undefined);
    await Promise.resolve();
    await flow.cancel();

    await handled;
    expect(flow.state).toBe("idle");
    expect(flow.result).toBeNull();
  });

  it("does not expose a result when transcription fails", async () => {
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ groqApiKey: "key", cleanupEnabled: false, language: "" }),
      groq: { transcribe: vi.fn(async () => { throw new Error("network"); }), cleanup: vi.fn() },
    });
    await flow.start();

    await expect(flow.stop()).rejects.toThrow("network");
    expect(flow.state).toBe("error");
    expect(flow.result).toBeNull();
  });
});
