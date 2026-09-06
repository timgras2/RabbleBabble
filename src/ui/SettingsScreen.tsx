import { BookText, Check, Eye, EyeOff, History, KeyRound, Languages, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { SERVICE_MODE } from "../app/mode";
import type { AppServices } from "../app/types";
import { useSettings } from "../hooks/useSettings";
import { useAuthSession } from "../hooks/useAuthSession";
import { MAX_VOCABULARY_CHARS } from "../shared/limits";
import { AccountPanel } from "./settings/AccountPanel";
import { HistoryList } from "./settings/HistoryList";

interface SettingsScreenProps {
  readonly services: AppServices;
  readonly focusRef?: Ref<HTMLElement>;
}

const LANGUAGE_SAVE_DELAY_MS = 600;

export function SettingsScreen({ services, focusRef }: SettingsScreenProps) {
  const { settings, update, clearApiKey } = useSettings(services);
  const auth = useAuthSession(services);
  const [apiKey, setApiKey] = useState(settings.groqApiKey);
  const [language, setLanguage] = useState(settings.language);
  // Seeded from the server copy on first render, which is the authoritative
  // one: it is what the Worker actually biases transcription with.
  const [vocabulary, setVocabulary] = useState(
    SERVICE_MODE ? (auth.account?.vocabulary ?? settings.vocabulary) : settings.vocabulary,
  );
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(timer);
  }, [saved]);

  // The toggle looks and behaves like an instant switch, so it is one. Mirroring
  // it into local state and persisting only on "Save settings" meant walking
  // away from Settings silently discarded the change.
  const setCleanupEnabled = (next: boolean) => {
    update({ cleanupEnabled: next });
  };

  // The language field is free text, so it settles before it is written --
  // but it is still written without being asked to be.
  const languageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistLanguage = (next: string) => {
    setLanguage(next);
    if (languageTimer.current) {
      clearTimeout(languageTimer.current);
    }
    languageTimer.current = setTimeout(() => update({ language: next.trim() }), LANGUAGE_SAVE_DELAY_MS);
  };
  const flushLanguage = () => {
    if (languageTimer.current) {
      clearTimeout(languageTimer.current);
      languageTimer.current = null;
    }
    update({ language: language.trim() });
  };
  useEffect(() => () => {
    if (languageTimer.current) {
      clearTimeout(languageTimer.current);
    }
  }, []);

  // Free text again, so it settles before it is written -- but here the write
  // also has to reach the server, so it is only ever sent on blur.
  const saveVocabulary = () => {
    const next = vocabulary.trim().slice(0, MAX_VOCABULARY_CHARS);
    if (next === settings.vocabulary && !SERVICE_MODE) {
      return;
    }
    update({ vocabulary: next });
    if (SERVICE_MODE && next !== auth.account?.vocabulary) {
      void auth.saveVocabulary(next);
    }
  };

  const saveApiKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    flushLanguage();
    update({ groqApiKey: apiKey.trim() });
    setSaved(true);
  };

  const clear = () => {
    clearApiKey();
    setApiKey("");
    setSaved(false);
  };

  return (
    <main className="screen settings-screen" ref={focusRef} tabIndex={-1}>
      {/* The screen's one polite announcer. */}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {saved ? "Settings saved on this device." : ""}
      </div>
      <section className="settings-heading">
        <h1>Settings</h1>
        <p>
          {SERVICE_MODE
            ? "Audio is sent to RabbleBabble, transcribed, and never stored there. It is held on this device only until the transcript comes back."
            : "These settings stay on this device. Your key is used directly by your browser to reach Groq."}
        </p>
      </section>

      <form className="settings-form" onSubmit={saveApiKey}>
        {SERVICE_MODE ? (
          <AccountPanel services={services} />
        ) : (
          <div className="field-group">
            <label htmlFor="groq-key">Groq API key</label>
            <div className="input-wrap">
              <KeyRound size={18} />
              <input id="groq-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="gsk_..." autoComplete="off" />
              <button type="button" className="input-action" aria-label={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </div>
            <small>Stored in localStorage for this trusted device. Never commit or share it.</small>
          </div>
        )}

        <div className="setting-row">
          <div><strong>Clean up transcripts</strong><span>Fix grammar and punctuation after transcription.</span></div>
          <button type="button" className={`toggle${settings.cleanupEnabled ? " toggle--on" : ""}`} role="switch" aria-checked={settings.cleanupEnabled} aria-label="Clean up transcripts" onClick={() => setCleanupEnabled(!settings.cleanupEnabled)}><span /></button>
        </div>

        <div className="field-group">
          <label htmlFor="language"><Languages size={16} /> Language hint <span>(optional)</span></label>
          <input
            id="language"
            type="text"
            value={language}
            onChange={(event) => persistLanguage(event.target.value)}
            onBlur={flushLanguage}
            placeholder="en"
            maxLength={16}
          />
          <small>Leave blank to let Whisper detect the language. Saved as you type.</small>
        </div>

        {/* The highest-value feature in the plan, and one form field: dictation
            apps live or die on proper nouns. It reaches Groq as Whisper's
            `prompt` -- a biasing hint -- and never the chat models, where the
            JSON.stringify framing in shared/prompts.ts is what keeps a hostile
            transcript inert. */}
        <div className="field-group">
          <label htmlFor="vocabulary"><BookText size={16} /> Personal vocabulary <span>(optional)</span></label>
          <textarea
            id="vocabulary"
            value={vocabulary}
            onChange={(event) => setVocabulary(event.target.value)}
            onBlur={saveVocabulary}
            maxLength={MAX_VOCABULARY_CHARS}
            rows={3}
            placeholder="Names, jargon and abbreviations you use: Aisling, Kubernetes, RabbleBabble, EBITDA"
          />
          <small>
            {vocabulary.length}/{MAX_VOCABULARY_CHARS} - helps transcription get proper nouns right.
          </small>
        </div>

        <div className="setting-row">
          <div>
            <strong>Keep transcripts on this device</strong>
            <span>
              {settings.historyEnabled
                ? "On. The last 20 transcripts are stored on this device only, never synced."
                : "Off. Nothing is kept once you leave the screen."}
            </span>
          </div>
          <button
            type="button"
            className={`toggle${settings.historyEnabled ? " toggle--on" : ""}`}
            role="switch"
            aria-checked={settings.historyEnabled}
            aria-label="Keep transcripts on this device"
            onClick={() => update({ historyEnabled: !settings.historyEnabled })}
          >
            <span />
          </button>
        </div>

        {/* A list, and only a list. The use case is "I copied it, the target app
            crashed, my words are gone" -- if this ever grows search or an
            editing UI it has become a different product. */}
        {settings.historyEnabled && <HistoryList services={services} />}

        {settings.historyEnabled && (
          <div className="danger-zone">
            <div>
              <strong>Clear saved transcripts</strong>
              <span>Removes every transcript stored on this device.</span>
            </div>
            <button type="button" className="danger-button" onClick={() => void services.store.clearTranscripts()}>
              <History size={16} /> Clear history
            </button>
          </div>
        )}

        <div className="model-note"><span>Cleanup model</span><strong>openai/gpt-oss-20b</strong><small>Fixed for v1</small></div>

        {/* Only the API key still needs an explicit commit: a secret should not
            be written to storage halfway through being typed. */}
        {!SERVICE_MODE && (
          <>
            <button className="primary-button" type="submit"><Save size={18} /> {saved ? "Saved" : "Save API key"}</button>
            {saved && <div className="saved-message"><Check size={16} /> Settings saved on this device.</div>}
          </>
        )}
      </form>

      {!SERVICE_MODE && (
        <div className="danger-zone">
          <div><strong>Reset API key</strong><span>Remove the saved key from this device.</span></div>
          <button type="button" className="danger-button" onClick={clear}><Trash2 size={16} /> Clear key</button>
        </div>
      )}
    </main>
  );
}
