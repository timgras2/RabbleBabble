import { API_BASE_URL, SERVICE_MODE } from "./mode";
import { HttpAuthSession } from "../platform/auth/httpAuthSession";
import { LocalAuthSession } from "../platform/auth/localAuthSession";
import type { AuthSession } from "../platform/auth/types";
import { MediaRecorderAdapter } from "../platform/audio/MediaRecorderAdapter";
import { BrowserClipboard } from "../platform/clipboard/browserClipboard";
import { BackendClient } from "../platform/inference/backendClient";
import { GroqHttpClient } from "../platform/inference/groqClient";
import type { InferenceClient } from "../platform/inference/types";
import { LocalStorageSettings } from "../platform/storage/localStorageSettings";
import { DictationFlowService } from "../services/dictationFlow";
import type { AppServices } from "./types";

export function createAppServices(): AppServices {
  const settings = new LocalStorageSettings();
  const recorder = new MediaRecorderAdapter();
  const clipboard = new BrowserClipboard();

  let session: AuthSession;
  let inference: InferenceClient;

  // A single top-level branch on a `define` constant, so the unused adapter is
  // deleted from the bundle rather than merely unreachable. The hosted build
  // must contain no code path that sends audio to Groq with a user's own key.
  if (SERVICE_MODE) {
    // Any key left over from a bring-your-own-key install is a liability, not
    // just dead data: clear it on the first boot after the cutover.
    if (settings.get().groqApiKey !== "") {
      settings.clearApiKey();
    }
    const httpSession = new HttpAuthSession({ baseUrl: API_BASE_URL });
    session = httpSession;
    inference = new BackendClient({ baseUrl: API_BASE_URL, session: httpSession });
    // Explicit here rather than hidden in a constructor: the composition root
    // is where "start talking to the network" belongs.
    void httpSession.refresh();
  } else {
    session = new LocalAuthSession();
    // The closure is the seam: the adapter reads the current key without ever
    // importing storage, so the boundary rule in architecture.md still holds.
    inference = new GroqHttpClient({ apiKey: () => settings.get().groqApiKey });
  }

  const dictation = new DictationFlowService({ recorder, settings, inference });
  return { settings, recorder, inference, session, clipboard, dictation };
}
