# RabbleBabble Android PWA v1 Task List

> Execute sequentially. Read `plan.md` and `architecture.md` before every task.
> Each implementation task edits no more than two files. Do not add features outside
> the v1 scope. Contracts in `architecture.md` are normative.

## Phase 0 — Prove the Chosen Runtime

- [ ] **V1-01 — Verify Groq browser access**
  - Files: none
  - From the selected HTTPS host, manually verify one multipart transcription request
    with `whisper-large-v3-turbo` and one chat request with `llama-3.1-8b-instant` reach
    Groq using a temporary test key. Confirm CORS and that both model IDs are accepted,
    then discard the key. If CORS fails or a model is unavailable, stop and revise the
    decision before implementing adapters; do not hide the problem in application code.

- [ ] **V1-02 — Record the Android target**
  - Files: `plan.md`, `README.md`
  - Document Android 10+, current Android Chrome, the GitHub Pages URL
    `https://timgras2.github.io/RabbleBabble/`, and the HTTPS LAN development URL shape
    `https://<LAN-IP>:5174/`. Do not document desktop or iOS support as v1 behavior.

## Phase 1 — Contracts and Tooling

- [ ] **V1-03 — Add shared platform contracts**
  - Files: `src/platform/types.ts`, `src/platform/errors.ts`
  - Implement exactly `Unsubscribe`, `AdapterErrorCode`, `AdapterErrorOptions`, and
    `AdapterError` from `architecture.md` §4.1.

- [ ] **V1-04 — Add audio contracts**
  - Files: `src/platform/audio/types.ts`, `src/platform/audio/index.ts`
  - Export exactly `RecordingState`, `AudioRecording`, `AudioRecorderOptions`, and
    `AudioRecorder` from `architecture.md` §4.2. Include the duration and byte-limit
    options. Do not add an audio normalizer contract.

- [ ] **V1-05 — Add storage and clipboard contracts**
  - Files: `src/platform/storage/types.ts`, `src/platform/clipboard/types.ts`
  - Export exactly the settings and clipboard interfaces from `architecture.md` §4.3
    and §4.4. No IndexedDB types, history types, or read-clipboard method.

- [ ] **V1-06 — Add inference and flow contracts**
  - Files: `src/platform/inference/types.ts`, `src/services/types.ts`
  - Export exactly `GroqClient`, `GroqClientOptions`, response types, and
    `DictationFlow` types from `architecture.md` §4.5 and §4.6.

- [ ] **V1-07 — Add TypeScript checking**
  - Files: `tsconfig.json`, `package.json`
  - Add TypeScript and Vitest tooling, plus `typecheck` and `test` scripts. Do not add
    Electron, Gradle, IndexedDB, WebGPU, or WASM dependencies.

## Phase 2 — Browser Adapters

- [ ] **V1-08 — Implement MIME negotiation**
  - Files: `src/platform/audio/mimeNegotiation.ts`
  - Export `negotiateMimeType(preferred?: readonly string[]): string`. Try supported
    Android-friendly types in order: `audio/webm;codecs=opus`, `audio/webm`,
    `audio/mp4`, then `""` for browser default.

- [ ] **V1-09 — Implement Android browser recording**
  - Files: `src/platform/audio/MediaRecorderAdapter.ts`
  - Implement `AudioRecorder` from §4.2. Own the media stream, emit state changes,
    measure duration, stop all tracks, and map permission/device errors to
    `AdapterError`. Do not call Groq or storage.

- [ ] **V1-10 — Validate native audio limits**
  - Files: `src/platform/audio/MediaRecorderAdapter.ts`
  - Produce the native MediaRecorder blob without decoding, resampling, or WAV conversion.
    Enforce the five-minute and 25 MB limits, map limit errors, acquire the optional
    Android screen wake lock while recording, reacquire it after visibility changes when
    possible, and release it on every exit path.

- [ ] **V1-11 — Implement localStorage settings**
  - Files: `src/platform/storage/localStorageSettings.ts`
  - Implement `SettingsRepository` from §4.3 using one JSON value at
    `openwhispr.settings`. Include defaults, `clearApiKey`, and subscription
    notifications. Do not store a cleanup model; v1 uses the fixed model in the Groq
    client. Never log `groqApiKey`.

- [ ] **V1-12 — Implement browser clipboard**
  - Files: `src/platform/clipboard/browserClipboard.ts`
  - Implement `ClipboardAdapter` from §4.4. Map empty input, missing API, and
    `NotAllowedError` to the defined statuses. Try a temporary textarea fallback when
    the modern API is unavailable or denied. Never throw for expected clipboard errors.

- [ ] **V1-13 — Implement the Groq HTTP client**
  - Files: `src/platform/inference/groqClient.ts`
  - Implement `GroqClient` from §4.5 using the defined cleanup prompt and the fixed
    verified cleanup model `llama-3.1-8b-instant`. Each request receives the current `apiKey`. Upload native
    WebM/MP4 with the correct filename extension, omit empty language, enforce the 25 MB
    limit, inject `fetcher`, enforce timeout, retry only network/5xx, map HTTP failures,
    and never include the key in errors/logs.

## Phase 3 — Application Flow

- [ ] **V1-14 — Implement dictation flow**
  - Files: `src/services/dictationFlow.ts`
  - Implement `DictationFlow` from §4.6 using injected `AudioRecorder`,
    `SettingsRepository`, and `GroqClient`. Implement the exact state sequence, safe
    invalid-transition handling for idle/completed/error versus active states, an owned
    AbortController for cancellation, the missing-key check before recording, and raw-text
    fallback for cleanup errors. Do not persist results.

