# RabbleBabble V3 — "Never lose the words, and prove it"

**Written:** 2026-09-06, against `main` @ `905ebeb`.
**Supersedes nothing.** `docs/v2-plan.md` §3 and §4 are still the backlog; this
document says which parts of them V3 does, and what a full read of the shipped
code found that neither earlier review caught.

---

## Why this shape

V1 shipped a browser-only PWA. V2 added a Cloudflare Worker with magic-link
auth, a server-held Groq key and real cost control. What is underneath is good:
ports and adapters enforced by lint rather than by documentation, atomic
compare-and-increment quota reservations that survive D1 having no interactive
transactions, a Groq request the client cannot influence a single field of, and
zero `any` and zero `ts-ignore` in the entire codebase.

The weaknesses are all at the edges, and they cluster around one thing.

**The product's single promise — your words are never lost — is broken by four
separate code paths.** Audio is silently destroyed when a recording hits a limit,
and again on every failed upload, while the UI carries on claiming to record.
`src/ui/errorMessages.ts:31` tells the user *"Nothing you recorded was lost"* at
a moment when it has been.

That is the spine of V3. Around it sit a small number of real security gaps — an
account-existence oracle that defeats an otherwise meticulous no-enumeration
design, a one-variable config footgun that is total account takeover, an
auto-suspend that fires on an estimated value with no recovery path — a design
system that tokenised colour beautifully and left type, space and radius as ~100
magic numbers, and the four features `docs/v2-plan.md` §4 argued for and nobody
has built.

V3 closes the edges and then builds those four. It rebuilds nothing.

### Decisions taken

- In-flight audio is buffered to IndexedDB and deleted on delivery.
- Sessions become 90-day sliding with rotation at sign-in.
- Observability stays Cloudflare-native; no third-party processor.
- All four §4 features are in scope, including opt-in on-device history.

### Still out of scope, and still right

Transcript cloud storage or sync, teams and sharing between users, model
selection UI, chat with your transcript, an editing suite, local inference.

**iOS moves in, narrowly.** V1 and V2 scoped iOS out entirely. V3 does not add
iOS as a supported platform — no iOS design work, no Safari-specific layout, no
promise about the installed-to-Home-Screen experience. It fixes one thing:
Safari currently cannot open the microphone at all, and the reason is a bug in
our own call ordering rather than anything about iOS. See Phase 6. The cost of
this decision is that the release checklist grows a real iPhone.

### The bar every change answers to

From `docs/v2-plan.md:142`:

> If a V2 decision ever makes the happy path slower than V1 (tap → speak → tap →
> text), that decision is wrong.

---

## Phase 0 — Shipped defects

These are bugs in production today.

### 0.1 Auto-stop destroys the audio and leaves the UI lying

`src/platform/audio/MediaRecorderAdapter.ts:289-297`. When the five-minute timer
or the 25 MB `ondataavailable` check fires, no `stop()` is pending, so
`hasConsumer` is false and the limit branch sets `this.autoStopped = true` and
returns — **with no `setState` call at all**. By then `releaseResources()` (line
281) has stopped the tracks and cleared `chunks`, and the assembled `blob` from
line 270 falls out of scope.

So `currentState` stays `"recording"`. The flow stays `"recording"`. The UI shows
*"Listening… tap to stop"* and `RecorderScreen.tsx:248` renders a timer counting
past the cap — `07:32 / 05:00` — into a microphone that was released minutes ago.
The level meter flatlining is the only cue, and it is indistinguishable from
silence.

Fix:

- Retain the assembled recording on the instance instead of dropping it.
- Add `"auto-stopped"` to `RecordingState` (`src/platform/audio/types.ts`) and
  `setState` it, so subscribers learn immediately.
- `stop()` resolves with the retained recording rather than rejecting, and
  reports why it ended (`stoppedBy: "limit" | "user"` on `AudioRecording`).
- `DictationFlowService` runs the normal transcribe path on that state and says
  *"Stopped at the five-minute limit — transcribing what you said."*

The byte-limit path at lines 232-237 is the same code and the same fix.

**The existing test encodes the bug as correct.** `MediaRecorderAdapter.test.ts:101-114`
advances past the limit and immediately calls `stop()`, so it never observes the
window where the app is lying. Rewrite it to assert the transition *without*
calling `stop()`.

### 0.2 Audio is lost on every failed upload

