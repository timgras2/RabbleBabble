import { LoaderCircle, Mic, Square } from "lucide-react";
import type { ReactNode } from "react";
import type { DictationState } from "../../services/types";

interface RecordButtonProps {
  readonly state: DictationState;
  readonly onStart: () => void;
  readonly onStop: () => void;
  /** Shown in place of the icon while recording -- the live level meter. */
  readonly recordingIndicator?: ReactNode;
}

export function RecordButton({ state, onStart, onStop, recordingIndicator }: RecordButtonProps) {
  const recording = state === "recording";
  const busy = state === "transcribing" || state === "cleaning" || state === "rewriting";
  const disabled = busy;
  const label = recording
    ? "Stop recording"
    : state === "transcribing"
      ? "Transcribing"
      : state === "cleaning"
        ? "Cleaning transcript"
        : state === "rewriting"
          ? "Rewriting transcript"
        : "Start recording";

  const leading = busy ? (
    <LoaderCircle className="record-button__icon spin" />
  ) : recording ? (
    (recordingIndicator ?? <Square className="record-button__icon" />)
  ) : (
    <Mic className="record-button__icon" />
  );

  return (
    <button
      className={`record-button${recording ? " record-button--active" : ""}`}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={recording ? onStop : onStart}
    >
      {leading}
      <span>{label}</span>
    </button>
  );
}
