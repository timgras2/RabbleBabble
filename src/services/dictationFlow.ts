import { AdapterError } from "../platform/errors";
import type { AdapterErrorCode } from "../platform/errors";
import type { AudioRecorder, AudioRecording } from "../platform/audio/types";
import type { InferenceClient } from "../platform/inference/types";
import type { SettingsRepository } from "../platform/storage/types";
import type { LocalStore } from "../platform/store/types";
import type { Unsubscribe } from "../platform/types";
import type {
  DictationFlow,
  DictationResult,
  DictationSnapshot,
  DictationState,
} from "./types";

export interface DictationFlowDependencies {
  readonly recorder: AudioRecorder;
  readonly settings: SettingsRepository;
  readonly inference: InferenceClient;
  /** Optional: without it the flow simply has no durability layer. */
  readonly store?: LocalStore;
}

const AUTO_STOP_NOTICES: Record<string, string> = {
  "duration-limit": "Stopped at the five-minute limit - transcribing what you said.",
  "byte-limit": "Stopped at the 25 MB limit - transcribing what you said.",
  interrupted: "Something else took the microphone - transcribing what you said.",
};

export class DictationFlowService implements DictationFlow {
  private snapshot: DictationSnapshot = {
    state: "idle",
    result: null,
    error: null,
    notice: null,
    canRetry: false,
    recoverable: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly dependencies: DictationFlowDependencies;
  private readonly unsubscribeRecorder: Unsubscribe;
  private controller: AbortController | null = null;
  private activeStop: Promise<DictationResult> | null = null;
  private activeRewrite: Promise<DictationResult> | null = null;
  private cancelRequested = false;
  private stopRequested = false;
  /**
   * The recording currently in flight. Held on the service rather than in a
   * local, so a failed upload does not take the user's words with it.
   */
  private heldAudio: AudioRecording | null = null;

  constructor(dependencies: DictationFlowDependencies) {
    this.dependencies = dependencies;
    this.unsubscribeRecorder = dependencies.recorder.subscribe((state) => {
      if (state === "auto-stopped") {
        this.absorbAutoStop();
      }
    });
  }

  getSnapshot(): DictationSnapshot {
    return this.snapshot;
  }

  /**
   * Called once at boot. Sweeps what has aged out, and offers what is left.
   *
   * Transcribing an orphan silently would spend quota the user never asked to
   * spend, on audio they may have abandoned on purpose.
   */
  async scanBuffer(): Promise<void> {
    const store = this.dependencies.store;
    if (store === undefined) {
      return;
    }
    await store.sweep(Date.now()).catch(() => undefined);
    const recordings = await store.listRecordings().catch(() => []);
    const newest = [...recordings].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest !== undefined && newest.bytes > 0) {
      this.patch({ recoverable: newest });
    }
  }

  recoverBuffered(): Promise<DictationResult> {
    const recoverable = this.snapshot.recoverable;
    const store = this.dependencies.store;
    if (recoverable === null || store === undefined || this.activeStop || this.activeRewrite) {
      return Promise.reject(this.invalidTransition("There is no unfinished recording to transcribe."));
    }
    this.patch({ recoverable: null });
    return this.track(
      (async () => {
        const audio = await store.loadRecording(recoverable.id);
        if (audio === null) {
          throw this.invalidTransition("That recording could not be read.");
        }
        this.heldAudio = audio;
        return this.runDelivery(audio);
      })(),
    );
  }

  async discardBuffered(): Promise<void> {
    const recoverable = this.snapshot.recoverable;
    this.patch({ recoverable: null });
    if (recoverable !== null) {
      await this.dependencies.store?.dropRecording(recoverable.id).catch(() => undefined);
    }
  }

  get state(): DictationState {
    return this.snapshot.state;
  }

  get result(): DictationResult | null {
    return this.snapshot.result;
  }

