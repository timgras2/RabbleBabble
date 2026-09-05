import { AdapterError } from "../errors";
import type { Unsubscribe } from "../types";
import { negotiateMimeType } from "./mimeNegotiation";
import type {
  AudioRecorder,
  AudioRecorderOptions,
  AudioRecording,
  RecordingState,
} from "./types";

const DEFAULT_MAX_DURATION_MS = 300_000;
const DEFAULT_MAX_BYTES = 26_214_400;

export class MediaRecorderAdapter implements AudioRecorder {
  private currentState: RecordingState = "idle";
  private readonly listeners = new Set<(state: RecordingState) => void>();
  private readonly options: Required<
    Pick<AudioRecorderOptions, "maxDurationMs" | "maxBytes">
  > & Omit<AudioRecorderOptions, "maxDurationMs" | "maxBytes">;
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private recordedBytes = 0;
  private mimeType = "";
  private startedAt = 0;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResolve: ((recording: AudioRecording) => void) | null = null;
  private stopReject: ((error: unknown) => void) | null = null;
  private cancelResolve: (() => void) | null = null;
  private cancelled = false;
  private limitError: AdapterError | null = null;
  private autoStopped = false;
  private wakeLock: WakeLockSentinel | null = null;
  private visibilityHandler: (() => void) | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuffer: Uint8Array<ArrayBuffer> | null = null;

  constructor(options: AudioRecorderOptions = {}) {
    this.options = {
      ...options,
      maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    };
  }

  get state(): RecordingState {
    return this.currentState;
  }

