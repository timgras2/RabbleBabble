import { Check, Eye, EyeOff, KeyRound, Languages, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { SERVICE_MODE } from "../app/mode";
import type { AppServices } from "../app/types";
import { useSettings } from "../hooks/useSettings";
import { AccountPanel } from "./settings/AccountPanel";

interface SettingsScreenProps {
  readonly services: AppServices;
  readonly focusRef?: Ref<HTMLElement>;
}

const LANGUAGE_SAVE_DELAY_MS = 600;

export function SettingsScreen({ services, focusRef }: SettingsScreenProps) {
  const { settings, update, clearApiKey } = useSettings(services);
  const [apiKey, setApiKey] = useState(settings.groqApiKey);
  const [language, setLanguage] = useState(settings.language);
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
            ? "Audio is sent to RabbleBabble, transcribed, and never stored. Preferences stay on this device."
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
