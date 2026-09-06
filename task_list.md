# RabbleBabble Android PWA v1 Task List

> Execute sequentially. Read `plan.md` and `architecture.md` before every task.
> Each implementation task edits no more than two files. Do not add features outside
> the v1 scope. Contracts in `architecture.md` are normative.

## Phase 0 — Prove the Chosen Runtime

- [ ] **V1-01 — Verify Groq browser access**
  - Files: none
  - From the selected HTTPS host, manually verify one multipart transcription request
    with `whisper-large-v3-turbo` and one chat request with `openai/gpt-oss-20b` reach
    Groq using a temporary test key. Confirm CORS and that both model IDs are accepted,
    then discard the key. If CORS fails or a model is unavailable, stop and revise the
    decision before implementing adapters; do not hide the problem in application code.

- [x] **V1-02 — Record the Android target**
  - Files: `plan.md`, `README.md`
  - Document Android 10+, current Android Chrome, the GitHub Pages URL
    `https://timgras2.github.io/RabbleBabble/`, and the HTTPS LAN development URL shape
    `https://<LAN-IP>:5174/`. Do not document desktop or iOS support as v1 behavior.

## Phase 1 — Contracts and Tooling

- [x] **V1-03 — Add shared platform contracts**
  - Files: `src/platform/types.ts`, `src/platform/errors.ts`
  - Implement exactly `Unsubscribe`, `AdapterErrorCode`, `AdapterErrorOptions`, and
    `AdapterError` from `architecture.md` §4.1.

- [x] **V1-04 — Add audio contracts**
  - Files: `src/platform/audio/types.ts`, `src/platform/audio/index.ts`
  - Export exactly `RecordingState`, `AudioRecording`, `AudioRecorderOptions`, and
    `AudioRecorder` from `architecture.md` §4.2. Include the duration and byte-limit
    options. Do not add an audio normalizer contract.

- [x] **V1-05 — Add storage and clipboard contracts**
  - Files: `src/platform/storage/types.ts`, `src/platform/clipboard/types.ts`
  - Export exactly the settings and clipboard interfaces from `architecture.md` §4.3
    and §4.4. No IndexedDB types, history types, or read-clipboard method.

- [x] **V1-06 — Add inference and flow contracts**
  - Files: `src/platform/inference/types.ts`, `src/services/types.ts`
  - Export exactly `GroqClient`, `GroqClientOptions`, response types, and
    `DictationFlow` types from `architecture.md` §4.5 and §4.6.

- [x] **V1-07 — Add TypeScript checking**
  - Files: `tsconfig.json`, `package.json`
  - Add TypeScript and Vitest tooling, plus `typecheck` and `test` scripts. Do not add
    Electron, Gradle, IndexedDB, WebGPU, or WASM dependencies.

## Phase 2 — Browser Adapters

- [x] **V1-08 — Implement MIME negotiation**
  - Files: `src/platform/audio/mimeNegotiation.ts`
  - Export `negotiateMimeType(preferred?: readonly string[]): string`. Try supported
    Android-friendly types in order: `audio/webm;codecs=opus`, `audio/webm`,
    `audio/mp4`, then `""` for browser default.

- [x] **V1-09 — Implement Android browser recording**
  - Files: `src/platform/audio/MediaRecorderAdapter.ts`
  - Implement `AudioRecorder` from §4.2. Own the media stream, emit state changes,
    measure duration, stop all tracks, and map permission/device errors to
    `AdapterError`. Do not call Groq or storage.

- [x] **V1-10 — Validate native audio limits**
  - Files: `src/platform/audio/MediaRecorderAdapter.ts`
  - Produce the native MediaRecorder blob without decoding, resampling, or WAV conversion.
    Enforce the five-minute and 25 MB limits, map limit errors, acquire the optional
    Android screen wake lock while recording, reacquire it after visibility changes when
    possible, and release it on every exit path.

