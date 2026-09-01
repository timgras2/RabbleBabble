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
  start(): Promise<void>;
  stop(): Promise<AudioRecording>;
  cancel(): Promise<void>;
  subscribe(listener: (state: RecordingState) => void): Unsubscribe;
  dispose(): void;
}