`src/services/dictationFlow.ts:158`. `const audio = await recorder.stop()` is
function-local; any throw at `:197-204` discards it, and there is no retry
affordance anywhere in the UI — `ErrorAction` (`src/ui/RecorderScreen.tsx:299-318`)
offers Sign in, See usage and Open Settings, never "try this recording again".

Reachable by: offline mid-upload, three 5xx responses, a transcription timeout on
a slow connection, quota exceeded in flight, session expiry between
`ensureReady()` and the upload.

Hold the recording on the service, add `retryUpload()` to the `DictationFlow`
contract (`src/services/types.ts`), and give `ErrorAction` a "Try again" button
for retryable codes. Correct the copy at `errorMessages.ts:31` in the same
commit, so the promise and the behaviour agree.

### 0.3 Two undefined CSS custom properties

`src/index.css:361-362` references `--line` and `--radius-lg`. Neither is declared
anywhere in the stylesheet. The *"Check your email"* card — the first thing a new
user sees after submitting — ships borderless with square corners while every
other card has `1px solid var(--border-strong)` and a 22-24px radius.

`.signin-screen { gap: 1.25rem }` at `:350` is inert: `.screen` (`:167`) is
neither flex nor grid, so the sign-in screen's entire vertical rhythm silently
does not apply.

### 0.4 The service worker can reload away a transcript

`registerType: "autoUpdate"` (`src/vite.config.mjs:127`) plus `immediate: true`
compiles to a `location.reload()` on controller change — present in the shipped
bundle. A deploy while a user holds an uncopied transcript, or is mid-recording,
destroys it. There is no `onNeedRefresh` UI and no deferral.

Switch to `onNeedRefresh` with a quiet "Update ready" affordance that refuses to
reload while recording or while a transcript is uncopied. `useHasTranscript`
(`src/hooks/useAuthSession.ts:35-42`) already encodes exactly that rule for the
session case — reuse it.

### 0.5 The elapsed timer restarts from zero

`src/ui/RecorderScreen.tsx:50` derives elapsed time from component mount, not
from the recorder's own `startedAt`. Open Settings mid-recording, come back, and
it reads `00:00` against a real five-minute hard limit. Expose `startedAt` and
derive from it.

### 0.6 The error state outlives its notice

`src/hooks/useDictation.ts:18` keeps `error` in component `useState` while
`state` lives in the service, and `App.tsx:72-82` unmounts `RecorderScreen` on
navigation. After a failure: open Settings, come back, and the screen says
*"Something needs your attention"* with nothing anywhere saying what.

Fold `state`, `result` and `error` into one subscribed snapshot. That also closes
the fragility `docs/recommendations.md:81` flagged — `flow.result` is read
outside the `useSyncExternalStore` snapshot — and the duplicate subscription at
`useDictation.ts:8` and `:13`.

---

## Phase 1 — Worker and delivery hardening

### 1.1 Close the account-existence oracle

`worker/src/auth/routes.ts:121` sets `Set-Cookie: __Host-rb_link` only inside
`if (userId !== null)`. Every other detail of that route is carefully identical
for known and unknown addresses — a suspended account falls through silently, a
mail failure is swallowed by design, the body is byte-identical — and this one
header undoes all of it in a single unauthenticated request.

The test suite misses it because `worker/test/auth.test.ts:36-39` compares only
body keys and never inspects headers.

Always set a link-nonce cookie, using a throwaway `randomToken()` when there is
no account. Then assert the parity:

```ts
expect(known.headers.getSetCookie().map(shape))
  .toEqual(unknown.headers.getSetCookie().map(shape));
```

Move `email.send` (`routes.ts:105`) into `ctx.waitUntil` while here. A live Resend
call for known addresses and an immediate return for unknown ones is a timing
oracle for the same property, and deferring it improves p99 as a side effect.

### 1.2 Make `EMAIL_MODE=console` impossible in production

In console mode the complete working magic link is returned in the HTTP response
body (`routes.ts:127-129`) to anyone who POSTs a valid address, and logged with
the recipient (`worker/src/email/console.ts:14`). The code comments the danger
honestly; nothing enforces it. `npm run dev:worker` forces this mode via `--var`,
so the muscle memory to type it exists.

Add a cross-field rule in `readConfig`: throw `ConfigError` when
`emailMode === "console"` and `appOrigin` is not a localhost origin. Two lines.
`worker/src/index.ts:11-31` already renders `ConfigError` as a safe generic 500.

