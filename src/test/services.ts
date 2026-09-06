import type { AppServices } from "../app/types";
import type { AudioRecorder, AudioRecording, RecordingState } from "../platform/audio/types";
import type { AuthSession, AuthState } from "../platform/auth/types";
import type { ClipboardAdapter, ClipboardResult } from "../platform/clipboard/types";
import type { InferenceClient } from "../platform/inference/types";
import { DEFAULT_SETTINGS } from "../platform/storage/localStorageSettings";
import type { Settings, SettingsRepository } from "../platform/storage/types";
import { DictationFlowService } from "../services/dictationFlow";

/**
 * Hand-rolled doubles for the four ports the screens touch, in the same shape
 * the real adapters have. No mocking framework reaches into the composition
 * root: the screens receive an AppServices exactly as they do in main.tsx.
 */

export interface FakeRecorder extends Omit<AudioRecorder, "state" | "startedAt"> {
  /** Publishes a state the way the real adapter does, from the inside. */
  emit(state: RecordingState): void;
  next: AudioRecording;
  state: RecordingState;
  startedAt: number | null;
}

export function fakeRecorder(overrides: Partial<AudioRecorder> = {}): FakeRecorder {
  const listeners = new Set<(state: RecordingState) => void>();
  const recorder: FakeRecorder = {
    state: "idle",
    startedAt: null,
    next: {
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationMs: 1_000,
      endedBy: "user",
    },
    getInputLevel: () => null,
    emit(state) {
      recorder.state = state;
      for (const listener of listeners) listener(state);
    },
    start: async () => {
      recorder.startedAt = Date.now();
      recorder.emit("recording");
    },
    stop: async () => {
      recorder.startedAt = null;
      recorder.emit("idle");
      return recorder.next;
    },
    cancel: async () => {
      recorder.startedAt = null;
      recorder.emit("idle");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => undefined,
    ...overrides,
  };
  return recorder;
}

export function fakeSettings(patch: Partial<Settings> = {}): SettingsRepository {
  let value: Settings = { ...DEFAULT_SETTINGS, ...patch };
  const listeners = new Set<(settings: Settings) => void>();
  const notify = () => {
    for (const listener of listeners) listener(value);
  };
  return {
    get: () => value,
    update: (change) => {
      value = { ...value, ...change };
      notify();
      return value;
    },
    clearApiKey: () => {
      value = { ...value, groqApiKey: "" };
      notify();
      return value;
    },
    reset: () => {
      value = { ...DEFAULT_SETTINGS };
      notify();
      return value;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const SIGNED_IN: AuthState = {
  status: "signed-in",
  account: { email: "user@example.com" },
  quota: null,
  checking: false,
  error: null,
};

export function fakeSession(state: AuthState = SIGNED_IN): AuthSession {
  return {
    get: () => state,
    refresh: async () => state,
    requireSignedIn: () => undefined,
    requestMagicLink: async () => undefined,
    signOut: async () => undefined,
    markSignedOut: () => undefined,
    updateQuota: () => undefined,
    subscribe: () => () => undefined,
  };
}

export function fakeClipboard(result: ClipboardResult = { status: "copied" }): ClipboardAdapter {
  return { writeText: async () => result };
}

export function fakeInference(overrides: Partial<InferenceClient> = {}): InferenceClient {
  return {
    checkReady: () => undefined,
    transcribe: async () => ({ text: "hello world" }),
    cleanup: async () => ({ text: "Hello, world." }),
    rewrite: async () => ({ text: "Rewritten." }),
    ...overrides,
  };
}

export interface TestServices extends AppServices {
  readonly recorder: FakeRecorder;
}

export function testServices(parts: {
  readonly recorder?: FakeRecorder;
  readonly inference?: InferenceClient;
  readonly settings?: SettingsRepository;
  readonly session?: AuthSession;
  readonly clipboard?: ClipboardAdapter;
} = {}): TestServices {
  const recorder = parts.recorder ?? fakeRecorder();
  const settings = parts.settings ?? fakeSettings({ cleanupEnabled: false });
  const inference = parts.inference ?? fakeInference();
  return {
    recorder,
    settings,
    inference,
    session: parts.session ?? fakeSession(),
    clipboard: parts.clipboard ?? fakeClipboard(),
    dictation: new DictationFlowService({ recorder, settings, inference }),
  };
}
