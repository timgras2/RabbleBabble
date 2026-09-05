# RabbleBabble

RabbleBabble is a small Android PWA for cloud speech-to-text dictation.
Record, get a clean transcript, copy it. That is the whole product.

## Two builds, one source tree

V2 ships in two modes from the same code. The mode is a required `--mode` flag,
so a build that does not say which it is fails rather than guessing.

| | **service** | **byok** |
|---|---|---|
| Who holds the Groq key | You do, in a Cloudflare Worker | Each user, in their own browser |
| Sign-in | Magic link by email | None |
| Runs on | One Worker serving the app and the API | GitHub Pages, no infrastructure |
| Build | `npm run build:service` | `npm run build:byok` |

The service build must contain no code path that sends audio to Groq with a
user-supplied key, and the bring-your-own-key build must contain no auth code.
That is not left to tree-shaking: `scripts/check-build-mode.mjs` runs as part of
both builds and fails if either leaks into the other.

## Scope

- Android 10+ and current Android Chrome
- Groq Whisper transcription, optional cleanup, typed rewrite instructions
- Explicit copy action
- No transcript history, no cloud storage, no local inference, no Electron

**Out of scope for V2**, and deliberately so: transcript cloud storage or sync,
teams and sharing between users, model selection UI, chat with your transcript,
an editing suite, iOS-specific work, local inference. Each is a different
product.

## Privacy

Audio and transcripts are never persisted server-side. The Worker is a
pass-through proxy, not a data store: it keeps an email address, a session
hash, and numeric usage counters, nothing else. In the bring-your-own-key
build the browser talks to Groq directly and the key stays in `localStorage` on
that device.

## Development

### The PWA

```text
npm install
npm run dev          # service mode, expects a Worker on the same origin
npm run dev:byok     # bring-your-own-key mode, talks to Groq directly
```

The Vite root is `src/`, while npm configuration stays at the repository root.
The dev server listens on port `5174` over HTTPS with a generated certificate,
which Android needs for microphone access on a LAN address.

### The Worker

```text
cp .dev.vars.example .dev.vars   # then fill in GROQ_API_KEY and IP_HASH_PEPPER
npm run db:migrate:local
npm run build:service            # wrangler serves ./dist as static assets
npm run dev:worker               # http://localhost:8787
```

`EMAIL_MODE=console` (the default in `wrangler.jsonc`) prints the sign-in link
to the console and returns it in the response, so the whole flow works before a
sending domain is verified.

```text
npm run invite:new               # mint an invite code
npm run smoke                    # 18 end-to-end checks against the running Worker
```

### Tests

```text
npm test            # both projects
npm run test:app    # browser code, jsdom
npm run test:worker # Worker code, real workerd against a real D1
```

Worker tests run in `workerd` with migrations applied per test file, so quota
arithmetic and single-use-token behaviour are proven against SQLite rather than
against a mock that agrees with whatever the code happens to do.

## Deploying

### First time

1. `npx wrangler d1 create rabblebabble`, then put the returned id into
   `wrangler.jsonc`.
2. Set the secrets: `npx wrangler secret put GROQ_API_KEY`, then
   `RESEND_API_KEY` and `IP_HASH_PEPPER` the same way.
3. Point `APP_ORIGIN` at the deployed origin and set `EMAIL_MODE=resend` with a
   real `EMAIL_FROM` once a domain is verified in Resend.
4. `npm run db:migrate` then `npm run deploy`.

**Resend will only deliver to addresses other than your own account's once you
have verified a sending domain** (SPF and DKIM DNS records). Until then, run
with `EMAIL_MODE=console` and hand people the link yourself.

The app and the API must stay on one origin. That is what keeps the session
cookie first-party, removes CORS, and lets the build-time CSP stay at
`connect-src 'self'`.

### Ongoing

- `.github/workflows/ci.yml` gates every pull request on lint, typecheck, tests
  and both builds.
- `.github/workflows/deploy-worker.yml` deploys on manual dispatch, applying D1
  migrations first.
- `.github/workflows/deploy-pages.yml` publishes the bring-your-own-key build to
  `https://timgras2.github.io/RabbleBabble/`.

## Project documents

- `plan.md` - V1 product scope and decisions
- `architecture.md` - runtime boundaries and contracts (normative)
- `docs/v2-plan.md` - the multi-user plan this backend implements
- `task_list.md` - sequential implementation tasks

Basic interface icons use [Lucide](https://lucide.dev/), an ISC-licensed
open-source icon pack. The app mark is a small custom microphone icon generated
for the PWA at 192px and 512px.

## License

MIT. See `LICENSE`.
