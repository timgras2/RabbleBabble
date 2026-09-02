# RabbleBabble

RabbleBabble is a small Android PWA for cloud speech-to-text dictation.

## V1 Scope

- Android 10+ and current Android Chrome
- Groq Whisper transcription
- Optional Groq text cleanup
- Typed instructions for rewriting the current transcript
- Explicit copy action
- One trusted user per device
- No accounts, history, backend, local inference, or Electron

The browser API key is intentionally stored in localStorage for this trusted-device V1.
Transcripts and rewrite instructions are sent to Groq only when processing is requested and
are not stored by the app. Do not use a production key in source code, environment variables,
logs, or commits.

## Build Plan

Read these documents before changing the project:

- `plan.md` - product scope and decisions
- `architecture.md` - runtime boundaries and contracts
- `task_list.md` - sequential implementation tasks

The implementation starts from an empty PWA source tree. Do not copy the legacy
Electron or Kotlin application into this repository.

## Target Deployment

- Production: `https://timgras2.github.io/RabbleBabble/`
- Android LAN development: `https://<LAN-IP>:5174/`

## Development

Install dependencies and start the HTTPS LAN server:

```text
npm install
npm run dev
```

The Vite root is `src/`, while npm configuration stays at the repository root. The
development server listens on port `5174` and accepts Vite's generated certificate.

Basic interface icons use [Lucide](https://lucide.dev/), an ISC-licensed open-source icon
pack. The app mark is a small custom microphone icon generated for the PWA at 192px and
512px.

## GitHub Pages

The `main` branch deploys automatically through `.github/workflows/deploy-pages.yml`.
Enable **Settings → Pages → Source → GitHub Actions** once, then push to `main`. The app
will be available at:

`https://timgras2.github.io/RabbleBabble/`

## License

MIT. See `LICENSE`.
