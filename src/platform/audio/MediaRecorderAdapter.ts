import { AdapterError } from "../errors";
import { MAX_AUDIO_BYTES, MAX_AUDIO_MS } from "../../shared/limits";
import type { Unsubscribe } from "../types";
import { negotiateMimeType } from "./mimeNegotiation";
import type {
  AudioRecorder,
  AudioRecorderOptions,
  AudioRecording,
  RecordingEndCause,
  RecordingState,
} from "./types";

/** Internal: which self-imposed stop condition fired, before it is reported. */
type RecordingLimitKind = "duration" | "bytes" | "interrupted";

const DEFAULT_MAX_DURATION_MS = MAX_AUDIO_MS;
const DEFAULT_MAX_BYTES = MAX_AUDIO_BYTES;

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
  private startedAtMs = 0;
  private recordingId = "";
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResolve: ((recording: AudioRecording) => void) | null = null;
  private stopReject: ((error: unknown) => void) | null = null;
  private cancelResolve: (() => void) | null = null;
  private cancelled = false;
  private limitReached: RecordingLimitKind | null = null;
  /**
   * The audio of a recording the recorder ended by itself. Held until stop()
   * consumes it: dropping it here was the bug that lost five-minute takes.
   */
  private pendingRecording: AudioRecording | null = null;
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

  get startedAt(): number | null {
    return this.startedAtMs === 0 ? null : this.startedAtMs;
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

    // Boundary rule 11: getUserMedia is reached with no awaited promise between
    // it and the tap that authorised it, or WebKit refuses without prompting.
    const pending = navigator.mediaDevices.getUserMedia({
      audio: this.options.audio ?? true,
    });
    try {
      this.stream = await pending;
      this.mimeType = negotiateMimeType(this.options.preferredMimeTypes);
      const recorderOptions: MediaRecorderOptions = {
        ...(this.mimeType ? { mimeType: this.mimeType } : {}),
        ...(this.options.audioBitsPerSecond === undefined
          ? {}
          : { audioBitsPerSecond: this.options.audioBitsPerSecond }),
      };
      this.mediaRecorder = new MediaRecorder(this.stream, recorderOptions);
    } catch (error) {
      this.releaseResources();
      throw this.mapMicrophoneError(error);
    }

    this.chunks = [];
    this.recordedBytes = 0;
    this.cancelled = false;
    this.limitReached = null;
    this.pendingRecording = null;
    this.startedAtMs = Date.now();
    this.recordingId = crypto.randomUUID();
    this.toSink(() => this.options.sink?.open(this.recordingId, this.mimeType));
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
      this.limitReached = "duration";
      this.finishStop();
    }, this.options.maxDurationMs);
    this.installVisibilityHandler();
    this.installTrackHandlers();
    this.attachLevelAnalyser();
    void this.acquireWakeLock();
  }

  /**
   * A phone call, another app, or an unplugged headset takes the microphone and
   * MediaRecorder keeps happily producing silence. Ending the recording here is
   * what stops a silent upload from being metered and billed.
   */
  private installTrackHandlers(): void {
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.addEventListener("ended", this.onTrackLost);
      track.addEventListener("mute", this.onTrackLost);
    }
  }

  private readonly onTrackLost = (): void => {
    if (this.currentState !== "recording" || this.limitReached !== null) {
      return;
    }
    this.limitReached = "interrupted";
    this.finishStop();
  };

  private removeTrackHandlers(): void {
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.removeEventListener("ended", this.onTrackLost);
      track.removeEventListener("mute", this.onTrackLost);
    }
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
      // On iOS a context constructed outside a live user activation starts
      // suspended and never produces samples, so the meter -- and the silence
      // detection that reads the same analyser -- would read a flat line.
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
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
    // The recorder already ended itself. Hand over what it kept, rather than
    // rejecting -- the words are on the instance and the user still wants them.
    if (this.currentState === "auto-stopped") {
      const recording = this.pendingRecording;
      this.pendingRecording = null;
      this.limitReached = null;
      this.setState("idle");
      return recording === null
        ? Promise.reject(this.invalidState("The recording could not be recovered."))
        : Promise.resolve(recording);
    }
    if (this.currentState !== "recording") {
      return Promise.reject(this.invalidState("There is no active recording to stop."));
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
    if (this.currentState === "auto-stopped") {
      this.pendingRecording = null;
      this.limitReached = null;
      this.setState("idle");
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
    this.pendingRecording = null;
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
        this.toSink(() => this.options.sink?.write(this.recordingId, event.data));
        if (this.recordedBytes > this.options.maxBytes && this.limitReached === null) {
          this.limitReached = "bytes";
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
    const durationMs = Math.max(0, Date.now() - this.startedAtMs);
    // "audio/webm" as a blind default labels Safari's MPEG-4 bytes as WebM and
    // Groq rejects them. Only ever report a container we actually negotiated.
    const mimeType = this.mediaRecorder?.mimeType || this.mimeType;
    if (!mimeType) {
      this.failStop(
        new AdapterError("The browser did not report a recording format.", {
          code: "recording-invalid",
        }),
      );
      return;
    }
    const blob = new Blob(this.chunks, { type: mimeType });
    const resolve = this.stopResolve;
    const reject = this.stopReject;
    const cancelled = this.cancelled;
    const limitReached = this.limitReached;
    const cancelResolve = this.cancelResolve;
    const hasConsumer = Boolean(resolve || reject || cancelResolve);
    const recording: AudioRecording = {
      id: this.recordingId,
      blob,
      mimeType,
      durationMs,
      endedBy: endCause(limitReached),
    };
    this.toSink(() => this.options.sink?.close(this.recordingId));

    this.stopResolve = null;
    this.stopReject = null;
    this.cancelResolve = null;
    this.releaseResources();

    if (cancelled) {
      this.setState("idle");
      resolve?.(recording);
      cancelResolve?.();
      return;
    }
    if (limitReached !== null && !hasConsumer) {
      // Nobody is waiting on stop(), so the recorder ended itself. Keep the
      // audio and publish the state: silently dropping both was the bug.
      this.pendingRecording = recording;
      this.setState("auto-stopped");
      return;
    }
    if (limitReached === null && blob.size > this.options.maxBytes) {
      this.setState("idle");
      reject?.(
        new AdapterError("Recording exceeded the 25 MB limit.", {
          code: "recording-too-large",
        }),
      );
      return;
    }

    this.limitReached = null;
    this.setState("idle");
    resolve?.(recording);
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
    this.removeTrackHandlers();
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

  /** The buffer is an enhancement. A store that throws must not lose a take. */
  private toSink(work: () => void): void {
    try {
      work();
    } catch {
      // Deliberately silent: nothing here is worth interrupting a recording.
    }
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
    this.limitReached = null;
    this.pendingRecording = null;
    this.startedAtMs = 0;
    this.mediaRecorder = null;
  }
}

function endCause(limitReached: RecordingLimitKind | null): RecordingEndCause {
  switch (limitReached) {
    case "duration":
      return "duration-limit";
    case "bytes":
      return "byte-limit";
    case "interrupted":
      return "interrupted";
    default:
      return "user";
  }
}
