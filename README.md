# Desk API Config Manager

Windows desktop app for managing LLM API configuration safely.

The product manages provider presets, Base URLs, API keys, model names, environment labels, test results, and developer snippets for cloud and local LLM APIs.

## Current Status

The project is in milestone M1. The Electron + React + TypeScript skeleton is in place, including the first static workbench UI, build scripts, dependency lockfile, and a basic unit test.

Before each development session, read:

- [docs/DEVELOPMENT_PROGRESS.md](docs/DEVELOPMENT_PROGRESS.md)
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)

## Core Direction

- Local-first: configuration and secrets stay on the local machine by default.
- Security-first: API keys must not be stored in plaintext, exported by default, or printed in logs.
- Multi-provider: OpenAI, Azure OpenAI, Anthropic, Gemini, DeepSeek, Qwen, Zhipu, Ollama, LM Studio, and OpenAI-compatible services.
- Developer-friendly: generate `.env`, PowerShell, CMD, curl, Python, and Node.js snippets.

## Local Development

Install dependencies:

```powershell
npm install --cache .npm-cache
```

If the Electron binary download fails, install it with a mirror:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npx install-electron --no
```

Verify:

```powershell
npm run build
npm test
```

Start desktop development mode:

```powershell
npm run dev
```

