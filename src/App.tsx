import { Mic, Settings2 } from "lucide-react";
import { useState } from "react";
import type { AppServices } from "./app/types";
import { RecorderScreen } from "./ui/RecorderScreen";
import { SettingsScreen } from "./ui/SettingsScreen";

interface AppProps {
  readonly services: AppServices;
}

export function App({ services }: AppProps) {
  const [screen, setScreen] = useState<"recorder" | "settings">("recorder");

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" type="button" onClick={() => setScreen("recorder")} aria-label="Go to recorder">
          <span className="brand-mark"><Mic size={19} /></span>
          <span>Rabble<span>Babble</span></span>
        </button>
        <div className="header-caption">ANDROID PWA <span>•</span> V1</div>
      </header>

      {screen === "recorder" ? <RecorderScreen services={services} onOpenSettings={() => setScreen("settings")} /> : <SettingsScreen services={services} />}

      <nav className="bottom-nav" aria-label="Main navigation">
        <button className={screen === "recorder" ? "nav-item nav-item--active" : "nav-item"} type="button" onClick={() => setScreen("recorder")}><Mic size={19} /><span>Record</span></button>
        <button className={screen === "settings" ? "nav-item nav-item--active" : "nav-item"} type="button" onClick={() => setScreen("settings")}><Settings2 size={19} /><span>Settings</span></button>
      </nav>
    </div>
  );
}
