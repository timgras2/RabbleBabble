import { AlertCircle, Check, Clipboard, Info, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { AppServices } from "../app/types";
import { useDictation } from "../hooks/useDictation";
import { AdapterError } from "../platform/errors";
import { RecordButton } from "./components/RecordButton";

interface RecorderScreenProps {
  readonly services: AppServices;
  readonly onOpenSettings: () => void;
}

export function RecorderScreen({ services, onOpenSettings }: RecorderScreenProps) {
  const dictation = useDictation(services);
  const [copyStatus, setCopyStatus] = useStateCopyStatus();

  const start = async () => {
    try {
      await dictation.start();
    } catch (error) {
      if (error instanceof AdapterError && error.code === "missing-api-key") {
        onOpenSettings();
      }
    }
  };

  const stop = async () => {
    try {
      await dictation.stop();
    } catch {
      // The hook exposes the actionable error below the recorder.
    }
  };

  const copy = async () => {
    const result = await services.clipboard.writeText(dictation.result?.finalText ?? "");
    if (result.status === "copied") {
      setCopyStatus({ kind: "success", message: "Copied to clipboard." });
    } else {
      setCopyStatus({ kind: "error", message: result.message ?? "Could not copy the text." });
    }
  };

  const errorMessage = dictation.error ? messageForError(dictation.error) : null;
  const hasResult = Boolean(dictation.result);

  return (
    <main className="screen recorder-screen">
      <section className="hero-panel">
        <div className="eyebrow"><span className="eyebrow__dot" />Private by default</div>
        <h1>Say it once.<br /><em>Keep the words.</em></h1>
        <p className="hero-copy">Record a thought, get a clean transcript, and copy it wherever it belongs.</p>
      </section>

      <section className="recorder-card" aria-label="Recorder">
        <RecordButton state={dictation.state} onStart={start} onStop={stop} />
        {(dictation.state === "transcribing" || dictation.state === "cleaning") && (
          <button type="button" className="cancel-button" onClick={() => void dictation.cancel()}>Cancel request</button>
        )}
        <div className="state-line" aria-live="polite">
          {dictation.state === "idle" && "Ready when you are"}
          {dictation.state === "recording" && <><span className="pulse-dot" />Listening...</>}
          {dictation.state === "transcribing" && "Turning audio into text..."}
          {dictation.state === "cleaning" && "Polishing your words..."}
          {dictation.state === "completed" && "Transcript ready"}
          {dictation.state === "error" && "Something needs your attention"}
        </div>
      </section>

      {errorMessage && (
        <div className="notice notice--error" role="alert">
          <AlertCircle size={19} />
          <div><strong>{errorMessage.title}</strong><span>{errorMessage.detail}</span></div>
          {dictation.error?.code === "missing-api-key" || dictation.error?.code === "api-unauthorized" ? (
            <button type="button" className="text-button" onClick={onOpenSettings}>Open Settings</button>
          ) : null}
        </div>
      )}

      {hasResult && dictation.result && (
        <section className="result-card" aria-label="Transcript">
          <div className="result-card__header"><span>Final transcript</span><span className="result-card__check"><Check size={14} /> Ready</span></div>
          <p>{dictation.result.finalText}</p>
          {dictation.result.cleanupFailed && (
            <div className="inline-warning"><Info size={15} /> Cleanup was unavailable, so the raw transcript is shown.</div>
          )}
          <button type="button" className="copy-button" onClick={copy}><Clipboard size={17} /> Copy text</button>
          {copyStatus && <div className={`copy-status copy-status--${copyStatus.kind}`} role="status">{copyStatus.message}</div>}
        </section>
      )}

      <div className="trust-line"><ShieldCheck size={16} /> Audio is sent only when you stop recording. Nothing is saved as history.</div>
    </main>
  );
}

function useStateCopyStatus() {
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  return [status, setStatus] as const;
}

function messageForError(error: AdapterError): { title: string; detail: string } {
  switch (error.code) {
    case "missing-api-key": return { title: "Add your Groq API key", detail: "Open Settings to enter it before recording." };
    case "mic-denied": return { title: "Microphone permission is off", detail: "Allow microphone access for this site in Chrome, then try again." };
    case "mic-unavailable": return { title: "No microphone available", detail: "Check the device microphone and Chrome permissions." };
    case "offline": return { title: "You are offline", detail: "Reconnect to the internet. Recordings are not queued." };
    case "api-unauthorized": return { title: "The API key was rejected", detail: "Replace it with a valid Groq key in Settings." };
    case "api-rate-limited": return { title: "Groq rate limit reached", detail: "Wait a moment and try again." };
    case "recording-too-long": return { title: "Recording is too long", detail: "Keep recordings under five minutes." };
    case "recording-too-large": return { title: "Recording is too large", detail: "Keep recordings under 25 MB." };
    case "api-timeout": return { title: "The request timed out", detail: "Check your connection and try again." };
    case "api-server": return { title: "Could not reach Groq", detail: safeNetworkDetail(error) };
    case "api-invalid": return { title: "Groq rejected the request", detail: "Check the recording format and try again." };
    default: return { title: "Request failed", detail: error.message };
  }
}

function safeNetworkDetail(error: AdapterError): string {
  const cause = error.cause;
  if (cause instanceof Error && cause.message && cause.message.length < 120) {
    return `${cause.message}. Check the HTTPS connection and the Network tab for a blocked request.`;
  }
  return "The browser could not complete the request. Check the HTTPS connection and the Network tab for a blocked request.";
}
