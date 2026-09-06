import { Clipboard } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppServices } from "../../app/types";
import type { HistoryEntry } from "../../platform/store/types";

interface HistoryListProps {
  readonly services: AppServices;
}

/**
 * The last few transcripts, on this device only.
 *
 * Deliberately plain: no search, no editing, no infinite scroll. It exists so
 * that "I copied it, the target app crashed, my words are gone" has an answer,
 * and for nothing else.
 */
export function HistoryList({ services }: HistoryListProps) {
  const [entries, setEntries] = useState<readonly HistoryEntry[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void services.store.listTranscripts().then((saved) => {
      if (live) {
        setEntries(saved);
      }
    });
    return () => {
      live = false;
    };
  }, [services.store]);

  if (entries.length === 0) {
    return (
      <p className="history-empty">Transcripts you finish from now on will be listed here.</p>
    );
  }

  return (
    <ul className="history-list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <p>{entry.text}</p>
          <div className="history-list__meta">
            <span>{new Date(entry.createdAt).toLocaleString()}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                void services.clipboard.writeText(entry.text).then(() => setCopied(entry.id));
              }}
            >
              <Clipboard size={14} /> {copied === entry.id ? "Copied" : "Copy"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