- [x] **V1-11 — Implement localStorage settings**
  - Files: `src/platform/storage/localStorageSettings.ts`
  - Implement `SettingsRepository` from §4.3 using one JSON value at
    `rabblebabble.settings`. Migrate a valid `openwhispr.settings` value once when the
    new key is absent. Include defaults, `clearApiKey`, and subscription notifications.
    Do not store a cleanup model; v1 uses the fixed model in the Groq client. Never log
    `groqApiKey`.

- [x] **V1-12 — Implement browser clipboard**
  - Files: `src/platform/clipboard/browserClipboard.ts`
  - Implement `ClipboardAdapter` from §4.4. Map empty input, missing API, and
    `NotAllowedError` to the defined statuses. Try a temporary textarea fallback when
    the modern API is unavailable or denied. Never throw for expected clipboard errors.

- [x] **V1-13 — Implement the Groq HTTP client**
  - Files: `src/platform/inference/groqClient.ts`
  - Implement `GroqClient` from §4.5 using the defined cleanup prompt and the fixed
    verified cleanup model `openai/gpt-oss-20b`. Each request receives the current `apiKey`. Upload native
    WebM/MP4 with the correct filename extension, omit empty language, enforce the 25 MB
    limit, inject `fetcher`, enforce timeout, retry only network/5xx, map HTTP failures,
    and never include the key in errors/logs.

## Phase 3 — Application Flow

- [x] **V1-14 — Implement dictation flow**
  - Files: `src/services/dictationFlow.ts`
  - Implement `DictationFlow` from §4.6 using injected `AudioRecorder`,
    `SettingsRepository`, and `GroqClient`. Implement the exact state sequence, safe
    invalid-transition handling for idle/completed/error versus active states, an owned
    AbortController for cancellation, the missing-key check before recording, and raw-text
    fallback for cleanup errors. Do not persist results.

- [x] **V1-15 — Create application services**
  - Files: `src/app/services.ts`, `src/app/types.ts`
  - Construct one settings repository, one recorder, one Groq client factory, one
    clipboard adapter, and one dictation flow. The flow must pass the current settings key
    into each Groq request. The Groq client owns the fixed v1 model identifiers and never
    uses a build-time environment key.

- [x] **V1-16 — Add useDictation hook**
  - Files: `src/hooks/useDictation.ts`
  - Bind `DictationFlow` to React. Expose `state`, `result`, `start`, `stop`, and
    `cancel`. No browser global access in the hook.

- [x] **V1-17 — Add useSettings hook**
  - Files: `src/hooks/useSettings.ts`
  - Bind `SettingsRepository` to React. Expose current settings, `update`, `reset`,
    and `ready`. Include a dedicated `clearApiKey` action.

## Phase 4 — Minimal Android UI

- [x] **V1-18 — Build the record button**
  - Files: `src/ui/components/RecordButton.tsx`
  - Render idle, recording, transcribing, cleaning, and disabled states. Use a large
    touch target. Do not implement press-and-hold; use tap Start and tap Stop.

- [x] **V1-19 — Build the recorder screen**
  - Files: `src/ui/RecorderScreen.tsx`
  - Show the record button, state text, final result, cleanup warning, and Copy action.
    Copy must call `ClipboardAdapter` from a user gesture. Keep the result visible after
    clipboard failure.

- [x] **V1-20 — Build the settings screen**
  - Files: `src/ui/SettingsScreen.tsx`
  - Show Groq API key input, Save, Clear API Key, cleanup toggle, and language. The
    cleanup model is fixed to `openai/gpt-oss-20b` and is not editable. Omit history,
    provider selection, local models, permissions panels, updater controls, hotkeys, and
    desktop settings.

- [x] **V1-21 — Build the app shell**
  - Files: `src/App.tsx`, `src/main.tsx`
  - Add a simple Recorder/Settings switch. Compose services once and pass them to the
    screens. Keep the entry point browser-only.