  async start(): Promise<void> {
    if (this.activeStop || this.activeRewrite || !["idle", "completed", "error"].includes(this.snapshot.state)) {
      throw this.invalidTransition("Finish or cancel the current operation first.");
    }

    // Synchronous on purpose. Awaiting anything here drops the user activation
    // that WebKit requires to even prompt for the microphone -- boundary rule 11.
    try {
      this.dependencies.inference.checkReady();
    } catch (error) {
      this.patch({ state: "error", error: asAdapterError(error) });
      throw error;
    }

    this.heldAudio = null;
    // Invoked, not awaited, before the first await in this function.
    const starting = this.dependencies.recorder.start();
    try {
      await starting;
      this.cancelRequested = false;
      this.stopRequested = false;
      this.patch({ state: "recording", result: null, error: null, notice: null, canRetry: false });
    } catch (error) {
      const adapterError = asAdapterError(error);
      const code = adapterError.code;
      this.patch({
        state: code === "mic-denied" || code === "mic-unavailable" ? "idle" : "error",
        error: adapterError,
      });
      throw error;
    }
  }

  stop(): Promise<DictationResult> {
    if (this.snapshot.state !== "recording" || this.stopRequested) {
      return Promise.reject(this.invalidTransition("Start a recording before stopping it."));
    }
    return this.track(this.runStop());
  }

  retryUpload(): Promise<DictationResult> {
    const audio = this.heldAudio;
    if (audio === null || this.activeStop || this.activeRewrite) {
      return Promise.reject(this.invalidTransition("There is no held recording to send again."));
    }
    this.stopRequested = true;
    return this.track(this.runDelivery(audio));
  }

