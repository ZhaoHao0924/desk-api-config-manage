# Project Plan

Last updated: 2026-07-09

## 1. Product Positioning

Desk API Config Manager is a Windows desktop app for managing LLM API configuration. It centralizes provider presets, Base URLs, API keys, model names, proxy settings, custom headers, connection test results, and exportable developer templates.

Primary value:

- Avoid scattering API keys across `.env` files, notes, chat logs, and project-specific config.
- Store sensitive values safely on the local machine.
- Quickly verify whether a provider, model, key, or proxy works.
- Generate common configuration snippets without manual copy errors.
- Share team templates without leaking secrets.

## 2. Target Users

- Individual AI application developers
- Small engineering teams
- Developers using multiple LLM providers
- Users managing local models, proxy services, and cloud models together

## 3. Current Technical Route

Current machine state:

- Node.js is available: `v24.11.1`
- npm is available: `11.6.2`
- .NET SDK is not installed
- Rust is not installed

Chosen implementation route:

- Desktop shell: Electron
- UI: React + TypeScript
- Build tool: Vite
- Local storage: storage abstraction first, then SQLite or a JSON repository bridge for MVP if needed
- Secret encryption: Electron `safeStorage`, which uses OS-backed protection on Windows
- IPC: Electron IPC through a restricted preload API
- Tests: Vitest first, Playwright later for UI flows
- Packaging: electron-builder or Electron Forge later

If the user later requires a native Windows stack and installs .NET, reassess `.NET 8 + WinUI 3`.

## 4. MVP Scope

### 4.1 Configuration Management

- Create, edit, delete API configurations
- Configuration list, detail panel, and search
- Fields: name, provider, Base URL, API Key, default model, environment, tags, notes, enabled state

### 4.2 Secure Storage

- Encrypt API keys before writing to disk
- Mask keys by default
- Require explicit action to reveal or copy full keys
- Never log full keys or full sensitive headers

### 4.3 OpenAI-compatible Connection Test

- Test chat completion requests with Base URL, API Key, and model
- Record success, failure, latency, error code, and readable error summary
- Translate common errors such as 401, 404, 429, and timeout

### 4.4 Snippet Generation

- `.env`
- PowerShell
- CMD
- curl
- Python OpenAI SDK
- Node.js OpenAI SDK
- Claude Code configuration
- Codex configuration
- CodeBuddy `models.json` configuration

### 4.5 Import And Export

- Export JSON templates without secrets
- Import JSON templates
- Mark configurations that are missing secrets

## 5. Later Scope

Phase 2:

- Additional provider presets beyond the current built-ins, such as Azure OpenAI, DeepSeek, Qwen, Zhipu, Moonshot, MiniMax, Ollama, and LM Studio
- Custom headers
- Proxy configuration
- Batch testing
- Test history
- Model list fetching
- Encrypted full backup and restore

Phase 3:

- Tray menu quick copy
- Windows Credential Manager evaluation
- Auto update
- Local template library
- Audit trail
- Team template sharing
- Main password or Windows Hello unlock

## 6. UI Plan

Use a practical desktop tool layout, not a landing page.

Main shell:

- Top bar: search, create, import, export, settings
- Left side: provider, group, tag, and environment filters
- Middle: configuration list
- Right side: details, test status, snippet preview, and actions
- Bottom or drawer later: test logs and error details

Design principles:

- Sensitive fields are masked by default.
- Status always has text and an icon, not color alone.
- The interface should be dense enough for daily use.
- Controls should not resize or jump when model names or errors are long.

## 7. Data Model

### ApiProvider

- id
- name
- type
- defaultBaseUrl
- authType
- isBuiltIn
- capabilities
- createdAt
- updatedAt

### ApiConfig

- id
- name
- providerId
- baseUrl
- encryptedApiKey
- defaultModel
- apiVersion
- organizationId
- projectId
- timeoutSeconds
- proxyId
- environment
- tags
- notes
- isEnabled
- lastTestStatus
- lastTestAt
- createdAt
- updatedAt

### CustomHeader

- id
- configId
- key
- value
- isSecret

### TestHistory

- id
- configId
- status
- latencyMs
- requestEndpoint
- errorCode
- errorMessage
- testedAt

### ProxyConfig

- id
- name
- type
- host
- port
- username
- encryptedPassword

## 8. Security Rules

- API keys must never be stored in plaintext.
- Exports must omit API keys by default.
- Plaintext export, if implemented later, requires explicit risk confirmation.
- Logs must never include full keys, full Authorization headers, or full sensitive custom headers.
- Clipboard copies of secrets should be cleared after a default delay, such as 30 seconds.
- Test errors must be sanitized before display and logging.
- The preload layer exposes only necessary IPC methods.
- The renderer must not directly access Node.js filesystem or system APIs.

## 9. Milestones

### M0: Project Start

Goal: repository structure, product plan, progress tracking, and technical decision.

Acceptance:

- README exists
- Project plan exists
- Progress tracking exists
- Agent working rules exist

### M1: App Skeleton

Goal: Electron + React + TypeScript desktop app skeleton.

Acceptance:

- Desktop window can be started in an interactive Windows environment
- Basic workbench UI exists
- Local state model and types exist
- Development scripts exist

Current result:

- Skeleton exists
- Static workbench UI exists
- Types and sample data exist
- Build passes
- Unit tests pass
- Electron binary is installed
- Interactive desktop launch still needs manual confirmation

### M2: Local Configuration Management

Goal: configuration CRUD and local persistence.

Acceptance:

