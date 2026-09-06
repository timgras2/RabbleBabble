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

interface FakeRecorder extends AudioRecorder {
  readonly states: RecordingState[];
  /** Drives the adapter's own state, which the flow subscribes to. */
  emit(state: RecordingState): void;
  endedBy: AudioRecording["endedBy"];
}

function recorder(): FakeRecorder {
  const states: RecordingState[] = [];
  const listeners = new Set<(state: RecordingState) => void>();
  const fake: FakeRecorder = {
    states,
    state: "idle",
    startedAt: null,
    endedBy: "user",
    getInputLevel: () => null,
    emit(state) {
      for (const listener of listeners) listener(state);
    },
    start: vi.fn(async () => { states.push("recording"); }),
    stop: vi.fn(async (): Promise<AudioRecording> => ({
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationMs: 1000,
      endedBy: fake.endedBy,
    })),
    cancel: vi.fn(async () => undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => undefined,
  };
  return fake;
}

describe("DictationFlowService", () => {
  it("runs transcription and cleanup in order", async () => {
    const audio = recorder();
    const groq: InferenceClient = {
      checkReady: vi.fn(() => undefined),
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
      checkReady: vi.fn(() => undefined),
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
        checkReady: vi.fn(() => {
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

  it("keeps the recording when readiness lapses between start and stop", async () => {
    const audio = recorder();
    const transcribe = vi.fn(async () => ({ text: "kept words" }));
    let ready = true;
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: {
        checkReady: vi.fn(() => {
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
    // No upload was attempted -- but the recording was NOT thrown away, so
    // signing back in and retrying costs the user nothing.
    expect(transcribe).not.toHaveBeenCalled();
    expect(audio.cancel).not.toHaveBeenCalled();
    expect(flow.getSnapshot().canRetry).toBe(true);

    ready = true;
    await expect(flow.retryUpload()).resolves.toMatchObject({ finalText: "kept words" });
    expect(flow.getSnapshot().canRetry).toBe(false);
  });

  it("transcribes a recording the recorder ended by itself, and says why", async () => {
    const audio = recorder();
    audio.endedBy = "duration-limit";
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: {
        checkReady: vi.fn(() => undefined),
        transcribe: vi.fn(async () => ({ text: "five minutes of words" })),
        cleanup: vi.fn(),
        rewrite: vi.fn(),
      },
    });

    await flow.start();
    // No stop() call: the adapter hit the limit and published the state.
    audio.emit("auto-stopped");
    await vi.waitUntil(() => flow.state === "completed");

    expect(flow.result?.finalText).toBe("five minutes of words");
    expect(flow.getSnapshot().notice).toContain("five-minute limit");
  });

  it("holds the recording for a retry when the upload fails", async () => {
    const transcribe = vi.fn<() => Promise<{ text: string }>>()
      .mockRejectedValueOnce(new AdapterError("offline", { code: "api-server", retryable: true }))
      .mockResolvedValueOnce({ text: "second try" });
    const flow = new DictationFlowService({
      recorder: recorder(),
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
      inference: { checkReady: vi.fn(() => undefined), transcribe, cleanup: vi.fn(), rewrite: vi.fn() },
    });

    await flow.start();
    await expect(flow.stop()).rejects.toMatchObject({ code: "api-server" });
    expect(flow.getSnapshot()).toMatchObject({ state: "error", canRetry: true });

    await expect(flow.retryUpload()).resolves.toMatchObject({ finalText: "second try" });
    expect(transcribe).toHaveBeenCalledTimes(2);
    // Delivered, so the audio is gone and there is nothing left to retry.
    expect(flow.getSnapshot().canRetry).toBe(false);
  });

  it("does not start a duplicate stop operation", async () => {
    const audio = recorder();
    const flow = new DictationFlowService({
      recorder: audio,
      settings: settingsRepository({ cleanupEnabled: false, language: "" }),
       inference: { checkReady: vi.fn(() => undefined), transcribe: vi.fn(async () => ({ text: "hello" })), cleanup: vi.fn(), rewrite: vi.fn() },
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
        checkReady: vi.fn(() => undefined),
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
       inference: { checkReady: vi.fn(() => undefined), transcribe: vi.fn(async () => { throw new Error("network"); }), cleanup: vi.fn(), rewrite: vi.fn() },
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
        checkReady: vi.fn(() => undefined),
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
        checkReady: vi.fn(() => undefined),
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
        checkReady: vi.fn(() => undefined),
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
      inference: { checkReady: vi.fn(() => undefined), transcribe: vi.fn(async () => ({ text: "original" })), cleanup: vi.fn(), rewrite },
    });

    await expect(flow.rewrite("Change it")).rejects.toMatchObject({ code: "recording-invalid" });
    await flow.start();
    await flow.stop();
    await expect(flow.rewrite(" ")).rejects.toMatchObject({ code: "invalid-instruction" });
    expect(rewrite).not.toHaveBeenCalled();
  });
});