- [x] **V1-22 — Update the HTML entry**
  - Files: `src/index.html`
  - Point to `/main.tsx`, set Android viewport/theme metadata, and remove legacy asset
    references and Google Fonts dependencies. Ensure the manifest is linked or injected
    by the PWA plugin. `main.tsx` replaces `main.jsx`; do not leave two active entry
    points.

## Phase 5 — Boundary Tests

- [x] **V1-23 — Test audio boundaries**
  - Files: `src/platform/audio/mimeNegotiation.test.ts`,
    `src/platform/audio/MediaRecorderAdapter.test.ts`
  - Test MIME selection, recording state transitions, permission/device errors, duration
    and byte limits, and wake-lock release with mocked browser media APIs.

- [x] **V1-24 — Test settings and clipboard**
  - Files: `src/platform/storage/localStorageSettings.test.ts`,
    `src/platform/clipboard/browserClipboard.test.ts`
  - Test settings serialization, defaults, reset, API-key clearing, subscriptions, and
    modern-API plus textarea clipboard fallback behavior with mocked browser APIs.

- [x] **V1-25 — Test Groq HTTP behavior**
  - Files: `src/platform/inference/groqClient.test.ts`
  - Test multipart and chat request shapes, native audio filenames, empty-language
    omission, size rejection, status mapping, timeout, retry policy, and key redaction
    using injected fetch.

- [x] **V1-26 — Test dictation flow**
  - Files: `src/services/dictationFlow.test.ts`
  - Test the state sequence, invalid transitions, cancellation, cleanup success, cleanup
    fallback, and no-result-on-transcription-failure behavior with mocked adapters.

## Phase 6 — PWA Build

- [x] **V1-27 — Configure Vite PWA**
  - Files: `package.json`, `src/vite.config.mjs`
  - Add `vite-plugin-pwa` and `vite-plugin-basic-ssl`, configure
    `registerType: "autoUpdate"`, and precache only the app shell/icons. Configure Groq
    API requests as network-only. Keep Vite root `src/`, `base: "./"`, and dev HTTPS
    LAN access. Use only web build dependencies and scripts.

- [x] **V1-28 — Add Android manifest and icons**
  - Files: `src/public/manifest.webmanifest`, `src/public/icons/icon-192.png`
  - Set app name, `display: "standalone"`, `start_url: "."`, theme color, and Android
    icon metadata. Add the 192px icon using the existing project icon source if suitable.

- [x] **V1-28A — Add the large Android icon**
  - Files: `src/public/icons/icon-512.png`
  - Add the 512px icon referenced by the manifest using the existing project icon source.

- [ ] **V1-29 — Install and test the PWA**
  - Files: none
  - Deploy the static build to GitHub Pages over HTTPS, install from Android Chrome, and
    verify reload, microphone permission, wake lock, Start/Stop, transcription, cleanup,
    Copy, limits, and settings.

## Phase 7 — Transcript Rewriting

- [x] **V1-R01 — Add typed rewrite inference**
  - Files: `src/platform/errors.ts`, `src/platform/inference/types.ts`,
    `src/platform/inference/groqClient.ts`
  - Add a separate rewrite operation using the fixed text model, structured transcript and
    instruction input, validation, and a rewrite-specific prompt. Reuse existing retry and
    timeout behavior without exposing a customizable system prompt.

- [x] **V1-R02 — Add rewrite flow behavior**
  - Files: `src/services/types.ts`, `src/services/dictationFlow.ts`
  - Add the `rewriting` state and `rewrite()` operation. Rewrite the current final text,
    preserve the previous result on failure or cancellation, support repeated rewrites, and
    prevent concurrent recording or rewrite operations.

- [x] **V1-R03 — Add rewrite controls**
  - Files: `src/hooks/useDictation.ts`, `src/ui/RecorderScreen.tsx`,
    `src/ui/components/RecordButton.tsx`, `src/index.css`
  - Add the instruction form, apply/cancel behavior, progress state, validation feedback,
    retry-preserving behavior, and current-result copying.

