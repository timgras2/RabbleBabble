import { Check, Eye, EyeOff, KeyRound, Languages, Save, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { AppServices } from "../app/types";
import { useSettings } from "../hooks/useSettings";

interface SettingsScreenProps {
  readonly services: AppServices;
}

export function SettingsScreen({ services }: SettingsScreenProps) {
  const { settings, update, clearApiKey } = useSettings(services);
  const [apiKey, setApiKey] = useState(settings.groqApiKey);
  const [cleanupEnabled, setCleanupEnabled] = useState(settings.cleanupEnabled);
  const [language, setLanguage] = useState(settings.language);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(timer);
  }, [saved]);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    update({ groqApiKey: apiKey.trim(), cleanupEnabled, language: language.trim() });
    setSaved(true);
  };

  const clear = () => {
    clearApiKey();
    setApiKey("");
    setSaved(false);
  };

  return (
    <main className="screen settings-screen">
      <section className="settings-heading">
        <p>These settings stay on this device. Your key is used directly by your browser to reach Groq.</p>
      </section>

      <form className="settings-form" onSubmit={save}>
        <div className="field-group">
          <label htmlFor="groq-key">Groq API key</label>
          <div className="input-wrap">
            <KeyRound size={18} />
            <input id="groq-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="gsk_..." autoComplete="off" />
            <button type="button" className="input-action" aria-label={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </div>
          <small>Stored in localStorage for this trusted device. Never commit or share it.</small>
        </div>

        <div className="setting-row">
          <div><strong>Clean up transcripts</strong><span>Fix grammar and punctuation after transcription.</span></div>
          <button type="button" className={`toggle${cleanupEnabled ? " toggle--on" : ""}`} role="switch" aria-checked={cleanupEnabled} aria-label="Clean up transcripts" onClick={() => setCleanupEnabled(!cleanupEnabled)}><span /></button>
        </div>

        <div className="field-group">
          <label htmlFor="language"><Languages size={16} /> Language hint <span>(optional)</span></label>
          <input id="language" type="text" value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="en" maxLength={16} />
          <small>Leave blank to let Whisper detect the language.</small>
        </div>

        <div className="model-note"><span>Cleanup model</span><strong>openai/gpt-oss-20b</strong><small>Fixed for v1</small></div>

        <button className="primary-button" type="submit"><Save size={18} /> {saved ? "Saved" : "Save settings"}</button>
        {saved && <div className="saved-message" role="status"><Check size={16} /> Settings saved on this device.</div>}
      </form>

      <div className="danger-zone">
        <div><strong>Reset API key</strong><span>Remove the saved key from this device.</span></div>
        <button type="button" className="danger-button" onClick={clear}><Trash2 size={16} /> Clear key</button>
      </div>
    </main>
  );
}
