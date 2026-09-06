# RabbleBabble Architecture

**Normative.** Where this document and the code disagree, one of them is a bug --
and a normative document that disagrees with the code is worse than none, so
say which. It covers V1 (`plan.md`), V2 (`docs/v2-plan.md`) and V3
(`docs/v3-plan.md`); sections carry a `**V2.**` or `**V3.**` note where the
shape changed.

It intentionally contains no local inference, no server-side history, no
cross-device synchronisation, and no cloud storage of audio or transcripts.

**V3.** Audio is now buffered on the *device* -- to IndexedDB, while a
recording is in flight, deleted as soon as a transcript comes back -- because
losing a recording to a reload or a failed upload was the one thing this
product must never do. Opt-in transcript history (off by default) lives in the
same store. Neither is a server-side store, and neither is synced.

## 1. Runtime Shape

```text
React UI
  ↓ hooks and callbacks
DictationFlow
  ↓ interfaces
Browser adapters
  ├─ MediaRecorderAdapter
  ├─ LocalStorageSettings
  ├─ BrowserClipboard
  └─ GroqClient
  ↓ browser APIs / HTTPS
Android Chrome / installed PWA       Groq Cloud
```

## 1a. V2 Runtime Shape (service mode)

```
Android PWA  ──HTTPS, session cookie──┐
                                      │  (same origin)
                        Cloudflare Worker
                          ├─ static assets (the PWA itself)
                          ├─ /auth/*  magic link, sessions
                          ├─ /v1/*    transcribe, cleanup, rewrite
                          ├─ D1       users, sessions, counters
                          ├─ Groq API (server-side key)
                          └─ Resend   the sign-in link, and nothing else
```

The app answers on `https://rabblebabble.cc`, and that origin is also what the
magic link points at: `APP_ORIGIN` is the single value deciding both. Mail
leaves from `login@send.rabblebabble.cc` - a sending subdomain, so a delivery
reputation problem can never reach the domain the app itself lives on.

One Worker serves both the app and the API. That is what keeps the session
cookie first-party, removes CORS entirely, and lets the build-time CSP stay at
`connect-src 'self'`. `workers_dev` is off for the same reason: a second
hostname would serve a copy whose sign-in cannot work, because the `__Host-`
cookie does not follow it. Audio and transcripts are never persisted server-side:
D1 holds an email address, a session hash, numeric usage counters and the user's
personal vocabulary. On the device, in-flight audio is buffered to IndexedDB and
deleted as soon as a transcript comes back; opt-in transcript history lives in
the same store and is off by default.

The bring-your-own-key build keeps the V1 shape - browser straight to Groq -
and is what GitHub Pages serves.

## 2. Directory Structure

```text
src/
├── main.tsx                         # React entry point
├── App.tsx                          # recorder/settings screen switch
├── app/
│   ├── services.ts                  # composition root
│   └── types.ts                     # application service type
├── platform/
│   ├── types.ts                     # shared types
│   ├── errors.ts                    # AdapterError and error codes
│   ├── audio/
│   │   ├── types.ts                 # AudioRecorder contract
│   │   ├── index.ts                 # audio exports
│   │   ├── mimeNegotiation.ts       # supported MediaRecorder MIME type
│   │   └── MediaRecorderAdapter.ts  # microphone recording and optional wake lock
│   ├── storage/
│   │   ├── types.ts                 # Settings and SettingsRepository
│   │   └── localStorageSettings.ts  # localStorage implementation
│   ├── clipboard/
│   │   ├── types.ts                 # ClipboardAdapter
│   │   └── browserClipboard.ts      # navigator.clipboard implementation
│   └── inference/
│       ├── types.ts                 # GroqClient and engine contracts
│       └── groqClient.ts            # Groq Whisper + cleanup requests
├── services/
│   ├── types.ts                     # DictationFlow contract
│   └── dictationFlow.ts             # record → transcribe → cleanup
├── hooks/
│   ├── useDictation.ts
│   └── useSettings.ts
├── ui/
│   ├── RecorderScreen.tsx
│   ├── SettingsScreen.tsx
│   └── components/
│       └── RecordButton.tsx
├── pwa/
│   └── register.ts                  # optional explicit SW registration
├── public/
│   ├── manifest.webmanifest
│   └── icons/
└── index.css
```

This repository contains no legacy Electron or Kotlin files. The entry point must remain
browser-only.

