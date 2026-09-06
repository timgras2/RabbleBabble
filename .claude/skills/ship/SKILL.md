---
name: ship
description: Commit everything in the working tree and deploy RabbleBabble to the right remotes automatically — GitHub Pages (BYOK build) and the Cloudflare Worker (service build, staging then production). Routes each change to the environments it actually affects without being told which. Use when asked to ship, release, deploy, push live, or "commit and deploy".
---

# Ship RabbleBabble

One repo builds two different apps from the same source, and they live in
different places:

| App | Build | Where it runs | How it ships |
| --- | --- | --- | --- |
| **BYOK** — user brings their own API key, no accounts | `build:byok` | GitHub Pages, `https://timgras2.github.io/RabbleBabble/` | automatic on every push to `main` (`deploy-pages.yml`) |
| **Service** — magic-link sign-in, user management, D1 | `build:service` | Cloudflare Worker staging, `rabblebabble-staging.rabblebabble.workers.dev` | `npm run deploy:staging` from this machine |
| **Service** — the same, with real users | `build:service` | Cloudflare Worker production, `https://rabblebabble.cc` | `npm run deploy` from this machine |

**The user should never have to name a target.** Work out from the diff which
of these a change reaches, ship those, and say what you did. The only thing you
ask about is the last hop to production.

## Deploy the Worker locally, not through Actions

`.github/workflows/deploy-worker.yml` exists but **has never successfully
run**. It reads `secrets.CLOUDFLARE_API_TOKEN`, and no such secret exists —
not as a repo secret, not on any environment. Every Worker deploy this project
has ever had, `rabblebabble.cc` included, came from `wrangler` on this machine
using local credentials.

So use `npm run deploy:staging` and `npm run deploy`. Do not dispatch
`deploy-worker.yml`; it will fail at "Apply D1 migrations" before deploying
anything. Because those npm scripts skip the gates the workflow would have
run, this skill runs them itself — tests before, migrations and smoke after.

Two related traps, if the workflow ever comes up:

- Dispatching it **auto-creates a GitHub environment with no protection
  rules**. The "required reviewer" that `deploy-worker.yml:34` describes is not
  actually configured, so a production dispatch would sail straight through
  ungated.
- Fixing this properly means creating a Cloudflare API token (Workers Scripts:
  Edit + D1: Edit), adding it to both environments, and giving `production` a
  required reviewer. That is the user's job — never handle the token yourself.

## 1. Survey, then commit everything

```bash
git status --porcelain && git diff --stat && git log --oneline origin/main..HEAD
```

The point of `/ship` is that nothing is left behind, so stage the whole tree
(`git add -A`) unless the user scoped it. Before you do:

- **Never stage a secret.** `.dev.vars`, `.env*` and `.wrangler/` are
  gitignored — if one of them, or an unfamiliar credential-shaped file, appears
  in `git status`, stop and ask.
- Read the diff of anything you did not write yourself in this session.
- If `wrangler.jsonc` changed, say **which environment block** it touched.
  Edits inside `env.staging` cannot affect production; edits at the top level
  do. Report this either way — that file *is* production config.
- If `worker/migrations/` gained a file, flag it loudly. Migrations are applied
  to the real D1 before the new code serves, and **D1 migrations do not roll
  back**.

## 2. Route the change

Decide from the changed paths which apps are affected:

| Changed path | BYOK / Pages | Service / Worker |
| --- | --- | --- |
| `src/` (shared app source) | yes | yes |
| `worker/` | no | yes |
| `worker/migrations/` | no | yes, **+ D1 migration** |
| `wrangler.jsonc` | no | yes |
| `scripts/`, tests, configs, docs, `.claude/` | no | no |

Pages rebuilds on every push regardless, so it always ships. The Worker only
needs a deploy when the right column says yes. If a change is docs-only, push
it and say plainly that no Worker deploy was needed — do not deploy for the
sake of it.

## 3. Gate locally

```bash
npm run lint && npm run typecheck && npm test
```

If any fail, fix them or report and stop. Do not commit past a red suite
without the user saying to.

## 4. Commit and push — this ships BYOK to Pages