This is the worst footgun in the system and the cheapest fix in this document.

### 1.3 Stop auto-suspending on a guess

`worker/src/v1/routes.ts:95` reads
`result.durationSeconds ?? estimateSecondsFromBytes(audio.byteLength)`, where the
estimate is `byteLength / 4_000`. If Groq ever omits both `duration` and
`segments`, every upload over ~1.44 MB — a normal two-minute recording — trips
the 360-second implausibility check at `:105-111` and suspends the account.

An upstream response-shape change becomes a mass lockout. And there is **no
un-suspend path anywhere in the repo** — recovery is a manual
`wrangler d1 execute --remote`.

- Suspend only when `result.durationSeconds !== null`. On the estimate path, bill
  and log, never suspend.
- Add `scripts/user.mjs` with `--suspend` / `--unsuspend`, modelled on
  `scripts/invite.mjs`. Fix that script's string-interpolated SQL while copying
  it — use parameterised `d1 execute` rather than quote-doubling.
- Test the estimate path; `transcribe.test.ts:180-193` only covers an explicit
  nine-hour `duration` from Groq.

### 1.4 Bound the unauthenticated bodies

`POST /auth/callback` (non-JSON branch, `routes.ts:166`) and `POST /auth/logout`
(`safeJson`, `:233`) both read an unbounded request body before any
authentication. Cap both at a new `MAX_AUTH_BODY_BYTES` in `src/shared/limits.ts`,
reusing the Content-Length-then-actual-length pattern already proven in
`worker/src/v1/upload.ts:34-57`.

### 1.5 Burst limits on `/v1/*`

Rate limiting exists only for `/auth/*`. `/v1/*` has daily quotas, but nothing
stops one valid session making 400 transcribe calls in a minute — which, given
§1.8, is also the whole day's global budget.

Reuse `consumeRateLimits` (`worker/src/db/rateLimits.ts`); it already bakes the
window into the bucket key, so there is no rollover bug. Buckets:
`user:<id>:<minute>` and `user:<id>:<hour>`. Do not add a second mechanism.

### 1.6 Real security headers on the app shell

`wrangler.jsonc:33-41` sets `run_worker_first` to `/v1/*` and `/auth/*` only, so
asset responses never invoke the Worker and `applySecurityHeaders` never runs on
the HTML, JS, CSS, manifest or icons. The only CSP is the build-time `<meta>` tag
from `src/vite.config.mjs:106-125` — which cannot express `frame-ancestors`,
`report-to` or `sandbox`, and which the build injects *after* the script and
stylesheet links, so the bundle is fetched before the policy is installed.

Add `src/public/_headers` (Vite copies it; Workers static assets honour it):

```
/*
  Content-Security-Policy: <the policy the vite plugin computes>; frame-ancestors 'none'
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Permissions-Policy: microphone=(self), camera=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
  Referrer-Policy: no-referrer
```

Generate it from the same `contentSecurityPolicy()` function at
`vite.config.mjs:31-56`, so the header and the meta tag cannot drift.

**Keep the `<meta>` tag.** GitHub Pages cannot serve custom headers, so it stays
the only policy the bring-your-own-key build gets. Move its injection to the top
of `<head>`, ahead of the bundle links.

No change to `style-src`. React sets inline styles through CSSOM, which CSP
deliberately does not govern, so `'self'` is correct as it stands.

### 1.7 Sessions: 90-day sliding, rotation at sign-in

Today `SESSION_TTL_SECONDS` is 31536000 — 365 days — `expires_at` is fixed at
issuance, `touchSession` never extends it, and a stolen cookie is good for a
year. `user_agent_hash` is written (`worker/src/auth/session.ts:50`) and never
read: pure privacy cost, hashed *unpeppered* where IPs are peppered, and a UA
string is low-entropy enough that such a hash is effectively plaintext.

- `SESSION_TTL_SECONDS` → `7776000` (90 days).
- Slide `expires_at` forward inside the once-a-day write `touchSession`
  (`session.ts:95-102`) already performs. A daily user is never signed out; an
  abandoned phone stops being a key after 90 days.
- **Rotate the token at sign-in, not per request.** Per-request rotation races
  two concurrent requests into dropping a valid session, and the gain over
  sliding expiry is small. `issueMagicLink` already invalidates outstanding
  tokens; do the same for sessions at redemption.