Vite uses `src/` as its root. `src/main.tsx` replaces `src/main.jsx`. The repository
directory `src/public/` is the Vite public directory. The production build must work at
the GitHub Pages path `/RabbleBabble/`; local Android testing uses an HTTPS LAN origin.

## 3. Boundary Rules

1. UI components do not call `navigator`, `fetch`, `localStorage`, or Clipboard APIs.
2. `DictationFlow` coordinates adapters but does not access browser globals.
3. `platform/` does not import UI components.
4. `groqClient.ts` receives an API-key provider function from the composition root.
   It must not import `SettingsRepository`, `localStorage`, or any other storage API.
   `backendClient.ts` receives the `AuthSession` port and holds no credential at all:
   the session lives in an HttpOnly cookie the page cannot read.
5. API keys and transcript text must not be logged.
6. There is no `window.electronAPI` fallback.
7. There is no local inference or execution router.
8. `src/shared/` is imported by both the browser and the Worker. It may contain only
   types, unions, numeric constants and pure functions over primitives - no `Blob`,
   `Request`, `FormData`, `fetch`, `localStorage` or `D1Database`. Enforced by lint.
9. `worker/` may import from `src/shared/` and nothing else in `src/`. Enforced by lint.
10. Only `src/app/mode.ts` reads the build-mode constants. Everything else branches on
    the exported `SERVICE_MODE`, so the unused adapter is eliminated from each bundle.
11. **Nothing may be awaited between a user gesture and the browser API that gesture
    authorises.** WebKit refuses `getUserMedia` outright -- with `NotAllowedError`,
    indistinguishable from a real denial -- when the user activation has not survived to
    the call, and the clipboard behaves the same way. Readiness checks on that path are
    therefore synchronous by contract: `InferenceClient.checkReady()` and
    `AuthSession.requireSignedIn()` answer from state they already hold. This rule has
    now cost two bugs; `src/ui/gesturePreservation.test.tsx` enforces it without Safari.

## 4. Interface Contracts

These interfaces are normative. Implementations must match them exactly.

### 4.1 Shared Types

File: `src/platform/types.ts`

```ts
export type Unsubscribe = () => void;
```

File: `src/platform/errors.ts`

```ts
export type AdapterErrorCode =
  | "mic-denied"
  | "mic-unavailable"
  | "recording-invalid"
  | "recording-too-long"
  | "recording-too-large"
  | "offline"
  | "missing-api-key"
  | "api-unauthorized"
  | "api-rate-limited"
  | "api-invalid"
  | "api-server"
  | "api-timeout"
  | "empty-transcript"
  | "invalid-instruction"
  | "rewrite-too-large"
  | "cancelled"
  | "clipboard-unavailable"
  | "clipboard-denied";

export interface AdapterErrorOptions {
  readonly code: AdapterErrorCode;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(message: string, options: AdapterErrorOptions);
}
```

### 4.2 Audio

File: `src/platform/audio/types.ts`

```ts
import type { Unsubscribe } from "../types";

export type RecordingState =
  | "idle"
  | "recording"
  | "stopping"
  // V3. The recorder ended itself at a limit, or lost the microphone, with
  // nobody waiting on stop(). The recording is retained and the state is
  // published, so the UI can never keep claiming to record into a dead stream.
  | "auto-stopped"
  | "disposed";

/** V3. Everything but "user" is the recorder ending itself. */
export type RecordingEndCause = "user" | "duration-limit" | "byte-limit" | "interrupted";

export interface AudioRecording {
  /** V3. Identifies the buffered copy in the local store. */
  readonly id: string;
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
  readonly endedBy: RecordingEndCause;
}

export interface AudioRecorderOptions {
  readonly preferredMimeTypes?: readonly string[];
  readonly audio?: MediaTrackConstraints;
  readonly maxDurationMs?: number;
  readonly maxBytes?: number;
  readonly audioBitsPerSecond?: number;
  /** V3. Receives each timeslice as it arrives. See 4.7. */
  readonly sink?: RecordingSink;
}

export interface AudioRecorder {
  readonly state: RecordingState;
  /** V3. So the elapsed timer cannot reset when the screen remounts. */
  readonly startedAt: number | null;
  getInputLevel(): number | null;
  /** MUST be called in the same turn as the gesture. Boundary rule 11. */
  start(): Promise<void>;
  stop(): Promise<AudioRecording>;
  cancel(): Promise<void>;
  subscribe(listener: (state: RecordingState) => void): Unsubscribe;
  dispose(): void;
}
```

