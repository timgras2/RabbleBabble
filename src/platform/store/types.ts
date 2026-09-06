import type { AudioRecording } from "../audio/types";

/** What is known about a buffered recording without loading its bytes. */
export interface BufferedRecording {
  readonly id: string;
  readonly createdAt: number;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface HistoryEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly text: string;
}

/**
 * Where a recording lives between being spoken and being transcribed.
 *
 * The adapter writes each ten-second timeslice as it arrives, so a reload, a
 * crash or a killed tab mid-upload leaves the audio recoverable rather than
 * gone. It is deleted the moment a transcript comes back: this is a buffer,
 * not an archive, and the product's promise depends on the difference.
 */
export interface RecordingSink {
  open(recordingId: string, mimeType: string): void;
  write(recordingId: string, chunk: Blob): void;
  close(recordingId: string): void;
}

export interface LocalStore extends RecordingSink {
  listRecordings(): Promise<readonly BufferedRecording[]>;
  loadRecording(id: string): Promise<AudioRecording | null>;
  dropRecording(id: string): Promise<void>;

  /** Opt-in, off by default. See Settings. */
  saveTranscript(text: string): Promise<void>;
  listTranscripts(): Promise<readonly HistoryEntry[]>;
  clearTranscripts(): Promise<void>;

  /**
   * Deletes buffered audio that is too old or beyond the retained count, so a
   * failure mode cannot quietly fill up the device.
   */
  sweep(nowMs: number): Promise<void>;
}