- Wire up "sign out everywhere". `revokeAllSessions` (`session.ts:108-110`) exists
  but is unreachable: the client posts no body at all
  (`src/platform/auth/httpAuthSession.ts:108-123`) and the server reads the flag
  as the *string* `"true"` (`routes.ts:215`), so a JSON boolean silently does
  nothing. Fix the parse, send the body, add the control to `AccountPanel.tsx`.
- Drop the `user_agent_hash` column.

### 1.8 Make the cost controls express a policy

`wrangler.jsonc:71-78` does not currently. `GLOBAL_DAILY_SPEND_MICROS` of
1,000,000 ($1.00/day) funds roughly 300 transcription reservations, but
`USER_DAILY_TRANSCRIBE_CALLS` is 400 — **one user's cap exceeds the entire global
budget**, so a single account can starve the service for the day. And
`USER_DAILY_AUDIO_SECONDS` of 10800 settles to ~$0.12/user/day, so 8.3 users
exhaust the cap.

- Derive the per-user caps from the global cap and an expected user count.
- Add a per-user daily *spend* cap; only seconds and call counts exist today.
- Allow `GLOBAL_DAILY_SPEND_MICROS=0` as an emergency kill switch.
  `requirePositiveInt` (`worker/src/config.ts:44-51`) rejects it today, so the
  only way to stop the service is to set it to `1`.
- Add `max_completion_tokens` to the chat request
  (`worker/src/groq/gateway.ts:85`). There is no completion cap, and `settle()`
  is explicitly allowed to overshoot, so one long completion overshoots its
  1,875-micro reservation several-fold.

### 1.9 Fit the retry budget to the platform

`worker/src/groq/gateway.ts:12-15` gives a worst case of
`120 + 1 + 120 + 2 + 120 = 363s`. Cloudflare's edge returns 524 at ~100s, so on
the failure path the user gets a Cloudflare error page rather than the JSON error
envelope the entire client error model depends on.

Bring the worst case under ~90s — e.g. a 45s transcription timeout and two
attempts. Then fix the comment at `worker/src/db/sweep.ts:29-30`, which claims a
live request holds a reservation *"for at most 120s"*. It is wrong today, and the
next person tuning `MAX_ATTEMPTS` will trust it.

### 1.10 Sweep robustness

`runSweep` has no `try/catch`, so a throw rejects the `waitUntil` and the cron
fails silently with no alert. It also selects expired reservations with no
`LIMIT` before issuing a `db.batch` of `3 × N` statements — a post-outage backlog
could exceed D1's batch limits and then fail every hour forever without ever
draining. Add both.

### 1.11 Account deletion

`ON DELETE CASCADE` is already declared on `auth_tokens`, `sessions` and
`usage_daily` (`worker/migrations/0001_init.sql:29, 44, 54`), so erasure is one
statement. The plumbing exists; only the entry point is missing. Add
`DELETE /v1/me`, a confirmation in `AccountPanel.tsx`, and the short privacy
statement `docs/v2-plan.md:102` asked for.

Worth stating plainly in that text: the IP pepper protects D1, not Cloudflare's
platform logs, which carry the unpeppered client IP.

### 1.12 Smaller items

- Modulo bias in `generateInviteCode` — `worker/src/auth/invites.ts:14` and the
  duplicate at `scripts/invite.mjs:32`. Use rejection sampling.
- `lastError` is only assigned in the `catch` branch (`gateway.ts:146`), so a
  pure-5xx sequence logs `internal: "undefined"` for exactly the failure you most
  want to debug.
- Memoise `readConfig`/`buildDeps` per isolate. `index.ts:12` re-runs ~18
  validations and re-allocates the gateway and mailer on every single request.
- Remove `LOG_LEVEL` (`wrangler.jsonc:80`) — declared, never read.
- Re-key the per-email rate limit to `email+ip`, or count sends rather than
  requests. Today eight requests from anywhere lock a known address out of
  signing in for the rest of the UTC day.

---

## Phase 2 — The durability layer

One new port, two consumers. This is what makes Phase 0.1 and 0.2 survive a
reload, and it is the same storage the opt-in history in Phase 4 needs. Build it
once.

**New:** `src/platform/store/types.ts` and `src/platform/store/idbStore.ts`,
following the existing port shape exactly — `types.ts` beside the adapter,
injected from `src/app/services.ts`, never imported by UI, never importing UI.

- During recording, write each ten-second `ondataavailable` chunk to IndexedDB
  under a recording id. `MediaRecorderAdapter` already produces these
  (`start(10_000)`, line 106); today they only ever accumulate in memory.