> **V3.** When a limit fires or the microphone is lost with nobody awaiting
> `stop()`, the adapter retains the assembled recording, publishes
> `"auto-stopped"`, and `stop()` then resolves with what it kept. Previously it
> dropped the blob, released the tracks and published nothing at all, so the UI
> went on showing "Listening... tap to stop" and counted a timer past the cap.
>
> It also listens for track `ended` and `mute`, so a phone call taking the
> microphone ends the recording with a reason instead of producing five minutes
> of billed silence, and it resumes a suspended `AudioContext` -- on iOS a
> context created outside a live user activation never produces samples, so the
> level meter and the silence detection would both read a flat line.
>
> `resolveMimeType` no longer defaults to `"audio/webm"`. That default is
> Android-shaped: on iOS it labels MPEG-4 bytes as WebM and Groq rejects them.

`MediaRecorderAdapter` owns `getUserMedia`, `MediaRecorder`, stream tracks, and MIME
selection. It never calls Groq or storage. It produces the native browser recording for
the Groq client; v1 does not decode, resample, or convert audio to WAV. The default hard
limits are five minutes (`300000` ms) and 25 MB (`26214400` bytes). The adapter
reacquires the optional wake lock after a visibility change while recording, and releases
all tracks and the wake lock on stop, cancel, error, and dispose.

### 4.3 Settings

File: `src/platform/storage/types.ts`

```ts
import type { Unsubscribe } from "../types";

export interface Settings {
  readonly groqApiKey: string;
  readonly cleanupEnabled: boolean;
  readonly language: string;
  /** V3. Opt-in on-device transcript history. Default false. */
  readonly historyEnabled: boolean;
  /** V3. Whisper's biasing hint. In service builds the server holds the copy
      that actually reaches Groq; this is the local edit buffer. */
  readonly vocabulary: string;
}

export type SettingsPatch = Partial<Settings>;

export interface SettingsRepository {
  get(): Settings;
  update(patch: SettingsPatch): Settings;
  clearApiKey(): Settings;
  reset(): Settings;
  subscribe(listener: (settings: Settings) => void): Unsubscribe;
}
```

The v1 implementation is synchronous `localStorage`. Storage key:

```text
rabblebabble.settings
```

On first read, if the RabbleBabble key is absent and `openwhispr.settings` exists, the
repository copies the valid legacy value to the new key and removes the legacy entry.

The stored value is one JSON `Settings` object. Defaults:

```ts
const DEFAULT_SETTINGS: Settings = {
  groqApiKey: "",
  cleanupEnabled: true,
  language: "",
};
```

There is no *server-side* history store, and there never will be. On-device
history (`historyEnabled`, default false) is a device-local safety net in the
IndexedDB store, capped and clearable in one tap; if it ever grows a search
surface or an editing UI it has become a different product. The transcription model
`whisper-large-v3-turbo` and cleanup model `openai/gpt-oss-20b` are fixed constants in
`groqClient.ts`; they are not free-form settings. The Clear API Key action calls
`clearApiKey` only after a confirmation or explicit user action; it must not silently
clear the other settings.

### 4.4 Clipboard

File: `src/platform/clipboard/types.ts`

```ts
export type ClipboardStatus =
  | "copied"
  | "empty"
  | "unavailable"
  | "denied";

export interface ClipboardResult {
  readonly status: ClipboardStatus;
  readonly message?: string;
}

export interface ClipboardAdapter {
  writeText(text: string): Promise<ClipboardResult>;
  /** V3. False where navigator.share is missing, so the UI does not offer it. */
  canShare(): boolean;
  /** V3. The system share sheet, reusing ClipboardResult for symmetry. */
  shareText(text: string): Promise<ClipboardResult>;
}
```

`BrowserClipboard` first uses `navigator.clipboard.writeText`, then tries a temporary
textarea with `document.execCommand("copy")` when the modern API is unavailable or
denied. Both attempts must originate from the Copy button's user gesture -- this is
boundary rule 11, and the microphone is the other place it applies. Clipboard
failure never deletes the visible result.

`shareText` reports a dismissed share sheet (`AbortError`) as `"empty"`, not as a
failure: cancelling is the user saying no.

### 4.5 Inference

File: `src/platform/inference/types.ts`

