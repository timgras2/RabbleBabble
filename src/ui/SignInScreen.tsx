import { AlertCircle, Mail, Send, Ticket } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { AppServices } from "../app/types";
import { useAuthSession } from "../hooks/useAuthSession";
import { AdapterError } from "../platform/errors";
import { messageForError } from "./errorMessages";
import { useScreenFocus } from "../hooks/useScreenFocus";

interface SignInScreenProps {
  readonly services: AppServices;
  /** True when a navigation brought this screen here, so it takes focus. */
  readonly focusOnMount?: boolean;
}

type Stage = "form" | "sending" | "sent";

const RESEND_COOLDOWN_SECONDS = 60;

export function SignInScreen({ services, focusOnMount = false }: SignInScreenProps) {
  const screenRef = useScreenFocus(focusOnMount);
  const auth = useAuthSession(services);
  const [email, setEmail] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState<AdapterError | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim()) return;

    setStage("sending");
    setError(null);
    try {
      await auth.requestMagicLink({
        email: email.trim(),
        ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
      });
      setStage("sent");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (caught) {
      setError(caught instanceof AdapterError ? caught : null);
      setStage("form");
    }
  };

  // Not a sign-in failure, and it must not look like one: the user cannot fix
  // a dead connection by typing their address again.
  if (auth.status === "unknown" && auth.error !== null) {
    const message = messageForError(auth.error);
    return (
      <main className="screen signin-screen" ref={screenRef} tabIndex={-1}>
        <h1 className="visually-hidden">Sign in to RabbleBabble</h1>
        <div className="notice notice--error" role="alert">
          <AlertCircle size={19} />
          <div>
            <strong>{message.title}</strong>
            <span>{message.detail}</span>
          </div>
        </div>
        <button className="primary-button" type="button" onClick={() => void auth.refresh()}>
          Try again
        </button>
      </main>
    );
  }

  if (stage === "sent") {
    return (
      <main className="screen signin-screen" ref={screenRef} tabIndex={-1}>
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          Check your email for a sign-in link.
        </div>
        <section className="signin-sent">
          <h1>Check your email</h1>
          <p>
            We sent a sign-in link to <strong>{email.trim()}</strong>. Opening it signs you in on this device. It
            works once and expires in 15 minutes.
          </p>
        </section>
        <button
          className="primary-button"
          type="button"
          disabled={cooldown > 0}
          onClick={() => setStage("form")}
        >
          {cooldown > 0 ? `Send again in ${cooldown}s` : "Send another link"}
        </button>
        <button className="text-button" type="button" onClick={() => { setStage("form"); setEmail(""); }}>
          Use a different address
        </button>
      </main>
    );
  }

  const message = error === null ? null : messageForError(error);

  return (
    <main className="screen signin-screen" ref={screenRef} tabIndex={-1}>
      <section className="settings-heading">
        <h1>Sign in to RabbleBabble</h1>
        <p>We email you a link. There is no password to remember, and no API key to set up.</p>
      </section>

      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        {message !== null && (
          <div className="notice notice--error" role="alert">
            <AlertCircle size={19} />
            <div>
              <strong>{message.title}</strong>
              <span>{message.detail}</span>
            </div>
          </div>
        )}

        <div className="field-group">
          <label htmlFor="signin-email">Email address</label>
          <div className="input-wrap">
            <Mail size={18} />
            <input
              id="signin-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </div>
        </div>

        <div className="field-group">
          <label htmlFor="signin-invite">
            Invite code <span>(if you have one)</span>
          </label>
          <div className="input-wrap">
            <Ticket size={18} />
            <input
              id="signin-invite"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              placeholder="XXXX-XXXX-XXXX"
            />
          </div>
          <small>Needed the first time, while RabbleBabble is invite-only.</small>
        </div>

        <button className="primary-button" type="submit" disabled={stage === "sending"}>
          <Send size={18} /> {stage === "sending" ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>
    </main>
  );
}
