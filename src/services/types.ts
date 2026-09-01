import type { Unsubscribe } from "../platform/types";

export type DictationState =
  | "idle"
  | "recording"
  | "transcribing"
  | "cleaning"
  | "completed"
  | "error";

export interface DictationResult {
  readonly rawText: string;
  readonly finalText: string;
  readonly cleanupApplied: boolean;
  readonly cleanupFailed: boolean;
}

export interface DictationFlow {
  readonly state: DictationState;
  readonly result: DictationResult | null;
  start(): Promise<void>;
  stop(): Promise<DictationResult>;
  cancel(): Promise<void>;
  subscribe(listener: (state: DictationState) => void): Unsubscribe;
}
