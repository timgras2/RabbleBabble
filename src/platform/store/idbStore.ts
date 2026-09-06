import type { AudioRecording } from "../audio/types";
import type { BufferedRecording, HistoryEntry, LocalStore } from "./types";

const DATABASE = "rabblebabble";
const VERSION = 1;
const RECORDINGS = "recordings";
const TRANSCRIPTS = "transcripts";

/** Three recordings and 24 hours. A buffer, deliberately small. */
const MAX_BUFFERED_RECORDINGS = 3;
const MAX_BUFFER_AGE_MS = 24 * 60 * 60 * 1_000;

/** Opt-in history is capped too: this is a safety net, not a feed. */
const MAX_TRANSCRIPTS = 20;

interface RecordingRecord {
  id: string;
  createdAt: number;
  mimeType: string;
  chunks: Blob[];
}

/**
 * IndexedDB rather than localStorage, because these are Blobs and because
 * localStorage is synchronous on the main thread.
 *
 * Every method resolves rather than rejects when the platform refuses -- a
 * private window, a storage quota, a browser with IndexedDB switched off.
 * Buffering is what makes a lost upload recoverable; failing to buffer must
 * never be what stops a recording.
 */
export class IdbStore implements LocalStore {
  private opening: Promise<IDBDatabase | null> | null = null;
  /** Writes are chained, so chunks land in order without a queue per caller. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, RecordingRecord>();

  open(recordingId: string, mimeType: string): void {
    this.pending.set(recordingId, { id: recordingId, createdAt: Date.now(), mimeType, chunks: [] });
  }

  write(recordingId: string, chunk: Blob): void {
    const record = this.pending.get(recordingId);
    if (record === undefined) {
      return;
    }
    record.chunks.push(chunk);
    // Rewritten whole rather than appended to: at most 30 ten-second chunks is
    // cheap, and one record per recording means a half-written recording can
    // never be a half-written row.
    void this.enqueue(() => this.put({ ...record, chunks: [...record.chunks] }));
  }

  close(recordingId: string): void {
    const record = this.pending.get(recordingId);
    this.pending.delete(recordingId);
    if (record !== undefined) {
      void this.enqueue(() => this.put({ ...record, chunks: [...record.chunks] }));
    }
  }

  async listRecordings(): Promise<readonly BufferedRecording[]> {
    const records = await this.allRecordings();
    return records.map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      mimeType: record.mimeType,
      bytes: record.chunks.reduce((total, chunk) => total + chunk.size, 0),
    }));
  }

  async loadRecording(id: string): Promise<AudioRecording | null> {
    const database = await this.database();
    if (database === null) {
      return null;
    }
    const record = await request<RecordingRecord | undefined>(
      database.transaction(RECORDINGS, "readonly").objectStore(RECORDINGS).get(id),
    ).catch(() => undefined);
    if (record === undefined || record.chunks.length === 0) {
      return null;
    }
    return {
      blob: new Blob(record.chunks, { type: record.mimeType }),
      mimeType: record.mimeType,
      // Zero on purpose for a recovered recording: the clock that knew the
      // real duration died with the page, and the server meters the truth.
      durationMs: 0,
      endedBy: "interrupted",
      id: record.id,
    };
  }

  async dropRecording(id: string): Promise<void> {
    this.pending.delete(id);
    await this.enqueue(async () => {
      const database = await this.database();
      if (database === null) {
        return;
      }
      await request(database.transaction(RECORDINGS, "readwrite").objectStore(RECORDINGS).delete(id));
    });
  }

  async saveTranscript(text: string): Promise<void> {
    await this.enqueue(async () => {
      const database = await this.database();
      if (database === null) {
        return;
      }
      const entry: HistoryEntry = { id: crypto.randomUUID(), createdAt: Date.now(), text };
      await request(database.transaction(TRANSCRIPTS, "readwrite").objectStore(TRANSCRIPTS).put(entry));
    });
    await this.trimTranscripts();
  }

  async listTranscripts(): Promise<readonly HistoryEntry[]> {
    const database = await this.database();
    if (database === null) {
      return [];
    }
    const entries = await request<HistoryEntry[]>(
      database.transaction(TRANSCRIPTS, "readonly").objectStore(TRANSCRIPTS).getAll(),
    ).catch(() => []);
    return [...entries].sort((a, b) => b.createdAt - a.createdAt);
  }

  async clearTranscripts(): Promise<void> {
    const database = await this.database();
    if (database === null) {
      return;
    }
    await request(database.transaction(TRANSCRIPTS, "readwrite").objectStore(TRANSCRIPTS).clear()).catch(
      () => undefined,
    );
  }

  async sweep(nowMs: number): Promise<void> {
    const records = await this.allRecordings();
    const doomed = [...records]
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter(
        (record, index) => index >= MAX_BUFFERED_RECORDINGS || nowMs - record.createdAt > MAX_BUFFER_AGE_MS,
      );
    for (const record of doomed) {
      await this.dropRecording(record.id);
    }
  }

  private async trimTranscripts(): Promise<void> {
    const entries = await this.listTranscripts();
    const database = await this.database();
    if (database === null) {
      return;
    }
    for (const entry of entries.slice(MAX_TRANSCRIPTS)) {
      await request(
        database.transaction(TRANSCRIPTS, "readwrite").objectStore(TRANSCRIPTS).delete(entry.id),
      ).catch(() => undefined);
    }
  }

  private async allRecordings(): Promise<RecordingRecord[]> {
    const database = await this.database();
    if (database === null) {
      return [];
    }
    return request<RecordingRecord[]>(
      database.transaction(RECORDINGS, "readonly").objectStore(RECORDINGS).getAll(),
    ).catch(() => []);
  }

  private async put(record: RecordingRecord): Promise<void> {
    const database = await this.database();
    if (database === null) {
      return;
    }
    await request(database.transaction(RECORDINGS, "readwrite").objectStore(RECORDINGS).put(record)).catch(
      () => undefined,
    );
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T | undefined> {
    const next = this.tail.then(work, work).catch(() => undefined);
    this.tail = next;
    return next;
  }

  private database(): Promise<IDBDatabase | null> {
    this.opening ??= openDatabase();
    return this.opening;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise<IDBDatabase | null>((resolve) => {
    let opening: IDBOpenDBRequest;
    try {
      opening = indexedDB.open(DATABASE, VERSION);
    } catch {
      resolve(null);
      return;
    }
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(RECORDINGS)) {
        database.createObjectStore(RECORDINGS, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(TRANSCRIPTS)) {
        database.createObjectStore(TRANSCRIPTS, { keyPath: "id" });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => resolve(null);
    opening.onblocked = () => resolve(null);
  });
}

/**
 * IndexedDB's own types resolve to `any`, so the caller states what the store
 * holds. Every record here was written by this class, so the assertion is a
 * statement about our own schema rather than about untrusted input.
 */
function request<T>(operation: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result as T);
    operation.onerror = () => reject(operation.error ?? new Error("IndexedDB request failed"));
  });
}
