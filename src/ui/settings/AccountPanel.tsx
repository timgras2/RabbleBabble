import { LogOut, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AppServices } from "../../app/types";
import { useAuthSession } from "../../hooks/useAuthSession";
import { UserRound } from "lucide-react";

interface AccountPanelProps {
  readonly services: AppServices;
}

export function AccountPanel({ services }: AccountPanelProps) {
  const auth = useAuthSession(services);
  const quota = auth.quota;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

      <div className="danger-zone">
        <div>
          <strong>Sign out everywhere</strong>
          <span>Ends every session for this account, on every device.</span>
        </div>
        <button type="button" className="danger-button" onClick={() => void auth.signOut({ allDevices: true })}>
          <LogOut size={16} /> Sign out everywhere
        </button>
      </div>

      {/* Two taps, and the second one says what it destroys. Erasure removes
          the account, its sessions and its usage counters; it cannot reach
          Cloudflare's own platform logs, which carry the client IP unpeppered. */}
      <div className="danger-zone">
        <div>
          <strong>Delete account</strong>
          <span>
            {confirmingDelete
              ? "This erases your account, your sessions and your usage history. It cannot be undone."
              : "Permanently erases your account and everything stored about it."}
          </span>
        </div>
        {confirmingDelete ? (
          <div className="danger-zone__confirm">
            <button type="button" className="danger-button" onClick={() => void auth.deleteAccount()}>
              <Trash2 size={16} /> Delete permanently
            </button>
            <button type="button" className="text-button" onClick={() => setConfirmingDelete(false)}>
              Keep my account
            </button>
          </div>
        ) : (
          <button type="button" className="danger-button" onClick={() => setConfirmingDelete(true)}>
            <Trash2 size={16} /> Delete account
          </button>
        )}
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
