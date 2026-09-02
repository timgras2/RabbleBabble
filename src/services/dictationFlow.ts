import { AdapterError } from "../platform/errors";
import type { AudioRecorder } from "../platform/audio/types";
import type { GroqClient } from "../platform/inference/types";
import type { SettingsRepository } from "../platform/storage/types";
import type { Unsubscribe } from "../platform/types";
import type { DictationFlow, DictationResult, DictationState } from "./types";

export interface DictationFlowDependencies {
  readonly recorder: AudioRecorder;
  readonly settings: SettingsRepository;
  readonly groq: GroqClient;
}

export class DictationFlowService implements DictationFlow {
  private currentState: DictationState = "idle";
  private currentResult: DictationResult | null = null;
  private readonly listeners = new Set<(state: DictationState) => void>();
  private readonly dependencies: DictationFlowDependencies;
  private controller: AbortController | null = null;
  private activeStop: Promise<DictationResult> | null = null;
  private activeRewrite: Promise<DictationResult> | null = null;
  private cancelRequested = false;
  private stopRequested = false;

  constructor(dependencies: DictationFlowDependencies) {
    this.dependencies = dependencies;
  }

  get state(): DictationState {
    return this.currentState;
  }

  get result(): DictationResult | null {
    return this.currentResult;
  }

  async start(): Promise<void> {
    if (this.activeStop || this.activeRewrite || !["idle", "completed", "error"].includes(this.currentState)) {
      throw this.invalidTransition("Finish or cancel the current operation first.");
    }
    if (!this.dependencies.settings.get().groqApiKey.trim()) {
      this.setState("error");
      throw new AdapterError("Enter a Groq API key in Settings before recording.", {
        code: "missing-api-key",
      });
    }

    try {
      await this.dependencies.recorder.start();
      this.currentResult = null;
      this.cancelRequested = false;
      this.stopRequested = false;
      this.setState("recording");
    } catch (error) {
      const code = error instanceof AdapterError ? error.code : undefined;
      this.setState(code === "mic-denied" || code === "mic-unavailable" ? "idle" : "error");
      throw error;
    }
  }

  stop(): Promise<DictationResult> {
    if (this.currentState !== "recording" || this.stopRequested) {
      return Promise.reject(this.invalidTransition("Start a recording before stopping it."));
    }
    this.stopRequested = true;
    const operation = this.runStop();
    this.activeStop = operation;
    void operation.then(() => {
      if (this.activeStop === operation) {
        this.activeStop = null;
      }
    }, () => {
      if (this.activeStop === operation) {
        this.activeStop = null;
      }
    });
    return operation;
  }

  rewrite(instruction: string): Promise<DictationResult> {
    if (this.activeStop || this.activeRewrite || this.currentState !== "completed" || !this.currentResult) {
      return Promise.reject(this.invalidTransition("Complete a transcript before rewriting it."));
    }
    if (!instruction.trim()) {
      return Promise.reject(new AdapterError("Enter an instruction for the rewrite.", {
        code: "invalid-instruction",
      }));
    }

    this.cancelRequested = false;
    const operation = this.runRewrite(instruction);
    this.activeRewrite = operation;
    void operation.then(() => {
      if (this.activeRewrite === operation) {
        this.activeRewrite = null;
      }
    }, () => {
      if (this.activeRewrite === operation) {
        this.activeRewrite = null;
      }
    });
    return operation;
  }

  async cancel(): Promise<void> {
    if (this.currentState === "rewriting" || this.activeRewrite) {
      this.cancelRequested = true;
      this.controller?.abort();
      if (this.activeRewrite) {
        await this.activeRewrite.catch(() => undefined);
      }
      this.controller = null;
      this.cancelRequested = false;
      this.stopRequested = false;
      if (this.currentState !== "completed") {
        this.setState("completed");
      }
      return;
    }
    if (this.currentState === "recording") {
      this.cancelRequested = true;
      try {
        await this.dependencies.recorder.cancel();
      } catch {
        // Cancellation still aborts the network request and resets the flow.
      }
    }
    this.controller?.abort();
    if (this.activeStop) {
      await this.activeStop.catch(() => undefined);
    }
    this.controller = null;
    this.currentResult = null;
    this.cancelRequested = false;
    this.stopRequested = false;
    if (this.currentState !== "idle") {
      this.setState("idle");
    }
  }

  subscribe(listener: (state: DictationState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async runStop(): Promise<DictationResult> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const settings = this.dependencies.settings.get();
      if (!settings.groqApiKey.trim()) {
        await this.dependencies.recorder.cancel();
        throw new AdapterError("Enter a Groq API key in Settings before uploading.", {
          code: "missing-api-key",
        });
      }

      const audio = await this.dependencies.recorder.stop();
      this.throwIfCancelled(controller);
      this.setState("transcribing");
      const transcription = await this.dependencies.groq.transcribe({
        apiKey: settings.groqApiKey,
        audio,
        language: settings.language,
        signal: controller.signal,
      });
      this.throwIfCancelled(controller);

      let finalText = transcription.text;
      let cleanupApplied = false;
      let cleanupFailed = false;
      if (settings.cleanupEnabled) {
        this.setState("cleaning");
        try {
          const cleanup = await this.dependencies.groq.cleanup({
            apiKey: settings.groqApiKey,
            text: transcription.text,
            signal: controller.signal,
          });
          this.throwIfCancelled(controller);
          finalText = cleanup.text;
          cleanupApplied = true;
        } catch {
          this.throwIfCancelled(controller);
          cleanupFailed = true;
          finalText = transcription.text;
        }
      }

      const result: DictationResult = {
        rawText: transcription.text,
        finalText,
        cleanupApplied,
        cleanupFailed,
      };
      this.currentResult = result;
      this.setState("completed");
      return result;
    } catch (error) {
      if (this.cancelRequested || controller.signal.aborted) {
        this.currentResult = null;
        this.setState("idle");
      } else {
        this.setState("error");
      }
      throw error;
    } finally {
      this.stopRequested = false;
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  private async runRewrite(instruction: string): Promise<DictationResult> {
    const previousResult = this.currentResult;
    if (!previousResult) {
      throw this.invalidTransition("Complete a transcript before rewriting it.");
    }

    const controller = new AbortController();
    this.controller = controller;
    try {
      const settings = this.dependencies.settings.get();
      if (!settings.groqApiKey.trim()) {
        throw new AdapterError("Enter a Groq API key in Settings before rewriting.", {
          code: "missing-api-key",
        });
      }

      this.setState("rewriting");
      const rewrite = await this.dependencies.groq.rewrite({
        apiKey: settings.groqApiKey,
        text: previousResult.finalText,
        instruction,
        signal: controller.signal,
      });
      this.throwIfCancelled(controller);

      const result: DictationResult = {
        ...previousResult,
        finalText: rewrite.text,
      };
      this.currentResult = result;
      this.setState("completed");
      return result;
    } catch (error) {
      this.currentResult = previousResult;
      this.setState("completed");
      throw error;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  private throwIfCancelled(controller: AbortController): void {
    if (this.cancelRequested || controller.signal.aborted) {
      throw new AdapterError("Dictation was cancelled.", {
        code: "cancelled",
      });
    }
  }

  private invalidTransition(message: string): AdapterError {
    return new AdapterError(message, { code: "recording-invalid" });
  }

  private setState(state: DictationState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