- Delete the record on successful transcript delivery. On boot, if an orphan
  exists, *offer* — "You have an unfinished recording from earlier. Transcribe
  it?" — rather than transcribing silently and spending quota the user did not
  ask to spend.
- Cap total stored bytes and age (say three recordings, 24 hours) and sweep on
  boot, so a failure mode cannot fill the user's storage quota.

**The privacy wording changes with it.** `README.md` and `architecture.md`
currently say audio is never persisted. The honest V3 sentence: *audio never
leaves your device except to be transcribed, and in-flight audio is deleted from
the device as soon as a transcript comes back.*

### Interruptions

Nothing in `src/` listens for track `ended`, `pagehide`, `beforeunload` or
`freeze`. A phone call takes the microphone and the recorder believes it is still
recording, producing a silent upload that is metered and billed.

- Listen for `MediaStreamTrack` `ended`/`mute` and finalise with a clear reason.
- Consume the existing `getInputLevel()` (`MediaRecorderAdapter.ts:52-69` — well
  implemented, currently feeding nothing but the visual meter) to detect sustained
  silence and warn. `docs/design-recommendations.md:35` predicted the meter would
  catch a wrong or muted microphone instantly, but only if someone is looking at
  the screen, which is the one thing dictation users are not doing.
- Add a `beforeunload` guard while recording or holding an uncopied transcript.
- Set capture constraints in `src/app/services.ts:16`, which constructs the
  adapter with no options at all: `channelCount: 1` and a capped
  `audioBitsPerSecond`. Mono at a sane opus bitrate cuts upload size several-fold
  on mobile data and helps Whisper rather than hurting it.

---

## Phase 3 — Design system and accessibility

Colour is genuinely well done — ~45 custom properties, wholesale redeclared for
dark mode, with *measured* contrast ratios recorded in the comments
(`src/index.css:23-25, 44-51`). Nothing else is tokenised: literal font sizes from
10 to 22px, hand-tuned spacing (`27px`, `9px`, `23px`, `21px`), eleven distinct
radii, and weight 800 on almost every interactive element, which flattens
hierarchy rather than creating it.

1. **Extend tokenisation to type, space, radius and motion.** A 4pt spacing scale
   and a six-step type scale remove ~100 magic numbers. The colour system proves
   the capability is already there.
2. **Resolve the typeface.** `index.css:73` asks for Inter. There is no
   `@font-face`, nothing in `src/public/`, and `font-src 'self'` would block a CDN
   anyway — so Android Chrome, the only target, always renders Roboto. Self-host
   Inter or drop it and re-tune for Roboto. Shipping a design tuned in a typeface
   the product does not serve is the worst of both.
3. **Rebuild the announcement model.** `RecorderScreen.tsx:161` puts
   `aria-live="polite"` around the entire result card — transcript, rewrite form,
   copy button — and *contains* nested `role="status"` and two `role="alert"`
   regions, with a second `aria-live` on the state line at `:253`. One dictation
   produces five or more interruptions. One polite region for state, one assertive
   for errors, `aria-atomic` scoping, and no live region wrapping interactive
   content.
4. **Focus and headings.** `App.tsx:66` swaps the whole `<main>` with no focus
   move and no route announcement. Settings has no heading at all — "Settings" is
   a `<span>` at `App.tsx:57` — and once the hero retires after the first
   transcript, the recorder has no `h1` either. A real `h1` per screen, focused on
   navigation.
5. **Settings silently discards changes.** `SettingsScreen.tsx:14-17` mirrors into
   local state and persists only on "Save settings", but the cleanup toggle at
   `:69` looks and behaves like an instant switch. Autosave, or make the pending
   state visible.
6. **Give sign-in and settings the recorder's visual grammar.** The sign-in block
   (`index.css:349-376`) is the only part of the stylesheet using `rem`, and reads
   as bolted on after the design pass — which the git history confirms.
7. Keep the reduced-motion block honest: `LevelMeter.tsx:27-31` reads the media
   query once at effect setup and never re-checks, and `.record-button:hover` and
   the `.toggle` transitions sit outside it.

**Keep verbatim:** the Georgia 22px serif transcript, the two-zone recorder layout
with its documented `safe center` reasoning, the 44px hit-area work (including
the clever `.toggle::after` expansion), and the colour tokens with their measured
ratios.

---

## Phase 4 — Features