> **V2.** This port was `GroqClient` and carried an `apiKey` on every request.
> It is now `InferenceClient`: no credential in the request shape at all,
> because `BackendClient` has none to give. Models, limits and prompts moved to
> `src/shared/` so the Worker uses the same definitions.
>
> **V3.** `ensureReady(): Promise<void>` became `checkReady(): void`. It never
> performed I/O -- it was a synchronous check wearing an async signature -- and
> it sits between the record tap and `getUserMedia`, where a single `await`
> loses the user activation WebKit needs to prompt for the microphone. See
> boundary rule 11. Both invariants hold as a result: a dead session still
> costs the user no speech, and the gesture still reaches the microphone.
>
> `transcribe` also takes an optional `vocabulary`. The bring-your-own-key
> adapter forwards it as Whisper's `prompt`; `BackendClient` accepts and
> IGNORES it, because the Worker reads the saved vocabulary from the session
> row -- so it remains true that a client cannot influence a single field of
> the Groq form.

```ts
import type { AudioRecording } from "../audio/types";

export interface InferenceClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly transcriptionTimeoutMs?: number;
}

export interface TranscriptionResponse {
  readonly text: string;
}

export interface CleanupResponse {
  readonly text: string;
}

export interface RewriteResponse {
  readonly text: string;
}

export interface InferenceClient {
  /** Synchronous by contract. Throws an AdapterError when not ready. */
  checkReady(): void;

  transcribe(request: {
    readonly audio: AudioRecording;
    readonly language?: string;
    readonly vocabulary?: string;
    readonly signal?: AbortSignal;
  }): Promise<TranscriptionResponse>;

  cleanup(request: {
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<CleanupResponse>;

  rewrite(request: {
    readonly text: string;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<RewriteResponse>;
}
```

`groqClient.ts` uses the fixed transcription model `whisper-large-v3-turbo` and cleanup
model `openai/gpt-oss-20b` and:

```text
https://api.groq.com/openai/v1/audio/transcriptions
https://api.groq.com/openai/v1/chat/completions
```

`GroqHttpClient` reads the current API key from an injected provider at call
time (not per request argument), sends it as a Bearer token, uses
multipart form data for transcription, and uses OpenAI-compatible chat messages for
cleanup. It derives a `.webm` or `.mp4` filename from the recording MIME type and sends
the native recording without WAV conversion. It omits the `language` field when the
setting is empty, and the `prompt` field when no vocabulary is saved. It rejects audio
over 25 MB before upload. Transcription uses a 120-second default timeout; cleanup and
rewrite use a 30-second default timeout. Network and 5xx errors retry up to three
attempts with 1-second then 2-second exponential backoff. Transcription timeouts do not
automatically re-upload the recording. It never retries an aborted request and does not
retry 400, 401, 403, 404, or 429 responses.

> **V3.** The *Worker's* gateway (`worker/src/groq/gateway.ts`) uses a tighter
> budget than the browser adapter: two attempts and a 45-second transcription
> timeout, for a 91-second worst case. Cloudflare's edge returns its own 524 at
> roughly 100 seconds, and past that the user gets a Cloudflare error page
> instead of the JSON error envelope the entire client error model depends on.

The cleanup prompt is:

```text
System: You are a dictation assistant. Clean up text by fixing grammar and punctuation.
Output ONLY the cleaned text without any explanations, options, or commentary.

User: Clean up the following dictated text by fixing grammar, punctuation, and formatting.
Output ONLY the cleaned text:
<raw transcript>
```

The rewrite operation uses the same cleanup model and chat endpoint, but has a separate
prompt. It applies a user-provided instruction to the current final transcript, preserves
facts and meaning unless explicitly asked otherwise, treats the transcript as content to
edit rather than instructions, and outputs only the rewritten text. The instruction and
transcript are sent as separate JSON fields in the user message. Rewrite input is limited
to 20,000 transcript characters and 2,000 instruction characters.

### 4.6 Dictation Flow

File: `src/services/types.ts`

