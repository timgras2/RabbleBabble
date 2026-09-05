import { ArrowLeft, Settings2 } from "lucide-react";
import { useState } from "react";
import { SERVICE_MODE } from "./app/mode";
import type { AppServices } from "./app/types";
import { useAuthSession, useHasTranscript } from "./hooks/useAuthSession";
import { WaveMark } from "./ui/components/WaveMark";
import { RecorderScreen } from "./ui/RecorderScreen";
import { SettingsScreen } from "./ui/SettingsScreen";
import { SignInScreen } from "./ui/SignInScreen";

interface AppProps {
  readonly services: AppServices;
}

type Screen = "recorder" | "settings" | "sign-in";

export function App({ services }: AppProps) {
  const [screen, setScreen] = useState<Screen>("recorder");
  const auth = useAuthSession(services);
  const hasTranscript = useHasTranscript(services);

  // SERVICE_MODE is a build-time constant, so the whole branch disappears from
  // the bring-your-own-key bundle.
  if (SERVICE_MODE && auth.status === "unknown" && auth.error === null) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <span className="brand">
            <span className="brand-mark"><WaveMark size={19} /></span>
            <span>Rabble<span>Babble</span></span>
          </span>
        </header>
        <main className="screen" role="status">
          <p>Checking your session…</p>
        </main>
      </div>
    );
  }

  // A session that expires while a transcript is on screen must not take the
  // screen away: the user has words they have not copied yet. They get an
  // actionable error on the recorder instead.
  const signedOut = SERVICE_MODE && auth.status !== "signed-in";
  const current: Screen = signedOut && !hasTranscript ? "sign-in" : screen;

  const onSettings = current === "settings";
  const onSignIn = current === "sign-in";

  return (
    <div className={`app-shell${onSettings || onSignIn ? " app-shell--scroll" : ""}`}>
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
            <span className="brand-mark"><WaveMark size={19} /></span>
            <span>Rabble<span>Babble</span></span>
          </span>
        )}
        {current === "recorder" && (
          <button className="icon-button" type="button" onClick={() => setScreen("settings")} aria-label="Open settings">
            <Settings2 size={20} />
          </button>
        )}
      </header>

      {current === "settings" ? (
        <SettingsScreen services={services} />
      ) : SERVICE_MODE && current === "sign-in" ? (
        <SignInScreen services={services} />
      ) : (
        <RecorderScreen
          services={services}
          onOpenSettings={() => setScreen("settings")}
          onSignIn={() => setScreen("sign-in")}
        />
      )}
    </div>
  );
}