- [ ] **V1-15 — Create application services**
  - Files: `src/app/services.ts`, `src/app/types.ts`
  - Construct one settings repository, one recorder, one Groq client factory, one
    clipboard adapter, and one dictation flow. The flow must pass the current settings key
    into each Groq request. The Groq client owns the fixed v1 model identifiers and never
    uses a build-time environment key.

- [ ] **V1-16 — Add useDictation hook**
  - Files: `src/hooks/useDictation.ts`
  - Bind `DictationFlow` to React. Expose `state`, `result`, `start`, `stop`, and
    `cancel`. No browser global access in the hook.

- [ ] **V1-17 — Add useSettings hook**
  - Files: `src/hooks/useSettings.ts`
  - Bind `SettingsRepository` to React. Expose current settings, `update`, `reset`,
    and `ready`. Include a dedicated `clearApiKey` action.

## Phase 4 — Minimal Android UI

- [ ] **V1-18 — Build the record button**
  - Files: `src/ui/components/RecordButton.tsx`
  - Render idle, recording, transcribing, cleaning, and disabled states. Use a large
    touch target. Do not implement press-and-hold; use tap Start and tap Stop.

- [ ] **V1-19 — Build the recorder screen**
  - Files: `src/ui/RecorderScreen.tsx`
  - Show the record button, state text, final result, cleanup warning, and Copy action.
    Copy must call `ClipboardAdapter` from a user gesture. Keep the result visible after
    clipboard failure.

- [ ] **V1-20 — Build the settings screen**
  - Files: `src/ui/SettingsScreen.tsx`
  - Show Groq API key input, Save, Clear API Key, cleanup toggle, and language. The
    cleanup model is fixed to `llama-3.1-8b-instant` and is not editable. Omit history,
    provider selection, local models, permissions panels, updater controls, hotkeys, and
    desktop settings.

- [ ] **V1-21 — Build the app shell**
  - Files: `src/App.tsx`, `src/main.tsx`
  - Add a simple Recorder/Settings switch. Compose services once and pass them to the
    screens. Keep the entry point browser-only.

- [ ] **V1-22 — Update the HTML entry**
  - Files: `src/index.html`
  - Point to `/main.tsx`, set Android viewport/theme metadata, and remove legacy asset
    references and Google Fonts dependencies. Ensure the manifest is linked or injected
    by the PWA plugin. `main.tsx` replaces `main.jsx`; do not leave two active entry
    points.

## Phase 5 — Boundary Tests

- [ ] **V1-23 — Test audio boundaries**
  - Files: `src/platform/audio/mimeNegotiation.test.ts`,
    `src/platform/audio/MediaRecorderAdapter.test.ts`
  - Test MIME selection, recording state transitions, permission/device errors, duration
    and byte limits, and wake-lock release with mocked browser media APIs.

- [ ] **V1-24 — Test settings and clipboard**
  - Files: `src/platform/storage/localStorageSettings.test.ts`,
    `src/platform/clipboard/browserClipboard.test.ts`
  - Test settings serialization, defaults, reset, API-key clearing, subscriptions, and
    modern-API plus textarea clipboard fallback behavior with mocked browser APIs.

- [ ] **V1-25 — Test Groq HTTP behavior**
  - Files: `src/platform/inference/groqClient.test.ts`
  - Test multipart and chat request shapes, native audio filenames, empty-language
    omission, size rejection, status mapping, timeout, retry policy, and key redaction
    using injected fetch.

- [ ] **V1-26 — Test dictation flow**
  - Files: `src/services/dictationFlow.test.ts`
  - Test the state sequence, invalid transitions, cancellation, cleanup success, cleanup
    fallback, and no-result-on-transcription-failure behavior with mocked adapters.

## Phase 6 — PWA Build

- [ ] **V1-27 — Configure Vite PWA**
  - Files: `package.json`, `src/vite.config.mjs`
  - Add `vite-plugin-pwa` and `vite-plugin-basic-ssl`, configure
    `registerType: "autoUpdate"`, and precache only the app shell/icons. Configure Groq
    API requests as network-only. Keep Vite root `src/`, `base: "./"`, and dev HTTPS
    LAN access. Use only web build dependencies and scripts.

- [ ] **V1-28 — Add Android manifest and icons**
  - Files: `src/public/manifest.webmanifest`, `src/public/icons/icon-192.png`
  - Set app name, `display: "standalone"`, `start_url: "."`, theme color, and Android
    icon metadata. Add the 192px icon using the existing project icon source if suitable.

- [ ] **V1-28A — Add the large Android icon**
  - Files: `src/public/icons/icon-512.png`
  - Add the 512px icon referenced by the manifest using the existing project icon source.

- [ ] **V1-29 — Install and test the PWA**
  - Files: none
  - Deploy the static build to GitHub Pages over HTTPS, install from Android Chrome, and
    verify reload, microphone permission, wake lock, Start/Stop, transcription, cleanup,
    Copy, limits, and settings.

## Final Verification

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Test missing key, invalid key, offline mode, microphone denial, Groq timeout,
  Groq rate limit, cleanup failure, and clipboard denial.
- [ ] Confirm DevTools Application storage contains settings only; no audio or API
  responses exist in Cache Storage.
