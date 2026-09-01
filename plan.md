# RabbleBabble Android PWA v1 Plan

## Goal

Build the smallest useful version of RabbleBabble as an installable Android PWA for one
trusted user per device.

The app will:

1. Ask for microphone permission.
2. Record audio with one Start/Stop button.
3. Send the recording to Groq Whisper.
4. Optionally send the transcript to the pinned Groq cleanup model.
5. Show the final text.
6. Let the user explicitly copy the text.

The app will be deployed as a static HTTPS site and installed from Android Chrome.

## V1 Decisions

- **Platform:** Android 10+ with current Android Chrome and the installed PWA only.
- **Inference:** Groq Cloud only.
- **Models:** `whisper-large-v3-turbo` for transcription and
  `llama-3.1-8b-instant` for cleanup. The cleanup model is a code constant in v1, not
  free-form user input. Verify it against Groq's supported-models page before release.
- **API key:** entered once on the device and stored in browser `localStorage`.
- **Settings:** localStorage only. There is not enough data to justify IndexedDB.
- **History:** not included. The last result remains visible until the next recording.
  V1 assumes one trusted user per device; do not add multi-user privacy behavior.
- **Users:** one trusted user per device; no accounts, profiles, login, or synchronization.
- **Clipboard:** explicit Copy action only. No automatic paste is possible from a PWA.
- **Offline behavior:** show an error. Do not queue recordings.
- **Local inference:** not included and not probed.
- **Fallbacks:** no local fallback. Transcription failure is surfaced clearly; cleanup
  failure falls back to the raw transcript.
- **Audio:** upload the native Android `MediaRecorder` blob. Do not decode, resample, or
  convert to WAV in v1. Reject recordings over 5 minutes or 25 MB before upload.
- **Screen behavior:** request an Android screen wake lock while recording when supported,
  reacquire it after visibility changes when possible, and release it on stop, cancel,
  error, or unmount.
- **Desktop/Electron:** not supported by v1 and removed from the active build.
- **Native Android:** not used by v1. No Kotlin or native Android project is part of this
  repository.

## Why This Is Simpler

- No backend, database, authentication, synchronization, or model downloads.
- No Electron IPC, Python, FFmpeg, native processes, or Gradle build.
- No generic provider router or capability framework.
- One browser recording adapter, one settings adapter, one clipboard adapter, and one
  Groq client.
- The React UI is built around three small screens/components.

## Security Boundary

The Groq key is visible to JavaScript in the browser and is not secure against browser
extensions or anyone with access to the device. This is accepted only because v1 is for
one trusted user per device.

The key must never be committed, placed in Vite environment variables, or logged.
Settings must include a **Clear API Key** action so the device can be reset.

If the app becomes public, add a backend proxy before adding accounts or synchronization.
Do not add that backend to v1.

## Runtime and Deployment

- Vite's root remains `src/`. `src/index.html` loads `src/main.tsx`; `main.jsx` is
  replaced, not run in parallel. Build and preview commands continue to run from `src/`.
- Production deployment is GitHub Pages at
  `https://timgras2.github.io/RabbleBabble/`. The relative Vite base must work under the
  `/RabbleBabble/` path.
- Android LAN development uses an HTTPS Vite server at
  `https://<LAN-IP>:5174/`, using `vite-plugin-basic-ssl` or a locally trusted mkcert
  certificate. Plain HTTP LAN testing is not an accepted microphone test.
- The PWA service worker precaches only the shell and icons. Groq requests are
  network-only and never enter Cache Storage.

## Delivery Order

1. Prove direct Groq browser multipart and chat requests work from the selected HTTPS
   host with a test key, then discard the key.
2. Add TypeScript contracts.
3. Implement native recording, settings, clipboard, and Groq adapters.
4. Implement the dictation flow.
5. Build the minimal recorder and settings UI.
6. Add PWA manifest, icons, and service worker through Vite.
7. Install and test on the target Android phone.

The exact sequence is in `task_list.md`. Each implementation task is intentionally small
and should touch no more than two files.

## Completion Criteria

- `npm run build` produces a static PWA.
- The PWA installs from Android Chrome over HTTPS.
- A user can enter, clear, and reuse the Groq API key.
- Start/Stop records audio and releases the microphone afterward.
- Recording is capped at 5 minutes and 25 MB; no oversized recording is uploaded.
- Groq transcription works with `whisper-large-v3-turbo`.
- Cleanup can be disabled and cleanup failures preserve the raw transcript.
- Copy works from an explicit button press.
- No audio, transcript, API key, or API response is cached by the service worker.
- Offline, missing-key, permission, timeout, and API errors are visible and actionable.
- Repeated Start/Stop actions are safe, and Cancel aborts an in-flight request without
  leaving the flow busy.
- The screen wake lock, when available, is released on every recording exit path.
- MIME negotiation, recording states, settings persistence, Groq HTTP behavior, and flow
  fallback behavior pass automated boundary tests.
- No production code imports Electron APIs or Kotlin/Android code.

## Deferred Work

Do not implement these during v1:

- History or IndexedDB
- Accounts or cross-device sync
- Backend proxy
- Multiple providers
- Local Whisper, WebGPU, or WASM
- Desktop support, global hotkeys, tray, or automatic paste
- iOS testing