In the order `docs/v2-plan.md` §4 argues for, which is the right order.

### 4.1 Personal vocabulary

A textarea of names, jargon and abbreviations, passed as the Whisper `prompt`
parameter. The V2 plan calls this the highest-value feature and it is: dictation
apps live or die on proper nouns, and this is one setting plus one form field in
`worker/src/groq/gateway.ts:57-66`.

Server-synced — the one piece of user data worth storing. Add a `vocabulary`
column to `users`, a `PATCH /v1/me`, and a length cap in `src/shared/limits.ts`.

Validate server-side, and keep it out of the chat prompts. The transcription
`prompt` parameter is a biasing hint, not an instruction channel, and the
`JSON.stringify` framing in `src/shared/prompts.ts:35-46` must keep covering
everything that reaches the chat model.

### 4.2 Rewrite preset chips

Three or four saved instructions — "Tighten it up", "Bullet points", "Formal
email", "Translate to English" — as one-tap chips above the free-text field. No
new backend capability; they post the same `instruction` the textarea does.
Design already specified at `docs/design-recommendations.md:43`.

### 4.3 Share, and finish the manifest

- `navigator.share` beside Copy, falling back to Copy where unavailable. Reuse the
  `ClipboardResult` status shape for symmetry.
- `src/public/manifest.webmanifest` is 35 lines and missing `id`, `scope`, `lang`,
  `dir`, `orientation`, `shortcuts` and `screenshots`. Add `id` **before**
  anything ever changes `start_url` — install identity keys on `start_url` today,
  so changing it later orphans every existing install. `shortcuts` gives a
  long-press "New dictation"; `screenshots` upgrades Android's install
  mini-infobar to the rich dialog.
- Fix the theme-colour mismatch: the manifest says `#f7f6f2`, `index.css:10` says
  `#f8f5ef`, so the splash and task-switcher card are a slightly different cream
  than the app.

### 4.4 Opt-in on-device history

Off by default. Last N transcripts in the Phase 2 IndexedDB store, device-only,
never synced, one-tap clear, and a visible indicator in Settings when it is on.
The honest use case, from the V2 plan: *"I copied it, the target app crashed, my
words are gone."*

This is the one feature in tension with the no-history identity, so the defaults
carry the identity: off unless asked for, purgeable in one tap, never a feed and
never a search surface. If it starts growing an editing UI it has become a
different product — cut it.

---

## Phase 5 — Proof and ops

The tests that exist are good — real `workerd` against real D1 with migrations
applied per file, hand-rolled fakes, injected `fetch`, and assertions aimed at
genuine invariants. The gaps are structural.

- **Zero React component tests.** `@testing-library/react` is not even a
  dependency, and every Phase 0 bug lives in that untested layer. Cover
  `RecorderScreen`, `SettingsScreen`, `SignInScreen` and `App`.
- **One Playwright E2E happy path** — record (mocked mic) → transcribe (mocked
  backend) → copy, against real build output. `docs/v2-plan.md:94` calls it *"the
  single highest-value test you can add"*, and it is what finally ticks the four
  manual boxes still open at `task_list.md:196, 235, 237`.
- **Untested Worker logic that matters:** `GroqGateway.send`'s
  retry/backoff/timeout (every existing test uses `mockResolvedValue`, which never
  retries — so the most complex logic in the Worker is entirely unexercised),
  `readDuration`'s fallback paths, and concurrent magic-link redemption. The spend
  race is tested that way at `quota.test.ts:120-134`; the token race is not.
- **An exhaustiveness test over `AdapterErrorCode`.** Three of 21 codes —
  `empty-transcript`, `clipboard-unavailable`, `clipboard-denied` — fall through
  `messageForError` to the raw adapter message today. A five-line table test
  catches all three and every future one.
- **Wire `scripts/smoke.mjs` into `deploy-worker.yml` as a post-deploy gate.** It
  exists, takes a `baseUrl`, and runs in no workflow. It needs a read-only subset
  first: today it pushes 26 MB and triggers a real Resend send.
- **Add a staging environment** (`docs/v2-plan.md:92`). `wrangler.jsonc` has no
  `env` blocks, so the committed file *is* production and there is nothing between
  a workflow dispatch and rabblebabble.cc.
- **Supply chain:** an `npm audit` step, Dependabot, and both a ref restriction
  and an `environment:` block on `deploy-worker.yml`. The Cloudflare token is a
  plain repo secret with no protection rules, and the dispatch UI will deploy any
  branch straight to production.
