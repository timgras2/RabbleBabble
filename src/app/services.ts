import { MediaRecorderAdapter } from "../platform/audio/MediaRecorderAdapter";
import { BrowserClipboard } from "../platform/clipboard/browserClipboard";
import { GroqHttpClient } from "../platform/inference/groqClient";
import { LocalStorageSettings } from "../platform/storage/localStorageSettings";
import { DictationFlowService } from "../services/dictationFlow";
import type { AppServices } from "./types";

export function createAppServices(): AppServices {
  const settings = new LocalStorageSettings();
  const recorder = new MediaRecorderAdapter();
  const groq = new GroqHttpClient();
  const clipboard = new BrowserClipboard();
  const dictation = new DictationFlowService({ recorder, settings, groq });
  return { settings, recorder, groq, clipboard, dictation };
}
