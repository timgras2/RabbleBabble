import { ArrowLeft, Settings2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { SERVICE_MODE } from "./app/mode";
import type { AppServices } from "./app/types";
import { useAuthSession, useHasTranscript } from "./hooks/useAuthSession";
import { useDictation } from "./hooks/useDictation";
import { useUpdatePrompt } from "./hooks/useUpdatePrompt";
import { WaveMark } from "./ui/components/WaveMark";
import { RecorderScreen } from "./ui/RecorderScreen";
// Eager, deliberately. A lazy() emits its chunk unconditionally -- Rollup will
// not remove a dynamic import that sits in a folded branch -- so lazy-loading
// this one put the sign-in screen in the bring-your-own-key bundle, which
// check-build-mode.mjs correctly refused. Static imports still tree-shake, so
// this costs the BYOK build nothing and the service build ~4 kB.
import { SignInScreen } from "./ui/SignInScreen";

// First paint is the recorder, always. Settings is a tap away at the earliest,
// and does not belong in the bytes that stand between opening the app and
// being able to talk into it.
const SettingsScreen = lazy(async () => ({ default: (await import("./ui/SettingsScreen")).SettingsScreen }));

interface AppProps {
  readonly services: AppServices;
}

type Screen = "recorder" | "settings" | "sign-in";

export function App({ services }: AppProps) {
  const [screen, setScreen] = useState<Screen>("recorder");
  const auth = useAuthSession(services);
  const hasTranscript = useHasTranscript(services);
  const dictation = useDictation(services);
  // Reloading now would destroy either the recording in progress or the words
  // on screen, so the waiting worker keeps waiting and the offer comes back.
  const update = useUpdatePrompt(!hasTranscript && dictation.state === "idle");

  // A session that expires while a transcript is on screen must not take the
  // screen away: the user has words they have not copied yet. They get an
  // actionable error on the recorder instead.
  const signedOut = SERVICE_MODE && auth.status !== "signed-in";
  const current: Screen = signedOut && !hasTranscript ? "sign-in" : screen;

  // Swapping the whole <main> without moving focus leaves a screen-reader user
  // and a keyboard user on a button that no longer exists, with nothing said
  // about where they now are.
  //
  // The screen focuses itself rather than App focusing a ref: Settings is a
  // lazy chunk, so it is not mounted yet when a route-change effect here would
  // run, and the ref would be null. Only ever true after a real navigation --
  // grabbing focus on first paint would be its own small rudeness.
  const [navigated, setNavigated] = useState(false);
  const go = (next: Screen) => {
    setNavigated(true);
    setScreen(next);
  };

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

  const onSettings = current === "settings";
  const onSignIn = current === "sign-in";

  return (
    <div className={`app-shell${onSettings || onSignIn ? " app-shell--scroll" : ""}`}>
      <header className="app-header">
        {onSettings ? (
          <div className="header-left">
            <button className="icon-button" type="button" onClick={() => go("recorder")} aria-label="Back to recorder">
              <ArrowLeft size={20} />
            </button>
            <span className="header-title" aria-hidden="true">Settings</span>
          </div>
        ) : (
          <span className="brand">
            <span className="brand-mark"><WaveMark size={19} /></span>
            <span>Rabble<span>Babble</span></span>
          </span>
        )}
        {current === "recorder" && (
          <button className="icon-button" type="button" onClick={() => go("settings")} aria-label="Open settings">
            <Settings2 size={20} />
          </button>
        )}
      </header>

      {update.offer && (
        <div className="update-banner">
          <span>A new version is ready.</span>
          <button type="button" className="text-button" onClick={update.apply}>Reload</button>
        </div>
      )}

      <Suspense fallback={<main className="screen" />}>
        {current === "settings" ? (
          <SettingsScreen services={services} focusOnMount={navigated} />
        ) : SERVICE_MODE && current === "sign-in" ? (
          <SignInScreen services={services} focusOnMount={navigated} />
        ) : (
          <RecorderScreen
            services={services}
            focusOnMount={navigated}
            onOpenSettings={() => go("settings")}
            onSignIn={() => go("sign-in")}
          />
        )}
      </Suspense>
    </div>
  );
}
