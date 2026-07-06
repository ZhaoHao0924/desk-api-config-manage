# Route Proxy Durable Diagnostics

Status: proposed model; guard helpers, opt-in storage adapter, Electron IPC, preload, renderer transport, minimal UI controls, opt-in runtime append, target-health transition events, event-type read filters, and a separate renderer health-history view implemented.

This document defines the durable route-proxy diagnostics model and retention policy. It is a prerequisite for any future implementation that writes route-proxy logs to disk. The current product behavior remains in-memory only.

Current implementation status:

- `electron/routeProxyDiagnostics.cjs` contains pure sanitization, query, manifest, and retention guard helpers.
- `electron/routeProxyDiagnosticsStore.cjs` contains an opt-in storage adapter that writes only after explicit enablement.
- The storage adapter is connected to Electron IPC, preload, renderer transport, and minimal route-proxy UI controls for enable, disable, read, and clear.
- The route-proxy runtime queues sanitized diagnostic attempt entries and target-health transition entries through the storage adapter.
- Bounded reads can filter entries by event type so the renderer can show all entries, request attempts only, or target-health transitions only.
- The route-proxy diagnostics panel also shows a separate target-health history view backed by the same sanitized `target-health` entries.
- The desktop app writes a non-secret diagnostics manifest only after explicit user enablement. It writes diagnostic entries only while durable diagnostics are enabled.

## Goals

- Preserve enough sanitized request metadata to debug route-proxy forwarding, failover, cooldown, and target health across app restarts.
- Keep diagnostics useful for local troubleshooting without storing provider secrets, request payloads, response payloads, or raw user traffic.
- Make deletion and retention predictable before persistence is implemented.

## Non-Goals

- No request body persistence.
- No response body persistence.
- No raw request or response header persistence.
- No query string persistence.
- No plaintext API key, encrypted API key ciphertext, key preview, bearer token, `x-api-key`, `api-key`, cookie, proxy credential, or authorization value persistence.
- No durable per-token streaming event log.
- No durable local client IP or machine identity tracking.
- No provider billing or usage accounting. Token counts may be added later only if they are returned as sanitized provider metadata and do not require storing payloads.

## Default Behavior

- Durable diagnostics must be off by default.
- The existing in-memory request log remains available without enabling durable diagnostics.
- The first implementation should require an explicit user action in the route-proxy diagnostics UI before any route-proxy diagnostic entry is written to disk.
- Disabling durable diagnostics should stop future writes immediately and offer to delete already persisted diagnostic files.

## Storage Location

Future implementation should store files under Electron `app.getPath("userData")`, not inside the repository.

Recommended layout:

```text
<userData>/route-proxy-diagnostics/
  manifest.v1.json
  entries-YYYY-MM-DD.v1.ndjson
```

Rationale:

- `userData` follows the desktop app lifecycle.
- NDJSON supports append-only writes and bounded retention without loading all historical entries into memory.
- Daily files make retention deletion simple.

## Manifest Model

`manifest.v1.json` should contain only non-secret operational metadata.

```ts
interface RouteProxyDiagnosticsManifestV1 {
  schemaVersion: 1;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  retention: {
    maxAgeDays: number;
    maxEntries: number;
    maxTotalBytes: number;
  };
}
```

Default retention values:

- `maxAgeDays`: `7`
- `maxEntries`: `10000`
- `maxTotalBytes`: `10485760` (10 MiB)

Hard limits:

- `maxAgeDays`: minimum `1`, maximum `30`
- `maxEntries`: minimum `100`, maximum `100000`
- `maxTotalBytes`: minimum `1048576` (1 MiB), maximum `104857600` (100 MiB)

## Entry Model

Each NDJSON line should be one sanitized entry.

```ts
interface RouteProxyDiagnosticEntryV1 {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  completedAt: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  ok: boolean;
  eventType: "request" | "target-health";
  result:
    | "success"
    | "upstream-http-error"
    | "network-error"
    | "proxy-error"
    | "client-error"
    | "target-health-change";
  attempt: number;
  profileId: string;
  targetConfigId: string;
  targetOrdinal: number;
  targetHealthState: "available" | "cooling-down";
  errorCode: string;
  errorMessage: string;
}
```

Field rules:

- `id`: locally generated diagnostic entry id.
- `eventType`: `request` for proxy attempts, `target-health` for cooldown or recovery transitions.
- `method`: uppercase HTTP method, truncated to 16 characters.
- `path`: URL path only, no query string, no fragment, max 512 characters.
- `statusCode`: upstream or proxy status code. Network failures use `0` in attempt logs and the final proxy response code in aggregate views.
- `latencyMs`: non-negative integer.
- `attempt`: one-based attempt number.
- `profileId`: local route-proxy profile id. Empty string is allowed for unsaved profiles.
- `targetConfigId`: saved config id only. Do not store Base URL, target name, API key preview, encrypted key, provider response body, or provider headers.
- `targetOrdinal`: zero-based index in the runtime target list.
- `targetHealthState`: target state after the attempt is recorded.
- `target-health` events use method `HEALTH`, path `/_route-proxy/target-health`, status code `0`, and result `target-health-change`.
- `errorCode`: short normalized code such as `http_502`, `fetch_failed`, `stream_failed`, `proxy_not_running`, or empty string.
- `errorMessage`: sanitized, truncated to 240 characters, and passed through the same secret redaction helper used by route-proxy runtime logs.

## Forbidden Fields

The durable model must reject or drop these fields if they are accidentally passed to the persistence layer:

- `apiKey`
- `encryptedApiKey`
- `apiKeyPreview`
- `authorization`
- `Authorization`
- `headers`
- `requestHeaders`
- `responseHeaders`
- `body`
- `requestBody`
- `responseBody`
- `query`
- `search`
- `url`
- `baseUrl`
- `targetBaseUrl`
- `cookie`
- `set-cookie`
- `proxyAuthorization`
- `x-api-key`
- `api-key`

## Retention

Retention should run:

- at app startup after diagnostics storage is opened
- after enabling durable diagnostics
- after each successful daily file rollover
- after every 100 appended entries

Deletion order:

1. Delete files older than `maxAgeDays`.
2. If total entry count still exceeds `maxEntries`, delete oldest daily files first.
3. If total bytes still exceed `maxTotalBytes`, delete oldest daily files first.

If one current-day file alone exceeds `maxTotalBytes`, keep appending until the next rollover but surface a diagnostics warning in the route-proxy UI. Do not delete the active file while the proxy is writing to it.

## Read API

IPC exposes a bounded read API:

```ts
interface RouteProxyDiagnosticsQuery {
  limit: number;
  since?: string;
  profileId?: string;
  targetConfigId?: string;
  eventType?: "request" | "target-health";
  ok?: boolean;
}
```

Rules:

- Clamp `limit` to `1..500`.
- Sanitize optional filters, including `eventType`.
- Sort newest first.
- Return sanitized entries only.
- Never return file paths to the renderer.
- Never return raw parse errors that include file contents.
- If a diagnostics file disappears while a renderer read is in flight, skip that file and return the remaining sanitized entries.

## Clear API

Future IPC should expose:

- clear all route-proxy diagnostics
- clear diagnostics for one profile id
- clear diagnostics before a timestamp

Clear operations should be explicit user actions and should not affect saved API configs, encrypted keys, route-proxy profiles, or in-memory runtime state.

## Implementation Gate

Before writing diagnostics to disk, implementation must include tests for:

- forbidden field dropping or rejection
- query string stripping
- secret redaction in error messages
- retention by age
- retention by entry count
- retention by byte count
- disabled-by-default behavior
- renderer read API returning sanitized entries only