```ts
import type { Unsubscribe } from "../platform/types";

export type DictationState =
  | "idle"
  | "recording"
  | "transcribing"
  | "cleaning"
  | "rewriting"
  | "completed"
  | "error";

export interface DictationResult {
  readonly rawText: string;
  readonly finalText: string;
  readonly cleanupApplied: boolean;
  readonly cleanupFailed: boolean;
}

/**
 * V3. One object, one subscription.
 *
 * State, result and error used to be read three different ways -- two of them
 * component state that unmounted on navigation -- which is how the app came to
 * show "Something needs your attention" with nothing saying what.
 */
export interface DictationSnapshot {
  readonly state: DictationState;
  readonly result: DictationResult | null;
  readonly error: AdapterError | null;
  readonly notice: string | null;
  readonly canRetry: boolean;
  readonly recoverable: BufferedRecording | null;
}

export interface DictationFlow {
  /** Stable by identity between changes: useSyncExternalStore compares that way. */
  getSnapshot(): DictationSnapshot;
  readonly state: DictationState;
  readonly result: DictationResult | null;
  start(): Promise<void>;
  stop(): Promise<DictationResult>;
  /** V3. Re-sends a held recording after a failed upload. No re-recording. */
  retryUpload(): Promise<DictationResult>;
  /** V3. Transcribes a buffered orphan the user has accepted. */
  recoverBuffered(): Promise<DictationResult>;
  discardBuffered(): Promise<void>;
  rewrite(instruction: string): Promise<DictationResult>;
  cancel(): Promise<void>;
  subscribe(listener: () => void): Unsubscribe;
}
```

The flow calls `checkReady()` -- synchronously, boundary rule 11 -- before
starting a recording, and reads current settings through `SettingsRepository`
again when delivery starts. It must perform this sequence:

```text
check readiness (synchronously)
start recording
stop recording
hold the recording on the service
check readiness again
transcribe with Groq
if cleanupEnabled: clean with Groq
if cleanup fails: return raw text with cleanupFailed=true
show result, delete the held recording and its buffered copy
```

> **V3.** The second readiness check moved to *after* the recorder has stopped.
> It used to run first and cancel the recording on failure, so a session that
> expired mid-recording destroyed the audio -- the exact failure the check
> existed to protect the user from.

After a completed result, `rewrite(instruction)` sends the current `finalText` and the
instruction to Groq. A successful rewrite replaces only `finalText`; repeated rewrites
use the latest final text. Rewrite failures and cancellations preserve the previous result
and return to `completed`.

`start()` is valid from `idle`, `completed`, or `error`; repeated starts during an active
operation are rejected safely and a successful new recording clears the previous result.
`stop()` is valid only while recording; stopping while idle is rejected safely. The flow
  owns an `AbortController` for the active inference request. `cancel()`
aborts that request, cancels recording when needed, returns to `idle`, and does not expose
a partial result. The flow releases the request controller after completion or error.

While rewriting, `cancel()` aborts the rewrite, preserves the completed result, and returns
to `completed`. A late rewrite response must not replace the preserved result.

> **V3.** The recording is held on the service, not in a local inside
> `runStop()`. Any throw on the upload path used to discard it, with no retry
> affordance anywhere in the UI. `retryUpload()` re-sends the same bytes; the
> snapshot's `canRetry` says when that is worth offering.
>
> A recording the recorder ended by itself is absorbed by a subscription to the
> recorder's state: the flow runs the normal transcribe path on it and sets
> `notice` to say why it ended.

No result is persisted server-side. Audio does not outlive its transcript: the
held reference is dropped and the buffered copy in the local store is deleted
the moment a transcript comes back, and both are dropped on cancellation.

### 4.7 Local store

**V3.** File: `src/platform/store/types.ts`

```ts
import type { AudioRecording } from "../audio/types";

export interface BufferedRecording {
  readonly id: string;
  readonly createdAt: number;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface HistoryEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly text: string;
}

export interface RecordingSink {
  open(recordingId: string, mimeType: string): void;
  write(recordingId: string, chunk: Blob): void;
  close(recordingId: string): void;
}

export interface LocalStore extends RecordingSink {
  listRecordings(): Promise<readonly BufferedRecording[]>;
  loadRecording(id: string): Promise<AudioRecording | null>;
  dropRecording(id: string): Promise<void>;

  saveTranscript(text: string): Promise<void>;
  listTranscripts(): Promise<readonly HistoryEntry[]>;
  clearTranscripts(): Promise<void>;

  sweep(nowMs: number): Promise<void>;
}
```

`IdbStore` is the only adapter. Three rules define it:

1. **It is a buffer, not an archive.** Each ten-second timeslice is written as
   it arrives, and the record is deleted the moment a transcript comes back.
   That deletion is what keeps "in-flight audio only" an honest claim.
2. **Failing to buffer must never stop a recording.** Every method resolves
   rather than rejects when the platform refuses -- a private window, a storage
   quota, IndexedDB switched off -- and `MediaRecorderAdapter` calls the sink
   inside a `try`/`catch` that swallows deliberately.
