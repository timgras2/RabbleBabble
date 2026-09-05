import { MediaRecorderAdapter } from "../platform/audio/MediaRecorderAdapter";
import { BrowserClipboard } from "../platform/clipboard/browserClipboard";
import { GroqHttpClient } from "../platform/inference/groqClient";
import { LocalStorageSettings } from "../platform/storage/localStorageSettings";
import { DictationFlowService } from "../services/dictationFlow";
import type { AppServices } from "./types";

export function createAppServices(): AppServices {
  const settings = new LocalStorageSettings();
  const recorder = new MediaRecorderAdapter();
  // The closure is the seam: the adapter reads the current key without ever
  // importing storage, so the boundary rule in architecture.md still holds.
  const inference = new GroqHttpClient({ apiKey: () => settings.get().groqApiKey });
  const clipboard = new BrowserClipboard();
  const dictation = new DictationFlowService({ recorder, settings, inference });
  return { settings, recorder, inference, clipboard, dictation };
}