- [x] **V1-R04 — Test and document transcript rewriting**
  - Files: `src/platform/inference/groqClient.test.ts`, `src/services/dictationFlow.test.ts`,
    `README.md`, `architecture.md`, `plan.md`, `task_list.md`
  - Cover request validation, rewrite success, failure preservation, cancellation, and
    privacy/network-only behavior. Defer voice instructions and undo/history.

## Final Verification

- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run build`
- [x] Test missing key, invalid key, offline mode, microphone denial, Groq timeout,
  Groq rate limit, cleanup failure, rewrite failure/cancellation, and clipboard denial.
  Covered by the adapter tests, the React screen tests added in V3, and the
  `messageForError` exhaustiveness table.
- [ ] Confirm DevTools Application storage contains settings and -- only while in
  flight -- buffered audio, with no transcripts and no API responses in Cache
  Storage. **Changed in V3:** in-flight audio is now deliberately in IndexedDB
  and deleted on delivery; see `docs/v3-plan.md` Phase 2.

## Phase 8 — V3

Tracked in `docs/v3-plan.md`, which is the authority on the reasoning. Delivered:

- [x] **V3-0 — Shipped defects.** Auto-stop retains the recording and publishes
  the state; failed uploads hold the audio and offer a retry; the two undeclared
  CSS properties; the service worker that could reload away a transcript; the
  elapsed timer that restarted from zero; the error state that outlived its notice.
- [x] **V3-1 — Worker hardening.** The `Set-Cookie` account-existence oracle;
  `EMAIL_MODE=console` refused off localhost; auto-suspension only on a measured
  duration, with `scripts/user.mjs` as the recovery path; bounded unauthenticated
  bodies; burst limits on `/v1/*`; real security headers on the app shell;
  90-day sliding sessions with rotation at sign-in; cost controls that express a
  policy; a retry budget that fits under Cloudflare's edge timeout; sweep
  robustness; account deletion.
- [x] **V3-2 — The durability layer.** In-flight audio buffered to IndexedDB and
  deleted on delivery; interruption handling; silence detection; capture constraints.
- [x] **V3-3 — Design system and accessibility.** Type, space, radius and motion
  tokenised; the typeface resolved; the announcement model rebuilt; real headings
  and focus management; Settings autosaves.
- [x] **V3-4 — Features.** Personal vocabulary, rewrite preset chips, share and a
  finished manifest, opt-in on-device history.
- [x] **V3-5 — Proof and ops.** React screen tests, one Playwright happy path
  against real build output, gateway retry coverage, the error-code exhaustiveness
  table, a staging environment, a hardened deploy workflow with a smoke gate,
  Dependabot and `npm audit`, type-aware ESLint, a bundle budget, and a weekly
  usage summary.
- [x] **V3-6 — iOS: make the microphone openable.** `checkReady()` is synchronous
  so the user activation survives to `getUserMedia` (boundary rule 11);
  `AudioContext.resume()`; platform-aware permission copy; the latent WebM default.

Still open, and only a device can close them:

- [ ] **V3-V1 — Android device pass.** Install the PWA and run tap -> speak ->
  tap -> copy, then a five-minute auto-stop, an airplane-mode upload failure, an
  incoming phone call mid-recording, and a deploy while holding a transcript.
- [ ] **V3-V2 — iPhone pass.** In Safari: the first tap shows the system
  microphone prompt, a recording completes end to end, the level meter moves
  rather than flatlining, and the blob is `audio/mp4` and accepted. Then deny
  permission deliberately and confirm the error names Safari's Website Settings.
  Finally add it to the Home Screen and repeat -- that is a separate permission
  context. If standalone mode cannot open the microphone at all on current iOS,
  record that in the README rather than trying to fix it.
