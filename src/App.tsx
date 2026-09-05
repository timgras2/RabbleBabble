import { ArrowLeft, Mic, Settings2 } from "lucide-react";
import { useState } from "react";
import type { AppServices } from "./app/types";
import { RecorderScreen } from "./ui/RecorderScreen";
import { SettingsScreen } from "./ui/SettingsScreen";

interface AppProps {
  readonly services: AppServices;
}

export function App({ services }: AppProps) {
  const [screen, setScreen] = useState<"recorder" | "settings">("recorder");
  const onSettings = screen === "settings";

  return (
    <div className={`app-shell${onSettings ? " app-shell--scroll" : ""}`}>
      <header className="app-header">
        {onSettings ? (
          <div className="header-left">
            <button className="icon-button" type="button" onClick={() => setScreen("recorder")} aria-label="Back to recorder">
              <ArrowLeft size={20} />
            </button>
            <span className="header-title">Settings</span>
          </div>
        ) : (
          <span className="brand">
            <span className="brand-mark"><Mic size={19} /></span>
            <span>Rabble<span>Babble</span></span>
          </span>
        )}
        {!onSettings && (
          <button className="icon-button" type="button" onClick={() => setScreen("settings")} aria-label="Open settings">
            <Settings2 size={20} />
          </button>
        )}
      </header>

      {onSettings ? (
        <SettingsScreen services={services} />
      ) : (
        <RecorderScreen services={services} onOpenSettings={() => setScreen("settings")} />
      )}
    </div>
  );
}
