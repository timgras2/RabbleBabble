import { LogOut, UserRound } from "lucide-react";
import type { AppServices } from "../../app/types";
import { useAuthSession } from "../../hooks/useAuthSession";

interface AccountPanelProps {
  readonly services: AppServices;
}

export function AccountPanel({ services }: AccountPanelProps) {
  const auth = useAuthSession(services);
  const quota = auth.quota;

  return (
    <>
      <div className="field-group">
        <label htmlFor="account-email">Signed in as</label>
        <div className="input-wrap">
          <UserRound size={18} />
          <input id="account-email" type="text" value={auth.account?.email ?? "—"} readOnly />
        </div>
      </div>

      <div className="model-note">
        <span>Today&rsquo;s usage</span>
        <strong>{quota === null ? "—" : `${minutes(quota.audioSecondsUsed)} of ${minutes(quota.audioSecondsLimit)} minutes`}</strong>
        <small>
          {quota === null
            ? "Usage appears after your first dictation."
            : `${quota.chatCallsUsed} of ${quota.chatCallsLimit} cleanups and rewrites · resets ${resetsAt(quota.resetsAtEpochSeconds)}`}
        </small>
      </div>

      <div className="danger-zone">
        <div>
          <strong>Sign out</strong>
          <span>Ends the session on this device.</span>
        </div>
        <button type="button" className="danger-button" onClick={() => void auth.signOut()}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </>
  );
}

function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

function resetsAt(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