- **Type-aware ESLint.** `eslint.config.js:10-11` uses `recommended`, not
  `recommendedTypeChecked`, so `no-floating-promises` and `no-misused-promises`
  are off in a codebase full of `AbortController`s, wake locks and D1 calls.
- **Cloudflare-native observability:** Logpush plus an alert on
  `magic-link-send-failed` and `[startup]` lines, and a weekly usage summary from
  the counters already in `usage_daily`. No third-party processor — it would mean
  a new `connect-src` exception in a policy whose tightness is the point.
- A bundle-size budget on the 242 KB single chunk, and `React.lazy` for
  `SettingsScreen` and `SignInScreen`, which first paint does not need.

---

## Phase 6 — iOS: make the microphone openable

Not a port. One bug, three consequences, and some honest copy.

### 6.1 The gesture is lost before `getUserMedia` is reached

Reported symptom: "on iOS the microphone seems blocked by default." It almost
certainly is not. Safari prompts on first request; what happens here is that
Safari refuses *before* prompting, and throws `NotAllowedError` — the identical
error a real denial produces. `MediaRecorderAdapter.ts:392-397` maps that to
`mic-denied`, and `errorMessages.ts:32-36` then tells an iPhone user to *"allow
microphone access for this site in Chrome"*. They check, find nothing blocked,
retry, and fail the same way. That loop is indistinguishable from a default
denial, which is why it gets reported as one.

WebKit gates the microphone prompt on a live user activation, and activation does
not reliably survive `await` boundaries. There are three between the tap and the
request:

```
onClick → useDictation.start()            setError(null)
        → await flow.start()              #1
        → await inference.ensureReady()   #2   dictationFlow.ts:42
        → await recorder.start()          #3
        → getUserMedia()                       MediaRecorderAdapter.ts:85
```

This is the same hazard `architecture.md` §4.4 already records for the clipboard
— *"Both attempts must originate from the Copy button's user gesture"* — applied
to the microphone, where it was never enforced.

**Fix, without giving up the invariant that matters.** `ensureReady()` is awaited
before the mic on purpose, so a dead session costs the user no speech
(`architecture.md` §4.5). But it performs no network I/O: it is a synchronous
check wearing an async signature. Make it synchronous (`isReady(): boolean` on
the `InferenceClient` port), and call `getUserMedia` in the same turn as the tap.
Both invariants then hold — no wasted speech, no lost gesture — and Android is
unaffected.

Add boundary rule 11 to `architecture.md` §3: *nothing may be awaited between a
user gesture and the browser API that gesture authorises.* It has now cost two
bugs.

### 6.2 The level meter stays dead even once the mic opens

On iOS an `AudioContext` created outside a user gesture starts `suspended` and
never produces samples, so `getByteTimeDomainData` returns a flat line.
`attachLevelAnalyser()` (`MediaRecorderAdapter.ts:126-149`) runs after all the
awaits above. Call `context.resume()` and tolerate rejection — the analyser is
already explicitly an enhancement that must not break recording.

This also matters for §2's silence detection, which reads the same analyser: on
iOS it would otherwise report permanent silence and warn on every recording.

### 6.3 Platform-aware permission recovery

Once genuinely denied, iOS never re-prompts, and there is no programmatic way to
ask again — the user must use Safari's **aA** menu → Website Settings →
Microphone, or Settings → Safari → Microphone.

- Make the `mic-denied` and `mic-unavailable` copy platform-aware instead of
  naming Chrome. Keep it in `errorMessages.ts` as one table; do not scatter
  `navigator.userAgent` checks through the UI.
- Distinguish "never asked" from "actively denied" where the platform allows it,
  and **feature-detect `navigator.permissions.query({ name: "microphone" })`** —
  it is not reliably supported in Safari, so that path must degrade silently
  rather than throw.

### 6.4 Latent format default

`MediaRecorderAdapter.ts:269` falls back to `"audio/webm"` when both the
recorder's own `mimeType` and the negotiated type are empty. On iOS that labels
MPEG-4 bytes as WebM and Groq rejects them. It should not trigger today —
`mimeNegotiation.ts` already falls back `webm → mp4`, the Worker allows
`audio/mp4` (`upload.ts:7`) and `audioFilename` maps it correctly — but the
default is Android-shaped. Derive it from the negotiated type or fail loudly.

### What this phase does not commit to

