import type { Unsubscribe } from "../types";

export type RecordingState = "idle" | "recording" | "stopping" | "disposed";

export interface AudioRecording {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
}

export interface AudioRecorderOptions {
  readonly preferredMimeTypes?: readonly string[];
  readonly audio?: MediaTrackConstraints;
  readonly maxDurationMs?: number;
  readonly maxBytes?: number;
}

export interface AudioRecorder {
  readonly state: RecordingState;
  /**
   * Normalised 0..1 loudness of the live input, or null when nothing is being
   * recorded or the platform cannot measure it. Polled by the level meter, so
   * it must stay cheap and must never throw.
   */
  getInputLevel(): number | null;
  start(): Promise<void>;
  stop(): Promise<AudioRecording>;
  cancel(): Promise<void>;
  subscribe(listener: (state: RecordingState) => void): Unsubscribe;
  dispose(): void;
}
