import type { Unsubscribe } from "../types";
import type { RecordingSink } from "../store/types";

/**
 * "auto-stopped" is the recorder having ended itself at a limit with nobody
 * waiting on stop(). The recording is retained and the state is published, so
 * the UI can never keep claiming to record into a microphone that is gone.
 */
export type RecordingState = "idle" | "recording" | "stopping" | "auto-stopped" | "disposed";

/**
 * What ended a recording. Everything but "user" is the recorder ending itself,
 * which the UI has to be told about rather than left to guess at.
 */
export type RecordingEndCause = "user" | "duration-limit" | "byte-limit" | "interrupted";

export interface AudioRecording {
  /** Identifies the buffered copy in the local store, so it can be deleted. */
  readonly id: string;
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
  readonly endedBy: RecordingEndCause;
}

export interface AudioRecorderOptions {
  readonly preferredMimeTypes?: readonly string[];
  readonly audio?: MediaTrackConstraints;
  readonly maxDurationMs?: number;
  readonly maxBytes?: number;
  /** Passed to MediaRecorder. Capping it keeps mobile uploads small. */
  readonly audioBitsPerSecond?: number;
  /**
   * Receives each timeslice as it arrives, so a reload cannot lose the audio.
   * Optional, and never allowed to fail a recording: see RecordingSink.
   */
  readonly sink?: RecordingSink;
}

export interface AudioRecorder {
  readonly state: RecordingState;
  /**
   * Epoch milliseconds the current recording began, or null when nothing is in
   * progress. The elapsed timer derives from this rather than from its own
   * mount, so navigating away and back cannot reset it.
   */
  readonly startedAt: number | null;
  /**
   * Normalised 0..1 loudness of the live input, or null when nothing is being
   * recorded or the platform cannot measure it. Polled by the level meter, so
   * it must stay cheap and must never throw.
   */
  getInputLevel(): number | null;
  /**
   * MUST be called in the same turn as the user gesture that authorises it:
   * WebKit drops the microphone prompt when activation does not survive to
   * getUserMedia. See boundary rule 11 in architecture.md.
   */
  start(): Promise<void>;
  stop(): Promise<AudioRecording>;
  cancel(): Promise<void>;
  subscribe(listener: (state: RecordingState) => void): Unsubscribe;
  dispose(): void;
}