  rewrite(instruction: string): Promise<DictationResult> {
    if (this.activeStop || this.activeRewrite || this.snapshot.state !== "completed" || !this.snapshot.result) {
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
    void operation.then(
      () => {
        if (this.activeRewrite === operation) this.activeRewrite = null;
      },
      () => {
        if (this.activeRewrite === operation) this.activeRewrite = null;
      },
    );
    return operation;
  }

  async cancel(): Promise<void> {
    if (this.snapshot.state === "rewriting" || this.activeRewrite) {
      this.cancelRequested = true;
      this.controller?.abort();
      if (this.activeRewrite) {
        await this.activeRewrite.catch(() => undefined);
      }
      this.controller = null;
      this.cancelRequested = false;
      this.stopRequested = false;
      this.patch({ state: "completed", error: null });
      return;
    }
    if (this.snapshot.state === "recording") {
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
    this.heldAudio = null;
    this.cancelRequested = false;
    this.stopRequested = false;
    this.patch({ state: "idle", result: null, error: null, notice: null, canRetry: false });
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeRecorder();
    this.listeners.clear();
  }

  /**
   * The recorder hit a limit or lost the microphone on its own. Take the audio
   * it kept and run the normal transcribe path, saying why it ended.
   */
  private absorbAutoStop(): void {
    if (this.snapshot.state !== "recording" || this.stopRequested || this.activeStop) {
      return;
    }
    void this.track(this.runStop()).catch(() => undefined);
  }

  private track(operation: Promise<DictationResult>): Promise<DictationResult> {
    this.stopRequested = true;
    this.activeStop = operation;
    void operation.then(
      () => {
        if (this.activeStop === operation) this.activeStop = null;
      },
      () => {
        if (this.activeStop === operation) this.activeStop = null;
      },
    );
    return operation;
  }

  private async runStop(): Promise<DictationResult> {
    let audio: AudioRecording;
    try {
      audio = await this.dependencies.recorder.stop();
    } catch (error) {
      this.stopRequested = false;
      if (this.cancelRequested) {
        this.patch({ state: "idle", result: null, notice: null });
      } else {
        this.patch({ state: "error", error: asAdapterError(error) });
      }
      throw error;
    }
    this.heldAudio = audio;
    if (audio.endedBy !== "user") {
      this.patch({ notice: AUTO_STOP_NOTICES[audio.endedBy] ?? null });
    }
    return this.runDelivery(audio);
  }

  private async runDelivery(audio: AudioRecording): Promise<DictationResult> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const settings = this.dependencies.settings.get();
      this.throwIfCancelled(controller);
      // Re-checked here rather than before the recorder stops: a session that
      // died mid-recording must not be a reason to throw the audio away.
      this.dependencies.inference.checkReady();
      this.patch({ state: "transcribing", error: null });
      const transcription = await this.dependencies.inference.transcribe({
        audio,
        language: settings.language,
        vocabulary: settings.vocabulary,
        signal: controller.signal,
      });
      this.throwIfCancelled(controller);

      let finalText = transcription.text;
      let cleanupApplied = false;
      let cleanupFailed = false;
      if (settings.cleanupEnabled) {
        this.patch({ state: "cleaning" });
        try {
          const cleanup = await this.dependencies.inference.cleanup({
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

      // Delivered. The audio has done its job and must not outlive it: this
      // deletion is what keeps "in-flight audio only" an honest claim.
      this.heldAudio = null;
      void this.dependencies.store?.dropRecording(audio.id).catch(() => undefined);
      const result: DictationResult = {
        rawText: transcription.text,
        finalText,
        cleanupApplied,
        cleanupFailed,
      };
      if (settings.historyEnabled) {
        void this.dependencies.store?.saveTranscript(finalText).catch(() => undefined);
      }
      this.patch({ state: "completed", result, error: null, canRetry: false });
      return result;
    } catch (error) {
      if (this.cancelRequested || controller.signal.aborted) {
        this.heldAudio = null;
        this.patch({ state: "idle", result: null, error: null, notice: null, canRetry: false });
      } else {
        const adapterError = asAdapterError(error);
        // The recording is still on the service, so the error can offer a
        // retry that costs the user nothing. errorMessages.ts says as much.
        this.patch({
          state: "error",
          error: adapterError,
          canRetry: this.heldAudio !== null && isWorthRetrying(adapterError.code),
        });
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
    const previousResult = this.snapshot.result;
    if (!previousResult) {
      throw this.invalidTransition("Complete a transcript before rewriting it.");
    }

    const controller = new AbortController();
    this.controller = controller;
    try {
      this.dependencies.inference.checkReady();

      this.patch({ state: "rewriting", error: null });
      const rewrite = await this.dependencies.inference.rewrite({
        text: previousResult.finalText,
        instruction,
        signal: controller.signal,
      });
      this.throwIfCancelled(controller);

      const result: DictationResult = { ...previousResult, finalText: rewrite.text };
      this.patch({ state: "completed", result, error: null });
      return result;
    } catch (error) {
      const adapterError = asAdapterError(error);
      this.patch({
        state: "completed",
        result: previousResult,
        error: adapterError.code === "cancelled" ? null : adapterError,
      });
      throw error;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  private throwIfCancelled(controller: AbortController): void {
    if (this.cancelRequested || controller.signal.aborted) {
      throw new AdapterError("Dictation was cancelled.", { code: "cancelled" });
    }
  }

  private invalidTransition(message: string): AdapterError {
    return new AdapterError(message, { code: "recording-invalid" });
  }

  private patch(change: Partial<DictationSnapshot>): void {
    const next = { ...this.snapshot, ...change };
    if (
      next.state === this.snapshot.state &&
      next.result === this.snapshot.result &&
      next.error === this.snapshot.error &&
      next.notice === this.snapshot.notice &&
      next.canRetry === this.snapshot.canRetry &&
      next.recoverable === this.snapshot.recoverable
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Whether sending the same bytes again could plausibly work -- after a
 * reconnect, a sign-in, or simply a moment. Listed by exclusion, because the
 * codes that genuinely cannot be retried are the short, closed set: the
 * recording itself is unusable, or the user asked to stop.
 */
const NOT_WORTH_RETRYING = new Set<AdapterErrorCode>([
  "recording-invalid",
  "recording-too-long",
  "recording-too-large",
  "empty-transcript",
  "invalid-instruction",
  "rewrite-too-large",
  "cancelled",
  "clipboard-denied",
  "clipboard-unavailable",
]);

function isWorthRetrying(code: AdapterErrorCode): boolean {
  return !NOT_WORTH_RETRYING.has(code);
}

function asAdapterError(error: unknown): AdapterError {
  if (error instanceof AdapterError) {
    return error;
  }
  return new AdapterError("Something went wrong. Try again.", {
    code: "api-server",
    cause: error,
  });
}