Commit in the repo's style: conventional prefix, scope where one fits,
lowercase imperative subject, and a body explaining *why*. See `git log` for
the register.

```
fix(worker): stop the pessimistic reservation eating the allowance
```

End the message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Then `git push origin main`, and watch the Pages build:

```bash
gh run watch $(gh run list --workflow=deploy-pages.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

## 5. Deploy the service build to staging

Only if step 2 said the Worker is affected. Migrations first, then deploy,
then prove it answers. Hand these to the user the same way step 6b does if the
permission mode blocks them:

```bash
npm run db:migrate:staging
```

```bash
npm run deploy:staging
```

```bash
node scripts/smoke.mjs https://rabblebabble-staging.rabblebabble.workers.dev --read-only
```

A clean smoke run is what makes staging "green". If it fails, stop here and
report — do not carry a broken build to production.

## 6. Production — establish the real diff first

**Never describe a production deploy from this session's commits.** The Worker
is deployed by hand, so production can be arbitrarily far behind `main` — and
has been: a `/ship` run once found it 19 commits and an unapplied migration
behind while the session had produced only two. Reporting "shipping the quota
fix" would have been true and badly misleading, because a feature release and a
schema change were riding along unmentioned.

So always start here, and read the output before saying anything. Both are
read-only and permitted:

```bash
npx wrangler deployments status
```

```bash
npx wrangler d1 migrations list rabblebabble --remote
```

Take the active deployment's timestamp and list every commit newer than it —
that, not `origin/main..HEAD`, is what is going out:

```bash
git log --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format="%h %cd %s" -40
```

Compare in **UTC**. Commit timestamps carry a local offset and the deployment
timestamp does not; mixing them silently misclassifies commits.

Then ask the user a single yes/no in chat and wait for a clear answer, naming:

- every commit going out, in behavioural terms — not just this session's
- whether any top-level `wrangler.jsonc` change alters production config, and
  which values move (hostnames, `EMAIL_MODE`, session TTL and quotas have all
  changed in a single deploy before)
- exactly which migrations `d1 migrations list` reported pending
- that gates and staging smoke are green

## 6b. Hand the production commands to the user

**Do not run the production commands yourself.** In this project's permission
mode the auto-mode classifier blocks `npm run db:migrate` and `npm run deploy`,
and the bare `wrangler` equivalents too. Attempting them wastes a turn and can
half-complete a release.

On a clear yes, print exactly these, in order, each in its own block, and ask
the user to paste back the smoke output:

```bash
npm run db:migrate
```

```bash
npm run deploy
```

```bash
npm run smoke:prod
```

Include `db:migrate` **only** when `d1 migrations list` reported something
pending. It must go first: the code expects the new schema, so deploying ahead
of the migration breaks production.

Then verify from here — these reads are permitted:

```bash
npx wrangler deployments status && npx wrangler d1 migrations list rabblebabble --remote
```

A changed deployment id plus "No migrations to apply!" is what proves it
landed. On anything short of a clear yes, stop and leave production alone.

## 7. Report

A few lines: commit SHA and subject; the Pages run result; the staging deploy
and smoke result; the production deployment id **before and after**, the full
set of commits it carried, and any migration applied, naming the database. Link
runs as full GitHub URLs under `timgras2/RabbleBabble`.

Say plainly what smoke did **not** cover: `--read-only` skips the 26 MB upload
and the sign-in flow, so it will not trigger a real Resend send on every
deploy. If the deploy changed `EMAIL_MODE` or `APP_ORIGIN`, recommend one real
magic-link sign-in by hand, because nothing automated touched that path.

## Notes

- The user can lift the production block by adding Bash permission rules for
  `npm run db:migrate` and `npm run deploy` in `.claude/settings.json`. Until
  they do, hand the commands off — do not retry them.
- If `gh` is not authenticated (`gh auth status`), Pages still deploys on push
  — you just cannot watch the run. Say so rather than treating it as a failure.
- Network egress may be blocked in some sandboxes; a failed `curl` to
  `rabblebabble.cc` is not evidence that production is down. Judge from the
  smoke script's output, run locally.
