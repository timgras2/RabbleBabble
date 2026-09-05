import { AlertCircle, Check, Clipboard, Info, Pencil, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppServices } from "../app/types";
import { useDictation } from "../hooks/useDictation";
import { AdapterError } from "../platform/errors";
import { MAX_REWRITE_INSTRUCTION_LENGTH } from "../platform/inference/groqClient";
import { LevelMeter } from "./components/LevelMeter";
import { RecordButton } from "./components/RecordButton";
import { haptics } from "./haptics";

interface RecorderScreenProps {
  readonly services: AppServices;
  readonly onOpenSettings: () => void;
}

export function RecorderScreen({ services, onOpenSettings }: RecorderScreenProps) {
  const dictation = useDictation(services);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [copyStatus, setCopyStatus] = useStateCopyStatus();
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [showProgress, setShowProgress] = useState(false);

  const busy =
    dictation.state === "transcribing" ||
    dictation.state === "cleaning" ||
    dictation.state === "rewriting";

  // A short wait needs no chrome; a long one has to read as working, not hung.
  useEffect(() => {
    if (!busy) {
      return;
    }
    const timer = setTimeout(() => setShowProgress(true), 4_000);
    return () => {
      clearTimeout(timer);
      setShowProgress(false);
    };
  }, [busy]);

  useEffect(() => {
    if (dictation.state !== "recording") {
      return;
    }

    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => clearInterval(timer);
  }, [dictation.state]);

  const start = async () => {
    setCopyStatus(null);
    setRewriteOpen(false);
    setRewriteInstruction("");
    setElapsedMs(0);
    try {
      await dictation.start();
      haptics.recordStart();
    } catch (error) {
      if (error instanceof AdapterError && error.code === "missing-api-key") {
        onOpenSettings();
      }
    }
  };

  const applyRewrite = async () => {
    if (!rewriteInstruction.trim()) return;
    setCopyStatus(null);
    try {
      await dictation.rewrite(rewriteInstruction);
      setRewriteOpen(false);
      setRewriteInstruction("");
    } catch {
      // The hook exposes the actionable error while preserving the result.
    }
  };

  const stop = async () => {
    haptics.recordStop();
    try {
      await dictation.stop();
    } catch {
      // The hook exposes the actionable error below the recorder.
    }
  };

  const copy = async () => {
    const result = await services.clipboard.writeText(dictation.result?.finalText ?? "");
    if (result.status === "copied") {
      haptics.copied();
      setCopyStatus({ kind: "success", message: "Copied" });
    } else {
      setCopyStatus({ kind: "error", message: result.message ?? "Could not copy the text." });
    }
  };

  // The confirmation lives on the button the eye is already on, then reverts.
  useEffect(() => {
    if (copyStatus?.kind !== "success") {
      return;
    }
    const timer = setTimeout(() => setCopyStatus(null), 2_000);
    return () => clearTimeout(timer);
  }, [copyStatus, setCopyStatus]);

  const errorMessage = dictation.error ? messageForError(dictation.error) : null;
  const hasResult = Boolean(dictation.result);
  // The intro explains the product to a first-time user; once they have a
  // finished transcript it is dead weight in front of the tool, so it retires
  // for the rest of this session. It is not persisted, so it greets again
  // next time the page loads.
  const [everCompletedThisSession, setEverCompletedThisSession] = useState(false);
  if (hasResult && !everCompletedThisSession) {
    setEverCompletedThisSession(true);
  }
  const showIntro = !everCompletedThisSession;

  return (
    <main className="screen recorder-screen">
      <div className="transcript-zone" aria-live="polite">
        {showIntro && !hasResult && (
          <section className="hero-panel">
            <h1>Why type<br />when you can talk?</h1>
            <p className="hero-copy">Record a thought, get a clean transcript, and copy it wherever it belongs.</p>
          </section>
        )}

        {!showIntro && !hasResult && !errorMessage && (
          <p className="transcript-placeholder">Your transcript will appear here.</p>
        )}

      {hasResult && dictation.result && (
        <section className="result-card result-card--top" aria-label="Transcript">
          <div className="result-card__header"><span>Final transcript</span><span className="result-card__check"><Check size={14} /> {dictation.state === "rewriting" ? "Updating" : "Ready"}</span></div>
          <p>{dictation.result.finalText}</p>
          {dictation.result.cleanupFailed && (
            <div className="inline-warning"><Info size={15} /> Cleanup was unavailable, so the raw transcript is shown.</div>
          )}
          {rewriteOpen ? (
            <form className="rewrite-form" onSubmit={(event) => { event.preventDefault(); void applyRewrite(); }}>
              <label htmlFor="rewrite-instruction">How should this transcript change?</label>
              <textarea
                id="rewrite-instruction"
                value={rewriteInstruction}
                onChange={(event) => setRewriteInstruction(event.target.value)}
                placeholder="Make it concise, turn it into bullet points, or rewrite it as an email..."
                maxLength={MAX_REWRITE_INSTRUCTION_LENGTH}
                disabled={dictation.state === "rewriting"}
                autoFocus
              />
              <div className="rewrite-form__meta">{rewriteInstruction.length}/{MAX_REWRITE_INSTRUCTION_LENGTH}</div>
              <div className="rewrite-form__actions">
                <button className="rewrite-form__apply" type="submit" disabled={dictation.state === "rewriting" || !rewriteInstruction.trim()}>
                  {dictation.state === "rewriting" ? "Rewriting..." : "Apply rewrite"}
                </button>
                {dictation.state !== "rewriting" && (
                  <button className="rewrite-form__cancel" type="button" onClick={() => setRewriteOpen(false)}>Cancel</button>
                )}
              </div>
            </form>
          ) : (
            <button type="button" className="rewrite-trigger" onClick={() => setRewriteOpen(true)}>
              <Pencil size={16} /> Rewrite transcript
            </button>
          )}
          <button
            type="button"
            className={`copy-button${copyStatus?.kind === "success" ? " copy-button--copied" : ""}`}
            onClick={copy}
          >
            {copyStatus?.kind === "success" ? <><Check size={17} /> Copied</> : <><Clipboard size={17} /> Copy text</>}
          </button>
          <span className="visually-hidden" role="status">{copyStatus?.kind === "success" ? "Copied to clipboard." : ""}</span>
          {copyStatus?.kind === "error" && <div className="copy-status copy-status--error" role="alert">{copyStatus.message}</div>}
        </section>
      )}

        {errorMessage && (
          <div className="notice notice--error" role="alert">
            <AlertCircle size={19} />
            <div><strong>{errorMessage.title}</strong><span>{errorMessage.detail}</span></div>
            {dictation.error?.code === "missing-api-key" || dictation.error?.code === "api-unauthorized" ? (
              <button type="button" className="text-button" onClick={onOpenSettings}>Open Settings</button>
            ) : null}
          </div>
        )}
      </div>

      <section className="action-zone" aria-label="Recorder">
        <RecordButton
          state={dictation.state}
          onStart={start}
          onStop={stop}
          recordingIndicator={<LevelMeter recorder={services.recorder} active />}
        />
        <div className="action-zone__status">
          {/* Below the dial, and always rendered: keeping the timer above it
              pushed the dial down at the moment you tapped it. */}
          <div className="action-zone__timer">
            {dictation.state === "recording" && (
              <div className="recording-timer">
                {formatDuration(elapsedMs)} <span>/ 05:00</span>
              </div>
            )}
          </div>
          {showProgress && <div className="progress-bar" aria-hidden="true"><span /></div>}
          <div className="state-line" aria-live="polite">
            {dictation.state === "idle" && "Tap to start recording"}
            {dictation.state === "recording" && "Listening... tap to stop"}
            {dictation.state === "transcribing" && "Turning audio into text..."}
            {dictation.state === "cleaning" && "Polishing your words..."}
            {dictation.state === "rewriting" && "Applying your changes..."}
            {dictation.state === "completed" && "Transcript ready"}
            {dictation.state === "error" && "Something needs your attention"}
          </div>
          {busy && (
            <button type="button" className="cancel-button" onClick={() => void dictation.cancel()}>
              {dictation.state === "rewriting" ? "Cancel rewrite" : "Cancel request"}
            </button>
          )}
        </div>
        <div className="trust-line"><ShieldCheck size={15} /> Audio is sent when you stop. Nothing is saved as history.</div>
      </section>
    </main>
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
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
    case "invalid-instruction": return { title: "Add a rewrite instruction", detail: "Describe how you want the transcript changed." };
    case "rewrite-too-large": return { title: "Rewrite request is too long", detail: "Shorten the transcript or rewrite instruction and try again." };
    case "cancelled": return { title: "Request cancelled", detail: "No changes were made to the transcript." };
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
