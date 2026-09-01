# RabbleBabble

RabbleBabble is a small Android PWA for cloud speech-to-text dictation.

## V1 Scope

- Android 10+ and current Android Chrome
- Groq Whisper transcription
- Optional Groq text cleanup
- Explicit copy action
- One trusted user per device
- No accounts, history, backend, local inference, or Electron

The browser API key is intentionally stored in localStorage for this trusted-device V1.
Do not use a production key in source code, environment variables, logs, or commits.

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

## License

MIT. See `LICENSE`.
