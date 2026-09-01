import { LoaderCircle, Mic, Square } from "lucide-react";
import type { DictationState } from "../../services/types";

interface RecordButtonProps {
  readonly state: DictationState;
  readonly onStart: () => void;
  readonly onStop: () => void;
}

export function RecordButton({ state, onStart, onStop }: RecordButtonProps) {
  const recording = state === "recording";
  const busy = state === "transcribing" || state === "cleaning";
  const disabled = busy;
  const label = recording
    ? "Stop recording"
    : state === "transcribing"
      ? "Transcribing"
      : state === "cleaning"
        ? "Cleaning transcript"
        : "Start recording";

  return (
    <button
      className={`record-button${recording ? " record-button--active" : ""}`}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={recording ? onStop : onStart}
    >
      {busy ? <LoaderCircle className="record-button__icon spin" /> : recording ? <Square className="record-button__icon" /> : <Mic className="record-button__icon" />}
      <span>{label}</span>
    </button>
  );
}
