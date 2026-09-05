# RabbleBabble V2 — Multi-User Plan

**Goal:** Let multiple users use RabbleBabble as a service, with a more mature setup, while keeping the product single-purpose: record → clean transcript → copy. Fast, simple, works every time.

**Guiding principle:** Everything in this plan is measured against one question — *does it make dictation more reliable or more accurate, or does it just add surface area?* If the latter, it's out.

---

## 1. The fundamental V2 decision: who owns the API key?

V1's model (each user pastes their own Groq key) does not survive multi-user as a *service*. You have two real options:

**Option A — "Bring your own key" multi-user (no backend).**
Keep the client-only architecture; improve onboarding so each user creates their own free Groq key. Zero infrastructure, zero cost to you, privacy story unchanged.
*Choose this if "multiple users" means a handful of friends/family and you don't want to operate anything.*

**Option B — Central key behind a backend proxy (recommended for a real service).**
You hold one Groq key server-side. Users authenticate; the client sends audio to *your* API, which forwards to Groq. This is the only way to offer "install and it just works" — no user ever sees an API key.
*The rest of this plan assumes Option B.*

---

## 2. V2 architecture (Option B)

### 2.1 Shape

```
Android PWA (unchanged core)
   │  HTTPS + session token
   ▼
Backend proxy (thin, stateless)
   ├─ Auth (magic link / passkey)
   ├─ Per-user rate limits & quotas
   ├─ Pass-through to Groq (audio → transcript, text → cleanup/rewrite)
   └─ Usage metering (counts + durations only, never content)
   │
   ▼
Groq API (server-side key)
```

The backend is a **pass-through proxy, not a data store**. Transcripts and audio are never persisted server-side. This keeps the V1 privacy promise ("your words aren't stored") true in V2, keeps GDPR exposure minimal, and keeps the backend genuinely thin.

### 2.2 Why your V1 architecture makes this cheap

The ports-and-adapters design pays off here. `DictationFlowService`, the UI, and all state handling stay untouched. You swap one adapter:

- `GroqHttpClient` → `BackendClient` implementing the same `GroqClient` interface (`transcribe`, `cleanup`, `rewrite`), authenticating with a session token instead of an API key.
- `LocalStorageSettings` loses the `groqApiKey` field, gains a session token (or the token lives in an HttpOnly cookie — preferred).
- Keep `GroqHttpClient` in the codebase behind a build flag as a "self-hosted / BYO-key" mode. It costs nothing and keeps a no-infrastructure escape hatch.

### 2.3 Backend technology

Recommendation: **Cloudflare Workers + Hono**, with **D1** (users, quotas) and **Turnstile** (bot protection on auth).

Rationale: the frontend already deploys as static files (Pages); Workers sit on the same platform, scale to zero, cost near-zero at small scale, run at the edge (low latency for uploads), and handle multipart audio uploads fine at your 25 MB cap. No servers to patch — that *is* the mature setup for a one-person project.

Solid alternative if you prefer a long-running Node process: Hono/Fastify on Fly.io or Railway. Avoid anything heavier (Kubernetes, microservices) — that's maturity theater at this scale.

### 2.4 Authentication

Keep it passwordless. Two-step recommendation:

1. **V2.0: Magic link via email.** Simplest thing that works; no passwords to store or reset. Sessions in an HttpOnly, Secure, SameSite cookie with long expiry (this is a personal device app — don't log people out weekly; that violates "works every time").
2. **V2.1: Add passkeys** as an upgrade path for returning users — one tap, phishing-resistant, perfect on Android.

Optionally gate signup with **invite codes** initially. It caps your Groq bill while you learn real usage, and postpones abuse handling.

### 2.5 API design

Three endpoints mirroring the existing adapter interface, plus auth:

- `POST /v1/transcribe` — multipart audio, optional language hint → `{ text }`
- `POST /v1/cleanup` — `{ text }` → `{ text }`
- `POST /v1/rewrite` — `{ text, instruction }` → `{ text }`
- `POST /auth/magic-link`, `GET /auth/callback`, `POST /auth/logout`, `GET /v1/me` (quota status)

Version the path (`/v1/`) from day one. Enforce server-side everything the client currently enforces (25 MB, text/instruction length limits) — the client is no longer trusted.

### 2.6 Cost control (this is what actually keeps the service alive)

Groq Whisper turbo is cheap per hour of audio, but an open endpoint with your key is a wallet with a public URL. Non-negotiable from day one:

- Per-user quota (e.g. X minutes of audio/day, Y rewrites/day) with a clear in-app message when reached.
- Global daily spend cap: the proxy stops forwarding when hit — fail closed.
- Per-IP rate limits on auth endpoints; Turnstile on signup.
- Metering stores *numbers only* (user id, seconds of audio, timestamps) — never content.

---

## 3. Mature setup (beyond multi-user)

**Environments.** `main` → staging URL automatically; production deploy on tag/release. One extra Workers environment; near-zero cost.

**CI gates.** Lint + typecheck + unit tests on every PR (per the V1 review), plus one Playwright E2E covering the happy path — record (mocked mic) → transcribe (mocked backend) → copy. One test, run against the real build output. This is the single highest-value test you can add: it verifies "the job gets done every time."

**Observability.** Sentry (or similar) on both client and Worker for errors; structured logs on the Worker (request id, user id, latency, status — no content); a tiny weekly usage summary (users, minutes transcribed, error rate, p95 latency). If p95 transcription latency creeps up, you want to know before users complain.

**Dependency hygiene.** Semver ranges + Renovate/Dependabot (V1 review item 1). With a backend, unpatched dependencies become a real risk rather than a theoretical one.

**Config.** All environment-specific values (backend URL, Sentry DSN) via Vite env vars; secrets (Groq key, email provider key) only in Worker secrets. Nothing in the repo.

**Privacy & GDPR (Dutch/EU users).** A short privacy statement in the app: what's sent where (audio → your proxy → Groq, not stored), what's retained (account email + usage counters), how to delete an account (one button — feasible because you store almost nothing). Check Groq's data-processing terms and set the API's no-retention options where available. Data minimization is your architecture, so compliance is mostly writing down what's already true.

---

## 4. Features that earn their place

Ordered by value-to-complexity. Each strengthens the core loop rather than widening the app.

**4.1 Personal vocabulary (highest value).** A user-defined list of names, jargon, and abbreviations ("SUPERP", "Mendix", colleague names) passed as the Whisper `prompt` parameter to bias recognition. Dictation apps live or die on proper nouns; this is a one-textarea setting and a one-parameter API change. Stored per user (this one *is* worth syncing server-side — it's small, not sensitive content, and should follow the user across devices).

**4.2 Rewrite presets.** The rewrite feature exists; typing the same instruction daily is friction. Ship 3–4 defaults ("Tighten it up", "Bullet points", "Formal email", "Translate to English") as one-tap chips above the free-text field, plus user-defined presets. No new backend capability — just saved instructions.

**4.3 Share instead of copy.** Add a Share button next to Copy using the Web Share API — on Android this opens the native share sheet straight into WhatsApp/Mail/Teams. Removes a step from the core loop on the exact platform you target. A few lines of code.

**4.4 Offline-tolerant recording.** Recording already works offline (mic is local); currently the upload just fails. Instead: keep the finished recording in memory/IndexedDB, show "Waiting for connection…", and auto-submit when connectivity returns. Directly serves "works every time" — the failure mode becomes a delay, not a loss. Pairs with the timeslice fix from the V1 review.

**4.5 Recording timer + haptic feedback.** Elapsed time and remaining-limit indicator while recording; a short vibration on start/stop. Small, pure reliability-feel.

**4.6 Optional on-device history (opt-in, off by default).** Last N transcripts in IndexedDB, device-only, one-tap clear, never synced. The honest use case: "I copied it, the target app crashed, my words are gone." That's a *does the job every time* failure. Framed as a local safety net — not a cloud archive — it doesn't betray the privacy model. If it feels like scope creep, cut it last; but it's the feature users will ask for first.

**Explicitly out of scope for V2** (write this in the README): transcript cloud storage/sync, teams or sharing between users, model selection UI, chat with your transcript, editing suite, iOS-specific work, local inference. Every one of these is a different product.

---

## 5. Phased rollout

**Phase 0 — V1 hardening (≈ half a day).** Ship recommendations.md items 1–3 (semver pins, CI gates, timeout/retry). Don't build V2 on the current foundation.

**Phase 1 — Backend + auth (the real V2 core).** Worker with the three proxy endpoints + magic-link auth; `BackendClient` adapter in the PWA; server-side limits and global spend cap; invite codes. *Exit criterion: a friend installs the PWA, signs in, and dictates — without ever hearing the words "API key."*

**Phase 2 — Mature ops.** Staging environment, Sentry, structured logs, quota status in Settings ("14 of 30 minutes used today"), privacy statement, account deletion.

**Phase 3 — Feature wave.** Vocabulary → presets → share → offline queue → timer/haptics, in that order. Each is independently shippable; stop wherever it stops being fun.

**Phase 4 — Open up.** Remove invite codes when cost data says it's safe; add passkeys.

---

## 6. What deliberately stays the same

The recorder screen, the state machine, the one-screen flow, the explicit copy action, and the no-server-storage promise. V2 changes who holds the key and how mature the operation is — not what the app is. If a V2 decision ever makes the happy path slower than V1 (tap → speak → tap → text), that decision is wrong.
