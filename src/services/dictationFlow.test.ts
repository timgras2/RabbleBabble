import type { AudioRecorder, AudioRecording, RecordingState } from "../platform/audio/types";
import { AdapterError } from "../platform/errors";
import type { InferenceClient } from "../platform/inference/types";
import { DEFAULT_SETTINGS } from "../platform/storage/localStorageSettings";
import type { Settings, SettingsRepository } from "../platform/storage/types";
import { DictationFlowService } from "./dictationFlow";

// Takes a patch so these cases stay pinned to the fields they actually exercise.
function settingsRepository(patch: Partial<Settings>): SettingsRepository {
  const value: Settings = { ...DEFAULT_SETTINGS, ...patch };
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
    getInputLevel: () => null,
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
    const groq: InferenceClient = {
      ensureReady: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => ({ text: "hello world" })),
      cleanup: vi.fn(async () => ({ text: "Hello, world." })),
      rewrite: vi.fn(async () => ({ text: "Rewritten." })),
    };
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ cleanupEnabled: true, language: "" }),
      inference: groq,
    });

    await flow.start();
    const result = await flow.stop();

    expect(result).toEqual({ rawText: "hello world", finalText: "Hello, world.", cleanupApplied: true, cleanupFailed: false });
    expect(flow.state).toBe("completed");
  });

  it("falls back to raw text when cleanup fails", async () => {
    const groq: InferenceClient = {
      ensureReady: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => ({ text: "raw words" })),
      cleanup: vi.fn(async () => { throw new Error("cleanup failed"); }),
      rewrite: vi.fn(async () => ({ text: "Rewritten." })),
    };
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ cleanupEnabled: true, language: "" }),
      inference: groq,
    });

    await flow.start();
    await expect(flow.stop()).resolves.toMatchObject({ rawText: "raw words", finalText: "raw words", cleanupFailed: true });
  });

  it("refuses to start when the client is not ready, before using the microphone", async () => {
    const audio = recorder();
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ cleanupEnabled: true, language: "" }),
      inference: {
        ensureReady: vi.fn(async () => {
          throw new AdapterError("no key", { code: "missing-api-key" });
        }),
        transcribe: vi.fn(),
        cleanup: vi.fn(),
        rewrite: vi.fn(),
      },
    });

    await expect(flow.start()).rejects.toMatchObject({ code: "missing-api-key" });
    // The microphone never opened, so the user has not lost any speech.
    expect(audio.states).toEqual([]);
  });

  it("releases the microphone when readiness lapses between start and stop", async () => {
    const audio = recorder();
    const transcribe = vi.fn();
    let ready = true;
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: {
        ensureReady: vi.fn(async () => {
          if (!ready) {
            throw new AdapterError("session ended", { code: "not-authenticated" });
          }
        }),
        transcribe,
        cleanup: vi.fn(),
        rewrite: vi.fn(),
      },
    });

    await flow.start();
    ready = false;

    await expect(flow.stop()).rejects.toMatchObject({ code: "not-authenticated" });
    // No upload was attempted, and the microphone is not left running.
    expect(transcribe).not.toHaveBeenCalled();
    expect(audio.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not start a duplicate stop operation", async () => {
    const audio = recorder();
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
       inference: { ensureReady: vi.fn(async () => undefined), transcribe: vi.fn(async () => ({ text: "hello" })), cleanup: vi.fn(), rewrite: vi.fn() },
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
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: {
        ensureReady: vi.fn(async () => undefined),
        transcribe: vi.fn(({ signal }): Promise<{ text: string }> => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
        })),
        cleanup: vi.fn(),
        rewrite: vi.fn(),
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
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
       inference: { ensureReady: vi.fn(async () => undefined), transcribe: vi.fn(async () => { throw new Error("network"); }), cleanup: vi.fn(), rewrite: vi.fn() },
    });
    await flow.start();

    await expect(flow.stop()).rejects.toThrow("network");
    expect(flow.state).toBe("error");
    expect(flow.result).toBeNull();
  });

  it("rewrites the current final text and preserves transcript metadata", async () => {
    const rewrite = vi.fn()
      .mockImplementationOnce(async (request: { text: string; instruction: string }) => {
        expect(request.text).toBe("Hello, world.");
        expect(request.instruction).toBe("Make it concise");
        return { text: "Hello." };
      })
      .mockImplementationOnce(async (request: { text: string; instruction: string }) => {
        expect(request.text).toBe("Hello.");
        expect(request.instruction).toBe("Make it warmer");
        return { text: "Hello there!" };
      });
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ cleanupEnabled: true, language: "" }),
      inference: {
        ensureReady: vi.fn(async () => undefined),
        transcribe: vi.fn(async () => ({ text: "hello world" })),
        cleanup: vi.fn(async () => ({ text: "Hello, world." })),
        rewrite,
      },
    });

    await flow.start();
    await flow.stop();
    await expect(flow.rewrite("Make it concise")).resolves.toEqual({
      rawText: "hello world",
      finalText: "Hello.",
      cleanupApplied: true,
      cleanupFailed: false,
    });
    expect(flow.state).toBe("completed");
    await expect(flow.rewrite("Make it warmer")).resolves.toMatchObject({ finalText: "Hello there!" });
  });

  it("preserves the previous result when rewriting fails", async () => {
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: {
        ensureReady: vi.fn(async () => undefined),
        transcribe: vi.fn(async () => ({ text: "original" })),
        cleanup: vi.fn(),
        rewrite: vi.fn(async () => { throw new Error("rewrite failed"); }),
      },
    });

    await flow.start();
    const original = await flow.stop();
    await expect(flow.rewrite("Change it")).rejects.toThrow("rewrite failed");
    expect(flow.state).toBe("completed");
    expect(flow.result).toEqual(original);
  });

  it("cancels rewriting without clearing the previous result", async () => {
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: {
        ensureReady: vi.fn(async () => undefined),
        transcribe: vi.fn(async () => ({ text: "original" })),
        cleanup: vi.fn(),
        rewrite: vi.fn(({ signal }): Promise<{ text: string }> => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
        })),
      },
    });

    await flow.start();
    const original = await flow.stop();
    const rewriting = flow.rewrite("Change it");
    const handled = rewriting.catch(() => undefined);
    await Promise.resolve();
    await flow.cancel();

    await handled;
    expect(flow.state).toBe("completed");
    expect(flow.result).toEqual(original);
  });

  it("rejects a rewrite without a result or instruction", async () => {
    const rewrite = vi.fn();
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: { ensureReady: vi.fn(async () => undefined), transcribe: vi.fn(async () => ({ text: "original" })), cleanup: vi.fn(), rewrite },
    });

    await expect(flow.rewrite("Change it")).rejects.toMatchObject({ code: "recording-invalid" });
    await flow.start();
    await flow.stop();
    await expect(flow.rewrite(" ")).rejects.toMatchObject({ code: "invalid-instruction" });
    expect(rewrite).not.toHaveBeenCalled();
  });
});