- Create, edit, and delete configurations
- Search and filter configurations
- Persist data and restore after restart
- API keys are masked in UI

Current result:

- Repository interfaces exist for providers, configurations, and test history.
- A localStorage JSON repository bridge is implemented for MVP persistence.
- The UI can create, edit, delete, search, and provider-filter configurations.
- A built-in provider model catalog is available and displayed in the detail panel.
- Current built-in providers are Anthropic and OpenAI-compatible. GPT, Gemini, Antigravity placeholder, and Grok model catalog entries are grouped under OpenAI-compatible.
- Create/edit forms can fetch live model ids from the provider API when Base URL and API Key are available, while still allowing manual model input.
- The supported-model panel can display live provider models for configured providers and falls back to built-in defaults when live fetch is unavailable or empty.
- Users can select a provider model and generate Claude Code, Codex, or CodeBuddy configuration snippets.
- API key input is converted to a masked preview only; full plaintext keys are not persisted in M2.
- Build and unit tests pass.

### M3: Secure Storage

Goal: encrypted API key storage and sensitive data masking.

Acceptance:

- API keys are encrypted at rest
- UI masks keys by default
- Logs and errors do not leak keys
- Users can explicitly reveal or copy full keys

Current result:

- Electron IPC handlers use `safeStorage` for API key encryption and decryption.
- The preload layer exposes only restricted secret methods to the renderer.
- `ApiConfig` persists encrypted API key ciphertext in localStorage schema version 3.
- Older M2 masked-only API key previews are migrated to missing-secret state because plaintext cannot be recovered.
- The UI masks keys by default and supports explicit reveal, hide, and copy actions.
- Secret clipboard copies are cleared after 30 seconds when the clipboard still contains the copied key.
- Build and unit tests pass.
- Desktop secure-flow verification has been completed in Electron for encrypted save, reveal, copy, clipboard clearing, and main-process request paths. Repeat manual verification only after related changes.

### M4: Connection Testing

Goal: OpenAI-compatible connection tests.

Acceptance:

- Send a test request
- Show success, failure, latency, and readable error summary
- Record the latest test status

Current result:

- M4 core acceptance is complete.
- An OpenAI-compatible connection test service exists.
- The service builds provider-appropriate requests for OpenAI-compatible and Anthropic providers, handles missing keys, timeout, HTTP failures, and sanitized error messages.
- Latest config status and test history are persisted through the repository abstraction.
- Electron uses main-process connection-test IPC to avoid renderer CORS limits and avoid renderer fetch calls with decrypted keys.
- The UI "test connection" action shows loading and compact success/failure results, then refreshes config status and recent history.
- Test Center can run enabled configurations sequentially with a precomputed plan, skipped-target summaries, stop-before-next behavior, and focused helper coverage.
- Connection-test hardening covers secret redaction, sanitized persisted endpoints/details, renderer and desktop transport sanitization, timeout mapping, missing-key guards, no-auth local-provider paths, and bounded provider error details.
- Unit tests cover successful tests, missing keys, sanitized failures, transport delegation, history persistence, batch execution behavior, and defensive sanitization.
- Real saved-key verification has covered Anthropic and OpenAI-compatible paths, including one low-frequency official OpenAI `auto` Responses success. Remaining forced official OpenAI endpoint-mode checks are optional low-frequency verification, not blockers for M4 closure.

### M5: Snippets And Import/Export

Goal: developer assistance features for the MVP.

Acceptance:

- Generate multiple snippet formats
- Export templates without secrets
- Import templates

Current result:

- Generic config snippets now cover `.env`, PowerShell, CMD, curl, Python OpenAI SDK, and Node.js OpenAI SDK.
- Claude Code, Codex, and CodeBuddy configuration generators exist. CodeBuddy now uses the verified public CodeBuddy Code `models.json` schema and generates `.codebuddy/models.json` with a complete Chat Completions `url` plus environment-variable API key references for compatible providers, while non-compatible native providers use a clear compatible-gateway placeholder.
- Secret-free export/import now covers main API configs, provider templates, provider model catalogs, and route-proxy profiles.
- Imported custom provider templates persist in the localStorage repository, and imported provider model catalogs are saved for known providers.
- Unit tests, production build, and Electron CDP UI smoke for the new snippet tabs, expanded import/export flow, and CodeBuddy `models.json` output pass.

M5 is complete.

### M6: Request Customization And Provider Expansion

Goal: start Phase 2 request customization without weakening local secret handling.

Acceptance:

- Persist custom request headers per API configuration.
- Keep secret custom headers encrypted or omitted from secret-free exports.
- Inject custom headers into connection tests and chat requests only after sanitization coverage is in place.
- Keep request logs, diagnostics, snippets, and template export/import free of secret header values.
- Preserve existing route-proxy authentication and header filtering behavior.

Current result:

- M6 Request Customization is fully completed. Custom headers are securely stored, redacted in logs, and correctly injected into connection tests, model fetches, and chat transports without disrupting the route-proxy or weakening secret handling.
- M6 Provider Expansion has been intentionally skipped per user request, as Anthropic and OpenAI-compatible endpoints cover current usage needs.

## 10. Next Step

All defined milestones (M1 through M6) have now been completed. The project has transitioned into Maintenance Mode.

Immediate tasks:

1. Monitor for any bug reports or compatibility issues from active use.
2. Keep CodeBuddy `models.json` output aligned with the public docs if that schema changes.
3. Keep M4 protocol-conversion and provider-specific request changes closed unless a concrete compatibility behavior is defined.
4. Re-run `npm run build` and `npm test` after any future code change.
