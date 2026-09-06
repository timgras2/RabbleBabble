# RabbleBabble Android PWA v1 Architecture

This is the technical specification for the v1 scope in `plan.md`. It intentionally
contains no local inference, history database, backend, or cross-device synchronization.

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
cookie does not follow it. Audio and transcripts are never persisted: D1 holds
an email address, a session hash, and numeric usage counters.

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

export type RecordingState = "idle" | "recording" | "stopping" | "disposed";

export interface AudioRecording {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
}

export interface AudioRecorderOptions {
  readonly preferredMimeTypes?: readonly string[];
  readonly audio?: MediaTrackConstraints;
  readonly maxDurationMs?: number;
  readonly maxBytes?: number;
}

export interface AudioRecorder {
  readonly state: RecordingState;
  start(): Promise<void>;
  stop(): Promise<AudioRecording>;
  cancel(): Promise<void>;
  subscribe(listener: (state: RecordingState) => void): Unsubscribe;
  dispose(): void;
}
```

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

No history store exists in v1. The transcription model
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
}
```

`BrowserClipboard` first uses `navigator.clipboard.writeText`, then tries a temporary
textarea with `document.execCommand("copy")` when the modern API is unavailable or
denied. Both attempts must originate from the Copy button's user gesture. Clipboard
failure never deletes the visible result.

### 4.5 Inference

File: `src/platform/inference/types.ts`

> **V2.** This port was `GroqClient` and carried an `apiKey` on every request.
> It is now `InferenceClient`: no credential in the request shape, because
> `BackendClient` has none to give. `ensureReady()` answers "would a request be
> accepted right now?" and is awaited BEFORE the microphone opens, so a missing
> key or a dead session costs the user no speech. Models, limits and prompts moved
> to `src/shared/` so the Worker uses the same definitions.

```ts
import type { AudioRecording } from "../audio/types";

export interface GroqClientOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly transcriptionTimeoutMs?: number;
}

export interface GroqTranscriptionResponse {
  readonly text: string;
}

export interface GroqCleanupResponse {
  readonly text: string;
}

export interface GroqRewriteResponse {
  readonly text: string;
}

export interface GroqClient {
  transcribe(request: {
    readonly apiKey: string;
    readonly audio: AudioRecording;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqTranscriptionResponse>;

  cleanup(request: {
    readonly apiKey: string;
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqCleanupResponse>;

  rewrite(request: {
    readonly apiKey: string;
    readonly text: string;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<GroqRewriteResponse>;
}
```

`groqClient.ts` uses the fixed transcription model `whisper-large-v3-turbo` and cleanup
model `openai/gpt-oss-20b` and:

```text
https://api.groq.com/openai/v1/audio/transcriptions
https://api.groq.com/openai/v1/chat/completions
```

It receives the current API key on each request, sends it as a Bearer token, uses
multipart form data for transcription, and uses OpenAI-compatible chat messages for
cleanup. It derives a `.webm` or `.mp4` filename from the recording MIME type and sends
the native recording without WAV conversion. It omits the `language` field when the
setting is empty. It rejects audio over 25 MB before upload. Transcription uses a
120-second default timeout; cleanup and rewrite use a 30-second default timeout. Network
and 5xx errors retry up to three attempts with 1-second then 2-second exponential backoff.
Transcription timeouts do not automatically re-upload the recording. It never retries an
aborted request and does not retry 400, 401, 403, 404, or 429 responses.

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

export interface DictationFlow {
  readonly state: DictationState;
  readonly result: DictationResult | null;
  start(): Promise<void>;
  stop(): Promise<DictationResult>;
  rewrite(instruction: string): Promise<DictationResult>;
  cancel(): Promise<void>;
  subscribe(listener: (state: DictationState) => void): Unsubscribe;
}
```

The flow checks that a key exists before starting a recording, then reads current settings
through `SettingsRepository` again when `stop()` starts. It must perform this sequence:

```text
start recording
stop recording
transcribe with Groq
if cleanupEnabled: clean with Groq
if cleanup fails: return raw text with cleanupFailed=true
show result
```

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

No result is persisted. No audio is retained after the flow completes or is cancelled.

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
- Use `vite-plugin-pwa` with `registerType: "autoUpdate"`.
- Precache only the application shell and icons.
- Never cache requests to `api.groq.com`.
- Never store audio, API keys, or transcripts in Cache Storage.
- No COOP/COEP headers are required because v1 has no WASM or WebGPU.
- The manifest uses `display: "standalone"`, `start_url: "."`, and both 192px and 512px
  Android icons.

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
- Manual Android install and microphone/clipboard testing.
