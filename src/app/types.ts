import type { AuthSession } from "../platform/auth/types";
import type { AudioRecorder } from "../platform/audio/types";
import type { ClipboardAdapter } from "../platform/clipboard/types";
import type { InferenceClient } from "../platform/inference/types";
import type { SettingsRepository } from "../platform/storage/types";
import type { LocalStore } from "../platform/store/types";
import type { DictationFlow } from "../services/types";

export interface AppServices {
  readonly settings: SettingsRepository;
  readonly recorder: AudioRecorder;
  readonly inference: InferenceClient;
  readonly session: AuthSession;
  readonly clipboard: ClipboardAdapter;
  readonly dictation: DictationFlow;
  readonly store: LocalStore;
}
