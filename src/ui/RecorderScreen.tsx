import { AlertCircle, Check, Clipboard, Info, Pencil, Share2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import type { AppServices } from "../app/types";
import { useDictation } from "../hooks/useDictation";
import { AdapterError } from "../platform/errors";
import { messageForError } from "./errorMessages";
import { SERVICE_MODE } from "../app/mode";
import type { AdapterErrorCode } from "../platform/errors";
import { MAX_INSTRUCTION_CHARS } from "../shared/limits";
import type { DictationState } from "../services/types";
import { LevelMeter } from "./components/LevelMeter";
import { RecordButton } from "./components/RecordButton";
import { haptics } from "./haptics";

interface RecorderScreenProps {
  readonly services: AppServices;
  readonly onOpenSettings: () => void;
  readonly onSignIn: () => void;
  /** App focuses this after a route change, so navigation is announced. */
  readonly focusRef?: Ref<HTMLElement>;
}

export function RecorderScreen({ services, onOpenSettings, onSignIn, focusRef }: RecorderScreenProps) {
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

  // Derived from the recorder's own start time, not from this effect running:
  // opening Settings mid-recording unmounts the screen, and a timer that
  // restarts from zero against a real five-minute cap is a lie.
  useEffect(() => {
    if (dictation.state !== "recording") {
      return;
    }

    const tick = () => {
      const startedAt = services.recorder.startedAt;
      setElapsedMs(startedAt === null ? 0 : Date.now() - startedAt);
    };
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [dictation.state, services.recorder]);

  const start = async () => {
    setCopyStatus(null);
    setRewriteOpen(false);
    setRewriteInstruction("");
    setElapsedMs(0);
    try {
      // Nothing may be awaited between the tap and this call: WebKit needs the
      // user activation to still be live when getUserMedia is reached.
      await dictation.start();
      haptics.recordStart();
    } catch (error) {
      if (error instanceof AdapterError) {
        if (error.code === "missing-api-key" && !SERVICE_MODE) {
          onOpenSettings();
        } else if (error.code === "not-authenticated") {
          onSignIn();
        }
      }
    }
  };

  const applyPreset = async (instruction: string) => {
    setCopyStatus(null);
    try {
      await dictation.rewrite(instruction);
      setRewriteOpen(false);
      setRewriteInstruction("");
    } catch {
      // The snapshot keeps the previous transcript and carries the error.
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
      // The snapshot carries the actionable error below the recorder.
    }
  };

  const retryUpload = async () => {
    try {
      await dictation.retryUpload();
    } catch {
      // Same: a second failure updates the same error in the snapshot.
    }
  };

  const share = async () => {
    const result = await services.clipboard.shareText(dictation.result?.finalText ?? "");
    if (result.status === "unavailable" || result.status === "denied") {
      setCopyStatus({ kind: "error", message: result.message ?? "Could not share the text." });
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

  // Only the transcript text scrolls, inside its own bounded box -- the
  // header and every button below it (copy, rewrite) stay in normal flow
  // beneath that box, never inside the scrolling area themselves.
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [scrollFade, setScrollFade] = useState({ up: false, down: false });

  // Fading real content (rather than masking it permanently) means the fade
  // only shows on an edge that genuinely has more to scroll to, and clears
  // once you have actually reached it.
  const updateScrollFade = useCallback(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    const slack = 2;
    setScrollFade({
      up: el.scrollTop > slack,
      down: el.scrollTop + el.clientHeight < el.scrollHeight - slack,
    });
  }, []);

  useEffect(() => {
    updateScrollFade();
  }, [updateScrollFade, hasResult, dictation.result, dictation.state]);

  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateScrollFade);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollFade]);

  const scrollFadeMask = buildScrollFadeMask(scrollFade);
  // The intro explains the product to a first-time user; once they have a
  // finished transcript it is dead weight in front of the tool, so it retires
  // for the rest of this session. It is not persisted, so it greets again
  // next time the page loads.
  const [everCompletedThisSession, setEverCompletedThisSession] = useState(false);
  if (hasResult && !everCompletedThisSession) {
    setEverCompletedThisSession(true);
  }
  const showIntro = !everCompletedThisSession;

  // The one thing this app must never do is lose words, and a stray back
  // gesture mid-recording -- or with an uncopied transcript on screen -- does
  // exactly that. Browsers only honour this after a real interaction, which a
  // recording always is.
  const atRisk = dictation.state === "recording" || hasResult;
  useEffect(() => {
    if (!atRisk) {
      return;
    }
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [atRisk]);

  // getInputLevel() was well implemented and fed nothing but the meter, which
  // only helps someone looking at the screen -- the one thing a dictation user
  // is not doing. A wrong or muted input reads as sustained silence.
  const [silent, setSilent] = useState(false);
  const recording = dictation.state === "recording";
  useEffect(() => {
    if (!recording) {
      return;
    }
    let quietTicks = 0;
    const timer = setInterval(() => {
      const level = services.recorder.getInputLevel();
      quietTicks = level !== null && level < SILENCE_LEVEL ? quietTicks + 1 : 0;
      setSilent(quietTicks >= SILENCE_TICKS);
    }, SILENCE_TICK_MS);
    return () => {
      clearInterval(timer);
      setSilent(false);
    };
  }, [recording, services.recorder]);

  const stateLabel = silent && recording ? SILENT_LABEL : STATE_LABELS[dictation.state];
  // Exactly two live regions on the screen, both empty of interactive content.
  // The old model wrapped the whole result card -- transcript, rewrite form and
  // copy button -- in one polite region containing three more, so a single
  // dictation announced itself five times over.
  const politeAnnouncement =
    copyStatus?.kind === "success" ? "Copied to clipboard." : dictation.notice ?? stateLabel;
  const assertiveAnnouncement =
    copyStatus?.kind === "error"
      ? copyStatus.message
      : errorMessage
        ? `${errorMessage.title}. ${errorMessage.detail}`
        : "";

  return (
    <main className={`screen recorder-screen${hasResult ? "" : " recorder-screen--idle"}`} ref={focusRef} tabIndex={-1}>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">{politeAnnouncement}</div>
      <div className="visually-hidden" role="alert" aria-atomic="true">{assertiveAnnouncement}</div>
      <div className="transcript-zone">
        {showIntro && !hasResult ? (
          <section className="hero-panel">
            <h1>Why type<br />when you can talk?</h1>
            <p className="hero-copy">Record a thought, get a clean transcript, and copy it wherever it belongs.</p>
          </section>
        ) : (
          // The hero retires after the first transcript, so without this the
          // screen would have no h1 at all for the rest of the session.
          <h1 className="visually-hidden">Recorder</h1>
        )}

        {!showIntro && !hasResult && !errorMessage && (
          <p className="transcript-placeholder">Your transcript will appear here.</p>
        )}

      {hasResult && dictation.result && (
        <section className="result-card result-card--top" aria-label="Transcript">
          <div className="result-card__header"><span>Final transcript</span><span className="result-card__check"><Check size={14} /> {dictation.state === "rewriting" ? "Updating" : "Ready"}</span></div>
          <div
            ref={transcriptScrollRef}
            className="transcript-scroll"
            style={scrollFadeMask ? { WebkitMaskImage: scrollFadeMask, maskImage: scrollFadeMask } : undefined}
            onScroll={updateScrollFade}
          >
            <p>{dictation.result.finalText}</p>
          </div>
          {dictation.result.cleanupFailed && (
            <div className="inline-warning"><Info size={15} /> Cleanup was unavailable, so the raw transcript is shown.</div>
          )}
          {rewriteOpen ? (
            <form className="rewrite-form" onSubmit={(event) => { event.preventDefault(); void applyRewrite(); }}>
              {/* One tap for the four things people actually ask for. They post
                  the same instruction the textarea does -- no new backend. */}
              <div className="rewrite-presets">
                {REWRITE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="rewrite-preset"
                    disabled={dictation.state === "rewriting"}
                    onClick={() => void applyPreset(preset.instruction)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <label htmlFor="rewrite-instruction">Or describe the change yourself</label>
              <textarea
                id="rewrite-instruction"
                value={rewriteInstruction}
                onChange={(event) => setRewriteInstruction(event.target.value)}
                placeholder="Make it concise, turn it into bullet points, or rewrite it as an email..."
                maxLength={MAX_INSTRUCTION_CHARS}
                disabled={dictation.state === "rewriting"}
                autoFocus
              />
              <div className="rewrite-form__meta">{rewriteInstruction.length}/{MAX_INSTRUCTION_CHARS}</div>
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
          <div className="result-card__actions">
            <button
              type="button"
              className={`copy-button${copyStatus?.kind === "success" ? " copy-button--copied" : ""}`}
              onClick={copy}
            >
              {copyStatus?.kind === "success" ? <><Check size={17} /> Copied</> : <><Clipboard size={17} /> Copy text</>}
            </button>
            {/* Only where the platform actually has a share sheet. Elsewhere
                Copy is the whole answer, and a dead button is worse than none. */}
            {services.clipboard.canShare() && (
              <button type="button" className="share-button" onClick={share} aria-label="Share transcript">
                <Share2 size={17} />
              </button>
            )}
          </div>
          {copyStatus?.kind === "error" && <div className="copy-status copy-status--error">{copyStatus.message}</div>}
        </section>
      )}

        {dictation.recoverable !== null && (
          <div className="notice notice--info">
            <Info size={19} />
            <div>
              <strong>An unfinished recording is still here</strong>
              <span>
                A recording from an earlier session never got a transcript back. Transcribe it now, or
                discard it?
              </span>
            </div>
            <div className="notice__actions">
              <button type="button" className="text-button" onClick={() => void dictation.recoverBuffered()}>
                Transcribe
              </button>
              <button type="button" className="text-button" onClick={() => void dictation.discardBuffered()}>
                Discard
              </button>
            </div>
          </div>
        )}

        {dictation.notice && !errorMessage && (
          <div className="notice notice--info">
            <Info size={19} />
            <div><span>{dictation.notice}</span></div>
          </div>
        )}

        {errorMessage && (
          <div className="notice notice--error">
            <AlertCircle size={19} />
            <div><strong>{errorMessage.title}</strong><span>{errorMessage.detail}</span></div>
            <ErrorAction
              code={dictation.error?.code}
              canRetry={dictation.canRetry}
              onRetry={retryUpload}
              onOpenSettings={onOpenSettings}
              onSignIn={onSignIn}
            />
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
          {/* Not a live region: the single polite announcer at the top of the
              screen already carries this text, and two of them means two
              announcements per state change. */}
          <div className="state-line">{stateLabel}</div>
          {busy && (
            <button type="button" className="cancel-button" onClick={() => void dictation.cancel()}>
              {dictation.state === "rewriting" ? "Cancel rewrite" : "Cancel request"}
            </button>
          )}
        </div>
        <div className="trust-line">
          <ShieldCheck size={15} /> Audio is sent when you stop, and deleted from this device once the
          transcript arrives.
        </div>
      </section>
    </main>
  );
}

const REWRITE_PRESETS = [
  { label: "Tighten it up", instruction: "Tighten this up. Same meaning, fewer words." },
  { label: "Bullet points", instruction: "Rewrite this as a short list of bullet points." },
  { label: "Formal email", instruction: "Rewrite this as a short, polite, formal email." },
  { label: "Translate to English", instruction: "Translate this into English." },
] as const;

/** Six seconds under a level normal speech clears easily. */
const SILENCE_LEVEL = 0.04;
const SILENCE_TICK_MS = 500;
const SILENCE_TICKS = 12;
const SILENT_LABEL = "Recording, but hearing nothing - check the microphone";

const STATE_LABELS: Record<DictationState, string> = {
  idle: "Tap to start recording",
  recording: "Listening... tap to stop",
  transcribing: "Turning audio into text...",
  cleaning: "Polishing your words...",
  rewriting: "Applying your changes...",
  completed: "Transcript ready",
  error: "Something needs your attention",
};

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

const SCROLL_FADE_PX = 28;

function buildScrollFadeMask({ up, down }: { readonly up: boolean; readonly down: boolean }): string | undefined {
  if (!up && !down) {
    return undefined;
  }
  const top = up ? `transparent 0, black ${SCROLL_FADE_PX}px` : "black 0";
  const bottom = down ? `black calc(100% - ${SCROLL_FADE_PX}px), transparent 100%` : "black 100%";
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}



function ErrorAction({
  code,
  canRetry,
  onRetry,
  onOpenSettings,
  onSignIn,
}: {
  readonly code: AdapterErrorCode | undefined;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
  readonly onSignIn: () => void;
}) {
  // "Try again" comes first when the recording is still held: whatever else is
  // wrong, the words are recoverable and that is what the user came for.
  const retry = canRetry ? (
    <button type="button" className="text-button" onClick={onRetry}>Try again</button>
  ) : null;

  if (code === "not-authenticated" || (SERVICE_MODE && code === "missing-api-key")) {
    return <>{retry}<button type="button" className="text-button" onClick={onSignIn}>Sign in</button></>;
  }
  if (code === "quota-exceeded") {
    return <>{retry}<button type="button" className="text-button" onClick={onOpenSettings}>See usage</button></>;
  }
  if (code === "missing-api-key" || code === "api-unauthorized") {
    return <>{retry}<button type="button" className="text-button" onClick={onOpenSettings}>Open Settings</button></>;
  }
  return retry;
}