No iOS design work, no Safari-specific layout, no promise about the
installed-to-Home-Screen experience. Worth knowing while testing: an iOS
home-screen web app is a **separate permission context from Safari**, so granting
in Safari does not carry over, and microphone support in standalone mode has a
history of regressions. Verify on a device; if standalone is broken on current
iOS, say so in the README rather than fixing it here.

---

## Docs to reconcile

- `architecture.md` is marked normative but is still titled *"v1 Architecture"*,
  and §4.5 specifies the superseded `GroqClient`-with-`apiKey` contract directly
  below a note saying the port is now `InferenceClient`. A normative document that
  disagrees with the code is worse than none.
- The persistence promise in `README.md` and `architecture.md` changes with Phase
  2 — wording above.
- `README.md:76` says "18 end-to-end checks"; `scripts/smoke.mjs` has 16.
- Delete the merged `v2-backend` and `v2-design` branches.

---

## Sequencing

| Phase | Why here |
|---|---|
| 0 | Bugs in production, and 0.1 blocks everything about durability |
| 6.1 | Changes the `InferenceClient` port (`ensureReady` → `isReady`). Do it while Phase 0 is already in that code, not after Phases 2–4 have built on the old signature |
| 1.1–1.4 | Small, high-value, independent security fixes |
| 2 | The durability layer Phase 0 needs to survive a reload |
| 6.2–6.4 | Ride along with §2's analyser and interruption work — same file, same tests |
| 1.5–1.12 | The rest of the hardening; none of it blocking |
| 3 | Tokens before feature UI lands on top of them |
| 4 | Features, in the V2 plan's order |
| 5 | Alongside from the start |

Phase 5's component tests get written *with* Phase 0, not after it. The Phase 0
bugs exist precisely because that layer has no tests at all.

---

## Verification

Per fix, at the boundary that would have caught it:

- **0.1** — `adapter.state` becomes `"auto-stopped"` when the duration timer fires
  *without* any `stop()` call, and the recording is still retrievable afterwards.
- **0.2** — Transcription throws; `flow.retryUpload()` then succeeds without
  re-recording.
- **0.3** — Load the sign-in screen and confirm the sent-card has a border and the
  right radius.
- **0.4** — Build, install, hold a transcript, deploy again; no reload until the
  user accepts.
- **1.1** — `Set-Cookie` shape parity between known and unknown addresses.
- **1.2** — `readConfig` with `EMAIL_MODE=console` and a non-localhost
  `APP_ORIGIN` throws `ConfigError`.
- **1.3** — A Groq response with neither `duration` nor `segments` bills but does
  not suspend.
- **1.6** — `curl -sI http://localhost:8787/` shows `frame-ancestors`, HSTS and
  `Permissions-Policy` on the *asset* path, not just on `/v1/*`.
- **6.1** — A jsdom test asserting `getUserMedia` is called with **no awaited
  promise resolving between** the click handler and the call. This is testable
  without Safari: spy on `getUserMedia`, and assert it ran in the same microtask
  as the handler. That test is what stops the regression coming back, since every
  platform except iOS forgives it.
- **6.2** — Assert `AudioContext.resume()` is attempted, and that a rejected
  `resume()` still leaves recording working.

Per phase:

```
npm run lint && npm run typecheck && npm test
npm run build:service && npm run build:byok   # both mode guards must pass
npm run db:migrate:local && npm run dev:worker
npm run smoke
```

**A real-device pass before release.** Three of the four still-open items in
`task_list.md` are exactly this, and the git history records two sign-in bugs
*"only a real browser could show"*. Install the PWA on Android and run tap →
speak → tap → copy, then exercise a five-minute auto-stop, an airplane-mode
upload failure, an incoming phone call mid-recording, and a deploy while holding
a transcript. Confirm DevTools Application storage holds settings and — only
while in flight — buffered audio, with no transcripts and no API responses in
Cache Storage.

**And now an iPhone**, which is the cost of Phase 6. In Safari: first tap shows
the system microphone prompt; allow it and a recording completes end to end; the
level meter moves rather than flatlining; the produced blob is `audio/mp4` and
the Worker accepts it. Then deny permission deliberately and confirm the error
names Safari's Website Settings rather than Chrome. Finally add it to the Home
Screen and repeat — the permission will be requested again, because that is a
separate context, and if standalone mode cannot open the microphone at all on
current iOS, record that in the README instead of trying to fix it.