  getInputLevel(): number | null {
    if (this.currentState !== "recording" || !this.analyser || !this.levelBuffer) {
      return null;
    }
    try {
      this.analyser.getByteTimeDomainData(this.levelBuffer);
      let sumOfSquares = 0;
      for (const sample of this.levelBuffer) {
        const centred = (sample - 128) / 128;
        sumOfSquares += centred * centred;
      }
      const rms = Math.sqrt(sumOfSquares / this.levelBuffer.length);
      // Speech RMS rarely passes ~0.3, so scale to make normal talking fill the meter.
      return Math.min(1, rms * 3.2);
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.currentState === "disposed") {
      throw this.invalidState("The recorder has been disposed.");
    }
    if (this.currentState !== "idle") {
      throw this.invalidState("A recording is already in progress.");
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new AdapterError("This device does not provide microphone recording.", {
        code: "mic-unavailable",
      });
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: this.options.audio ?? true,
      });
      this.mimeType = negotiateMimeType(this.options.preferredMimeTypes);
      this.mediaRecorder = this.mimeType
        ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
        : new MediaRecorder(this.stream);
    } catch (error) {
      this.releaseResources();
      throw this.mapMicrophoneError(error);
    }

    this.chunks = [];
    this.recordedBytes = 0;
    this.cancelled = false;
    this.limitError = null;
    this.autoStopped = false;
    this.startedAt = Date.now();
    this.bindRecorderEvents();
    this.setState("recording");
    try {
      this.mediaRecorder.start(10_000);
    } catch (error) {
      this.failStart();
      throw new AdapterError("The browser could not start recording.", {
        code: "recording-invalid",
        cause: error,
      });
    }
    this.durationTimer = setTimeout(() => {
      this.limitError = new AdapterError("Recording exceeded the five-minute limit.", {
        code: "recording-too-long",
      });
      this.finishStop();
    }, this.options.maxDurationMs);
    this.installVisibilityHandler();
    this.attachLevelAnalyser();
    void this.acquireWakeLock();
  }

  /** Feeds the level meter. Purely an enhancement -- failure must not stop a recording. */
  private attachLevelAnalyser(): void {
    if (!this.stream) {
      return;
    }
    const AudioContextCtor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }
    try {
      const context = new AudioContextCtor();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      context.createMediaStreamSource(this.stream).connect(analyser);
      this.audioContext = context;
      this.analyser = analyser;
      this.levelBuffer = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch {
      this.releaseLevelAnalyser();
    }
  }

  private releaseLevelAnalyser(): void {
    const context = this.audioContext;
    this.audioContext = null;
    this.analyser = null;
    this.levelBuffer = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  stop(): Promise<AudioRecording> {
    if (this.currentState !== "recording") {
      return Promise.reject(this.invalidState("There is no active recording to stop."));
    }

    if (this.autoStopped && this.limitError) {
      const error = this.limitError;
      this.autoStopped = false;
      this.limitError = null;
      this.setState("idle");
      return Promise.reject(error);
    }

    this.setState("stopping");
    return new Promise<AudioRecording>((resolve, reject) => {
      this.stopResolve = resolve;
      this.stopReject = reject;
      this.finishStop();
    });
  }

  async cancel(): Promise<void> {
    if (this.currentState === "disposed" || this.currentState === "idle") {
      return;
    }
    if (this.currentState === "recording") {
      this.setState("stopping");
    }
    this.cancelled = true;
    if (this.mediaRecorder?.state === "recording") {
      await new Promise<void>((resolve) => {
        this.cancelResolve = resolve;
        this.finishStop();
      });
    } else {
      this.releaseResources();
      this.setState("idle");
    }
  }

  subscribe(listener: (state: RecordingState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.currentState === "disposed") {
      return;
    }
    this.cancelled = true;
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
    }
    this.stopReject?.(this.invalidState("The recorder was disposed."));
    this.cancelResolve?.();
    this.stopResolve = null;
    this.stopReject = null;
    this.cancelResolve = null;
    this.releaseResources();
    this.setState("disposed");
    this.listeners.clear();
  }

  private bindRecorderEvents(): void {
    if (!this.mediaRecorder) {
      return;
    }
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
        this.recordedBytes += event.data.size;
        if (this.recordedBytes > this.options.maxBytes && !this.limitError) {
          this.limitError = new AdapterError("Recording exceeded the 25 MB limit.", {
            code: "recording-too-large",
          });
          this.finishStop();
        }
      }
    };
    this.mediaRecorder.onstop = () => this.completeStop();
    this.mediaRecorder.onerror = () => {
      this.failStop(
        new AdapterError("The browser could not finish the recording.", {
          code: "recording-invalid",
        }),
      );
    };
  }

  private finishStop(): void {
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return;
    }
    if (this.mediaRecorder?.state === "inactive") {
      this.completeStop();
    }
  }

  private completeStop(): void {
    if (this.currentState === "disposed") {
      this.cancelResolve?.();
      this.cancelResolve = null;
      this.stopResolve = null;
      this.stopReject = null;
      return;
    }
    const durationMs = Math.max(0, Date.now() - this.startedAt);
    const mimeType = this.mediaRecorder?.mimeType || this.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    const resolve = this.stopResolve;
    const reject = this.stopReject;
    const cancelled = this.cancelled;
    const limitError = this.limitError;
    const cancelResolve = this.cancelResolve;
    const hasConsumer = Boolean(resolve || reject || cancelResolve);

    this.stopResolve = null;
    this.stopReject = null;
    this.cancelResolve = null;
    this.releaseResources();

    if (cancelled) {
      this.setState("idle");
      resolve?.({ blob, mimeType, durationMs });
      cancelResolve?.();
      return;
    }
    if (limitError) {
      if (hasConsumer) {
        this.setState("idle");
        reject?.(limitError);
      } else {
        // Keep the flow's stop action available to surface the limit error.
        this.autoStopped = true;
      }
      return;
    }
    if (blob.size > this.options.maxBytes) {
      this.setState("idle");
      reject?.(
        new AdapterError("Recording exceeded the 25 MB limit.", {
          code: "recording-too-large",
        }),
      );
      return;
    }

    this.setState("idle");
    resolve?.({ blob, mimeType, durationMs });
  }

  private failStop(error: AdapterError): void {
    const reject = this.stopReject;
    const cancelResolve = this.cancelResolve;
    this.stopResolve = null;
    this.stopReject = null;
    this.cancelResolve = null;
    this.releaseResources();
    this.setState("idle");
    reject?.(error);
    cancelResolve?.();
  }

  private async acquireWakeLock(): Promise<void> {
    if (!("wakeLock" in navigator) || !navigator.wakeLock?.request) {
      return;
    }
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (this.currentState === "recording") {
        this.wakeLock = lock;
      } else {
        await lock.release();
      }
    } catch {
      // Wake lock is an enhancement and must not block recording.
    }
  }

  private installVisibilityHandler(): void {
    if (typeof document === "undefined" || this.visibilityHandler) {
      return;
    }
    this.visibilityHandler = () => {
      if (document.visibilityState === "visible" && this.currentState === "recording") {
        if (this.wakeLock?.released) {
          this.wakeLock = null;
        }
        void this.acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private releaseResources(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.releaseLevelAnalyser();
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock && !lock.released) {
      void lock.release().catch(() => undefined);
    }
    this.mediaRecorder = null;
    this.chunks = [];
    this.recordedBytes = 0;
  }

  private setState(state: RecordingState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private invalidState(message: string): AdapterError {
    return new AdapterError(message, { code: "recording-invalid" });
  }

  private mapMicrophoneError(error: unknown): AdapterError {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return new AdapterError("Microphone permission was denied.", {
        code: "mic-denied",
        cause: error,
      });
    }
    return new AdapterError("No usable microphone was found.", {
      code: "mic-unavailable",
      cause: error,
    });
  }

  private failStart(): void {
    this.releaseResources();
    this.setState("idle");
    this.chunks = [];
    this.limitError = null;
    this.startedAt = 0;
    this.mediaRecorder = null;
  }
}
