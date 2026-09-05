# RabbleBabble — Code Review & Recommendations

**Repo:** `timgras2/RabbleBabble` (main, reviewed 2026-09-03)
**Scope:** Full source review — architecture, dependencies, CI/CD, network layer, security, PWA configuration.

## Overall assessment

For a V1 hobby project, this codebase is unusually disciplined. The ports-and-adapters architecture is applied consistently: platform concerns (audio, clipboard, inference, storage) sit behind small interfaces, a dedicated `DictationFlowService` owns the state machine, and the UI talks only to `AppServices`. Adapters and the flow service have real unit tests. The rewrite prompt wraps the transcript in JSON and instructs the model to treat it as data — a prompt-injection mitigation most small projects miss. The README is honest about the localStorage API-key trade-off.

The weaknesses are not in the core design but at the edges: dependency hygiene, CI gates, and network robustness under real mobile conditions.

## Recommendations (in priority order)

### 1. Replace `"latest"` dependency versions with semver ranges — HIGH

All 16 dependencies in `package.json` are pinned to `"latest"`. The lockfile protects CI (`npm ci`), but any fresh `npm install` — a new machine, a contributor, a lockfile regeneration — can silently jump major versions and break the build.

**Fix:** Pin to caret ranges matching the current lockfile, e.g.:

```json
"react": "^19.0.0",
"vite": "^6.0.0",
"typescript": "~5.7.0"
```

Optionally add Dependabot or Renovate for controlled updates.

### 2. Add lint + test gates to the deploy workflow — HIGH

`.github/workflows/deploy-pages.yml` builds and deploys straight to production on every push to `main`. The test suite exists but is never run in CI.

**Fix:** Add to the build job, before `npm run build`:

```yaml
- name: Lint
  run: npm run lint
- name: Test
  run: npm test
```

Consider a separate PR workflow so broken changes are caught before merge, not after.

### 3. Rework timeout and retry strategy for transcription — HIGH

`groqClient.ts` uses a single 30-second timeout (`DEFAULT_TIMEOUT_MS`) for all requests. A near-25 MB audio upload plus Whisper processing on a mobile connection will regularly exceed this. Worse, the retry loop (`MAX_ATTEMPTS = 3`) re-uploads the entire blob immediately on timeout, with no backoff — a slow connection triggers three full uploads back-to-back.

**Fix:**
- Give `transcribe` its own timeout (60–120 s); keep 30 s for chat completions.
- Add exponential backoff between attempts (e.g. 1 s, 2 s, 4 s).
- Consider not auto-retrying large uploads on timeout at all — surface a retry button instead, so the user decides on a metered connection.

### 4. Rename the leftover `openwhispr.settings` storage key — MEDIUM

`localStorageSettings.ts` defines `SETTINGS_STORAGE_KEY = "openwhispr.settings"` — residual branding from a different project. Renaming naively would wipe existing users' saved key and settings.

**Fix:** Rename to `rabblebabble.settings` with a one-time migration in `read()`: if the new key is absent but the old one exists, copy it over and remove the old entry.

### 5. Add a Content-Security-Policy — MEDIUM

Storing the API key in localStorage is a documented, acceptable trade-off for a single-trusted-user app — but it makes XSS the one attack that matters, since any injected script can read the key. There is currently no CSP.

**Fix:** Add a strict CSP meta tag to `src/index.html`, roughly:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; connect-src 'self' https://api.groq.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'">
```

Tighten `style-src` if the build output allows it. With only three runtime dependencies the supply-chain surface is small, but a CSP is cheap insurance.

### 6. Pass a timeslice to `MediaRecorder.start()` — LOW

`MediaRecorderAdapter` calls `start()` without a timeslice, so audio data is only delivered when recording stops. If Android kills the tab mid-recording (memory pressure is common on the target platform), the entire recording is lost.

**Fix:** `this.mediaRecorder.start(10_000)` delivers chunks every 10 s. This also enables enforcing the 25 MB limit *during* recording instead of only at stop, so the user finds out before speaking for five minutes.

### 7. Minor polish — LOW

- **Workbox config:** the two `runtimeCaching` entries for `api.groq.com` (default GET matcher + explicit POST) look like an accidental duplicate. Add a comment explaining the GET/POST split, or a reviewer will "fix" it.
- **Manifest icons:** `"purpose": "any maskable"` combined in one entry is discouraged — maskable icons get cropped when used as `any`. Split into separate `any` and `maskable` entries (the maskable variant needs safe-zone padding).
- **`useDictation` result reads:** `flow.result` is read outside the `useSyncExternalStore` snapshot. It works today because every result change is accompanied by a state change, but it's fragile — include the result in the subscribed snapshot or document the invariant.
- **Recording feedback:** with a hard five-minute cap, consider showing elapsed time while recording so users aren't surprised by the auto-stop.

## What to keep as-is

- The architecture and dependency-injection setup — don't add a framework or state library; the current scale doesn't need it.
- The prompt-injection handling in `rewrite` — good as designed.
- The explicit-copy, no-history privacy model — a genuine feature for a dictation tool.
- The honest README security note — rare and valuable.

## Suggested order of work

1 and 2 are an hour of work combined and remove the two most likely ways this project breaks. 3 fixes the most likely real-world user failure (mobile timeout). 4–6 are each small, self-contained changes. Item 7 is opportunistic.
