import type { AudioRecorder } from "../platform/audio/types";
import type { ClipboardAdapter } from "../platform/clipboard/types";
import type { GroqClient } from "../platform/inference/types";
import type { SettingsRepository } from "../platform/storage/types";
import type { DictationFlow } from "../services/types";

export interface AppServices {
  readonly settings: SettingsRepository;
  readonly recorder: AudioRecorder;
  readonly groq: GroqClient;
  readonly clipboard: ClipboardAdapter;
  readonly dictation: DictationFlow;
}
