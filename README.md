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

`npm run dev:worker` overrides two of the deployed vars with `--var`: it points
`APP_ORIGIN` at `localhost:8787` so the same-site guard accepts local requests,
and forces `EMAIL_MODE=console`, which prints the sign-in link to the console
and returns it in the response instead of sending mail. No Resend key is needed
and none can be used by accident. To exercise real sending on purpose, use
`npm run dev:worker:mail`, which keeps the local origin but sends through
Resend.

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

The committed `wrangler.jsonc` **is** production: `wrangler deploy` runs with no
`--env`, so whatever is in that file is what ships. It currently deploys to
`https://rabblebabble.cc`, sending mail through Resend from
`login@send.rabblebabble.cc`.

### First time

1. `npx wrangler d1 create rabblebabble`, then put the returned id into
   `wrangler.jsonc`.
2. **Verify the sending domain in Resend before anything else.** Add
   `send.rabblebabble.cc`, pick a region (permanent), and copy the DNS records
   Resend shows into the Cloudflare zone. Two Cloudflare-specific traps: enter
   names without the zone suffix (`resend._domainkey.send`, not
   `resend._domainkey.send.rabblebabble.cc`), and set every record to **DNS
   only**, since a proxied record fails Resend's check with error 1004.
3. Add DMARC on the root: TXT `_dmarc` = `v=DMARC1; p=none;
   rua=mailto:dmarc@rabblebabble.cc;`. Start at `p=none`; tighten only once
   reports show mail passing.
4. Set the secrets: `npx wrangler secret put GROQ_API_KEY`, then
   `RESEND_API_KEY` and `IP_HASH_PEPPER` the same way. Scope the Resend key to
   sending access on `send.rabblebabble.cc`.
5. Add the custom domain in the Cloudflare dashboard (Workers & Pages →
   rabblebabble → Domains & Routes) and confirm it resolves. The `routes` block
   in `wrangler.jsonc` then keeps it, but the first attachment needs an API
   token carrying `Zone:DNS:Edit` and `Workers Routes:Edit`.
6. `npm run db:migrate` then `npm run deploy`.

**Do not deploy with `EMAIL_MODE=resend` before step 2 completes.** Resend will
only deliver to addresses other than your own account's once a sending domain
is verified. Until then every send fails, `auth/routes.ts` swallows the error by
design so it cannot leak account existence, and the API still answers
`202 {"status":"sent"}` — a misconfiguration that looks exactly like success.
`npx wrangler tail` is where it shows: a `magic-link-send-failed` line carrying
Resend's error name instead of an `email-sent` line carrying a message id.

The app and the API must stay on one origin. That is what keeps the session
cookie first-party, removes CORS, and lets the build-time CSP stay at
`connect-src 'self'`. `workers_dev` is off for the same reason: a second
hostname would serve a copy whose sign-in cannot work.

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
