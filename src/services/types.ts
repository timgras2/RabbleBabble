import type { AdapterError } from "../platform/errors";
import type { BufferedRecording } from "../platform/store/types";
import type { Unsubscribe } from "../platform/types";

export type DictationState =
  | "idle"
  | "recording"
  | "transcribing"
  | "cleaning"
  | "rewriting"
  | "completed"
  | "error";

export interface DictationResult {
  readonly rawText: string;
  readonly finalText: string;
  readonly cleanupApplied: boolean;
  readonly cleanupFailed: boolean;
}

/**
 * Everything the recorder screen renders, in one object.
 *
 * State, result, error and notice used to live in three places -- two of them
 * component state that unmounted on navigation -- which is how the app came to
 * show "Something needs your attention" with nothing saying what.
 */
export interface DictationSnapshot {
  readonly state: DictationState;
  readonly result: DictationResult | null;
  readonly error: AdapterError | null;
  /** Something that happened without the user asking, e.g. hitting a limit. */
  readonly notice: string | null;
  /** A recording is still held, so the upload can be retried as-is. */
  readonly canRetry: boolean;
  /**
   * Audio found in the local buffer on boot, from a session that never
   * delivered a transcript. Offered rather than transcribed: spending the
   * user's quota on something they did not ask for is not a favour.
   */
  readonly recoverable: BufferedRecording | null;
}

export interface DictationFlow {
  /**
   * Stable by identity between changes: useSyncExternalStore compares that way,
   * and a fresh object per call is an infinite render loop.
   */
  getSnapshot(): DictationSnapshot;
  readonly state: DictationState;
  readonly result: DictationResult | null;
  start(): Promise<void>;
  stop(): Promise<DictationResult>;
  /** Re-sends a recording held after a failed upload. No re-recording. */
  retryUpload(): Promise<DictationResult>;
  /** Transcribes the buffered recording the user has just accepted. */
  recoverBuffered(): Promise<DictationResult>;
  /** Deletes it instead. */
  discardBuffered(): Promise<void>;
  rewrite(instruction: string): Promise<DictationResult>;
  cancel(): Promise<void>;
  subscribe(listener: () => void): Unsubscribe;
}