3. **An orphan found at boot is offered, never transcribed.** Spending the
   user's quota on audio they may have abandoned on purpose is not a favour.

Buffered audio is swept after 24 hours or three recordings, whichever comes
first. Opt-in transcript history (`historyEnabled`, default false) lives in the
same database, capped at 20 entries, device-only, never synced, clearable in one
tap.

## 5. Error Behavior

| Condition | Required behavior |
|---|---|
| Microphone denied | Show permission instructions; return to idle |
| No microphone | Show device error; return to idle |
| Missing Groq key | Open/highlight Settings; do not start upload |
| Offline | Show network error; do not queue audio |
| Groq 401 | Ask user to replace the key |
| Groq 429 | Show rate-limit message; no retry loop |
| Transcription failure | Show error; no result |
| Cleanup failure | Show raw transcript and cleanup warning |
| Rewrite failure | Preserve the current result and show an actionable error |
| Clipboard failure | Keep result visible and show copy error |
| Recording exceeds 5 minutes or 25 MB | Stop/reject before upload and show an actionable limit message |
| Repeated Start/Stop | Reject the invalid transition without a duplicate request or stuck state |
| Cancel during upload/cleanup | Abort the request, discard the in-flight result, and return to idle |
| Cancel during rewrite | Abort the request, preserve the current result, and return to completed |

## 6. PWA Configuration

- HTTPS is required for microphone access, Clipboard API, installation, and service
  workers.
- **V3.** Use `vite-plugin-pwa` with `registerType: "prompt"`, never
  `"autoUpdate"`. The latter compiles to a `location.reload()` on controller
  change, so deploying while a user held an uncopied transcript destroyed it.
  The app offers the update instead, and holds the offer back while a recording
  is in progress or a transcript is on screen.
- Precache only the application shell and icons.
- Never cache requests to `api.groq.com`.
- Never store audio, API keys, or transcripts in Cache Storage. The IndexedDB
  buffer in 4.7 is a different thing, on purpose: it is same-origin, it is not
  a cache the service worker manages, and it is deleted on delivery.
- **V3.** Real security headers ship as `dist/_headers`, generated from the
  same `contentSecurityPolicy()` function as the `<meta>` tag so the two cannot
  drift. `run_worker_first` covers only `/v1/*` and `/auth/*`, so asset
  responses never invoke the Worker and `applySecurityHeaders` never ran on the
  app shell at all. The `<meta>` tag stays -- GitHub Pages cannot serve custom
  headers, so it is the only policy the bring-your-own-key build gets -- and is
  injected at the top of `<head>`, ahead of the bundle links.
- The manifest uses `display: "standalone"`, `start_url: "."`, and both 192px and 512px
  Android icons. **V3.** It also declares `id`, which must be set *before*
  anything ever changes `start_url`: install identity keys on `start_url`, so
  changing it later orphans every existing install.

## 7. Testing Boundary

Test only the small boundaries:

- MIME selection with a mocked `MediaRecorder.isTypeSupported`.
- Recording state transitions with mocked browser media APIs.
- Settings serialization and reset with mocked localStorage.
- Groq request paths, status mapping, timeout, and cleanup fallback with injected fetch.
- Groq rewrite request shape, validation, and response handling with injected fetch.
- Dictation flow with mocked adapters.
- Rewrite success, failure, repeated rewrites, and cancellation with mocked adapters.
- Recording duration/size limits, invalid flow transitions, cancellation, and wake-lock
  release behavior.
- **V3.** React screen behaviour with `@testing-library/react`: every Phase 0
  bug lived in that layer, which had no tests at all.
- **V3.** That `getUserMedia` is reached with no awaited promise between it and
  the click handler (`src/ui/gesturePreservation.test.tsx`). This is testable
  without Safari, and it is what stops the regression coming back -- every
  platform except iOS forgives it.
- **V3.** An exhaustiveness table over `AdapterErrorCode`, so a code with no
  copy written for it is a test failure rather than a raw adapter message shown
  to a user.
- **V3.** The Worker gateway's retry, backoff and timeout paths. Every earlier
  test used `mockResolvedValue`, which succeeds first time and therefore never
  exercised any of them.
- **V3.** One Playwright happy path against real build output, plus the retry
  path. It is the only check that runs the real bundle, the real service-worker
  registration and the real CSP together.
- Manual Android install and microphone/clipboard testing, plus a real iPhone
  for the Phase 6 microphone work.
