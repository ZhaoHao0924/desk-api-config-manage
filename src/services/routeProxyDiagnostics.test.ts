import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createRouteProxyDiagnosticsManifest,
  defaultRouteProxyDiagnosticsRetention,
  forbiddenRouteProxyDiagnosticFields,
  normalizeRouteProxyDiagnosticsRetention,
  planRouteProxyDiagnosticsRetention,
  readRouteProxyDiagnosticEntries,
  sanitizeRouteProxyDiagnosticEntry,
  sanitizeSensitiveText
} = require("../../electron/routeProxyDiagnostics.cjs") as {
  createRouteProxyDiagnosticsManifest: (overrides?: unknown, now?: Date) => RouteProxyDiagnosticsManifest;
  defaultRouteProxyDiagnosticsRetention: RouteProxyDiagnosticsRetention;
  forbiddenRouteProxyDiagnosticFields: string[];
  normalizeRouteProxyDiagnosticsRetention: (retention?: Partial<RouteProxyDiagnosticsRetention>) => RouteProxyDiagnosticsRetention;
  planRouteProxyDiagnosticsRetention: (
    files: RouteProxyDiagnosticFile[],
    retention: Partial<RouteProxyDiagnosticsRetention>,
    options: { activeFileName?: string; now?: Date }
  ) => {
    deleteFileNames: string[];
    retention: RouteProxyDiagnosticsRetention;
    retentionWarning: string;
  };
  readRouteProxyDiagnosticEntries: (
    entries: Array<Record<string, unknown>>,
    query?: RouteProxyDiagnosticsQuery,
    options?: { now?: Date; secrets?: string[] }
  ) => RouteProxyDiagnosticEntry[];
  sanitizeRouteProxyDiagnosticEntry: (
    input: Record<string, unknown>,
    options?: { now?: Date; secrets?: string[] }
  ) => RouteProxyDiagnosticEntry;
  sanitizeSensitiveText: (value: unknown, secrets?: string[]) => string;
};

interface RouteProxyDiagnosticsRetention {
  maxAgeDays: number;
  maxEntries: number;
  maxTotalBytes: number;
}

interface RouteProxyDiagnosticsManifest {
  createdAt: string;
  enabled: boolean;
  retention: RouteProxyDiagnosticsRetention;
  schemaVersion: 1;
  updatedAt: string;
}

interface RouteProxyDiagnosticEntry {
  attempt: number;
  completedAt: string;
  errorCode: string;
  errorMessage: string;
  eventType: string;
  id: string;
  latencyMs: number;
  method: string;
  ok: boolean;
  path: string;
  profileId: string;
  result: string;
  schemaVersion: 1;
  startedAt: string;
  statusCode: number;
  targetConfigId: string;
  targetHealthState: string;
  targetOrdinal: number;
}

interface RouteProxyDiagnosticFile {
  bytes: number;
  date?: string;
  entryCount: number;
  name: string;
}

interface RouteProxyDiagnosticsQuery {
  eventType?: string;
  limit?: number;
  ok?: boolean;
  profileId?: string;
  since?: string;
  targetConfigId?: string;
}

const fixedNow = new Date("2026-07-05T12:00:00.000Z");

describe("routeProxyDiagnostics", () => {
  it("keeps durable diagnostics disabled by default and normalizes retention limits", () => {
    expect(createRouteProxyDiagnosticsManifest(undefined, fixedNow)).toEqual({
      createdAt: "2026-07-05T12:00:00.000Z",
      enabled: false,
      retention: defaultRouteProxyDiagnosticsRetention,
      schemaVersion: 1,
      updatedAt: "2026-07-05T12:00:00.000Z"
    });

    expect(
      normalizeRouteProxyDiagnosticsRetention({
        maxAgeDays: 0,
        maxEntries: 10,
        maxTotalBytes: 10
      })
    ).toEqual({
      maxAgeDays: 1,
      maxEntries: 100,
      maxTotalBytes: 1_048_576
    });

    expect(
      normalizeRouteProxyDiagnosticsRetention({
        maxAgeDays: 90,
        maxEntries: 1_000_000,
        maxTotalBytes: 1_000_000_000
      })
    ).toEqual({
      maxAgeDays: 30,
      maxEntries: 100_000,
      maxTotalBytes: 104_857_600
    });
  });

  it("sanitizes diagnostic entries before they can be persisted or returned", () => {
    const entry = sanitizeRouteProxyDiagnosticEntry(
      {
        Authorization: "Bearer sk-should-not-survive-123456",
        apiKey: "secret-token",
        apiKeyPreview: "sk-...1234",
        baseUrl: "https://api.example.test/v1?token=secret-token",
        body: "prompt text",
        completedAt: "2026-07-05T10:00:01.000Z",
        cookie: "session=secret-token",
        encryptedApiKey: "encrypted-secret",
        errorCode: "HTTP 502!!",
        errorMessage: "Authorization: Bearer sk-test-1234567890abcdef and secret-token",
        eventType: "target-health",
        headers: {
          authorization: "Bearer secret-token"
        },
        id: " diagnostic-1 ",
        latencyMs: -5,
        method: "post-with-way-too-long",
        ok: false,
        path: "/v1/models?token=secret-token#fragment",
        profileId: " profile-1 ",
        query: "token=secret-token",
        requestBody: "request",
        requestHeaders: {
          "x-api-key": "secret-token"
        },
        responseBody: "response",
        responseHeaders: {
          "set-cookie": "session=secret-token"
        },
        result: "target-health-change",
        search: "?token=secret-token",
        startedAt: "not-a-date",
        statusCode: 502.9,
        targetBaseUrl: "https://api.example.test/v1",
        targetConfigId: " cfg-1 ",
        targetHealthState: "cooling-down",
        targetOrdinal: 2,
        url: "https://api.example.test/v1/models?token=secret-token",
        "api-key": "secret-token",
        "set-cookie": "session=secret-token",
        "x-api-key": "secret-token"
      },
      {
        now: fixedNow,
        secrets: ["secret-token"]
      }
    );

    expect(entry).toMatchObject({
      attempt: 1,
      completedAt: "2026-07-05T10:00:01.000Z",
      errorCode: "http_502",
      eventType: "target-health",
      id: "diagnostic-1",
      latencyMs: 0,
      ok: false,
      path: "/v1/models",
      profileId: "profile-1",
      result: "target-health-change",
      startedAt: "2026-07-05T12:00:00.000Z",
      statusCode: 502,
      targetConfigId: "cfg-1",
      targetHealthState: "cooling-down",
      targetOrdinal: 2
    });
    expect(entry.method).toHaveLength(16);
    expect(entry.method).toBe("POST-WITH-WAY-TO");
    expect(entry.errorMessage).toBe("Authorization: Bearer [redacted] and [redacted]");

    for (const forbiddenField of forbiddenRouteProxyDiagnosticFields) {
      expect(entry).not.toHaveProperty(forbiddenField);
    }
  });

  it("sanitizes auth key-value text before diagnostics persistence", () => {
    expect(
      sanitizeSensitiveText(
        'x-api-key: gateway-token-123 xApiKey=camel-x-api-secret x-goog-api-key=x-goog-secret xGoogApiKey=camel-x-goog-secret googleApiKey=google-api-secret api-key=header-token api_key=query-token apiToken=api-token-secret authToken=auth-token-secret azureSubscriptionKey=azure-subscription-secret bearerToken=bearer-token-secret clientSecret=camel-client-secret client_secret=client-secret ocp-apim-subscription-key=ocp-apim-secret refreshToken=camel-refresh-secret refresh_token=refresh-secret idToken=id-camel-secret id_token=id-secret session=session-secret sessionToken=session-camel-secret subscriptionKey=subscription-secret access-token=hyphen-access-secret accessToken=access-camel-secret access_token=access-secret secretKey=secret-key-value token="url-token"'
      )
    ).toBe(
      'x-api-key: [redacted] xApiKey=[redacted] x-goog-api-key=[redacted] xGoogApiKey=[redacted] googleApiKey=[redacted] api-key=[redacted] api_key=[redacted] apiToken=[redacted] authToken=[redacted] azureSubscriptionKey=[redacted] bearerToken=[redacted] clientSecret=[redacted] client_secret=[redacted] ocp-apim-subscription-key=[redacted] refreshToken=[redacted] refresh_token=[redacted] idToken=[redacted] id_token=[redacted] session=[redacted] sessionToken=[redacted] subscriptionKey=[redacted] access-token=[redacted] accessToken=[redacted] access_token=[redacted] secretKey=[redacted] token="[redacted]"'
    );
    expect(sanitizeSensitiveText("failed https://user:password@api.example.test/v1/models")).toBe(
      "failed https://api.example.test/v1/models"
    );
    expect(sanitizeSensitiveText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [redacted]");
    expect(
      sanitizeSensitiveText(
        'Cookie: session=client-secret; Set-Cookie: refresh=server-secret; proxyAuthorization="Basic proxy-secret"'
      )
    ).toBe('Cookie: [redacted]; Set-Cookie: [redacted]; proxyAuthorization="[redacted]"');
  });

  it("plans retention by age, entry count, and byte count without deleting the active file", () => {
    const plan = planRouteProxyDiagnosticsRetention(
      [
        {
          bytes: 1000,
          date: "2026-06-01T00:00:00.000Z",
          entryCount: 10,
          name: "entries-2026-06-01.v1.ndjson"
        },
        {
          bytes: 5 * 1024 * 1024,
          date: "2026-07-01T00:00:00.000Z",
          entryCount: 9000,
          name: "entries-2026-07-01.v1.ndjson"
        },
        {
          bytes: 6 * 1024 * 1024,
          date: "2026-07-04T00:00:00.000Z",
          entryCount: 9000,
          name: "entries-2026-07-04.v1.ndjson"
        },
        {
          bytes: 11 * 1024 * 1024,
          date: "2026-07-05T00:00:00.000Z",
          entryCount: 5,
          name: "entries-2026-07-05.v1.ndjson"
        }
      ],
      defaultRouteProxyDiagnosticsRetention,
      {
        activeFileName: "entries-2026-07-05.v1.ndjson",
        now: fixedNow
      }
    );

    expect(plan.deleteFileNames).toEqual([
      "entries-2026-06-01.v1.ndjson",
      "entries-2026-07-01.v1.ndjson",
      "entries-2026-07-04.v1.ndjson"
    ]);
    expect(plan.retentionWarning).toBe("Active diagnostics file exceeds retention byte limit.");
  });

  it("returns only sanitized diagnostic entries from bounded renderer reads", () => {
    const entries = readRouteProxyDiagnosticEntries(
      [
        {
          apiKey: "secret-token",
          completedAt: "2026-07-05T10:00:00.000Z",
          errorMessage: "secret-token",
          id: "older",
          ok: false,
          path: "/v1/older?secret=1",
          profileId: "profile-1",
          statusCode: 500,
          targetConfigId: "cfg-1"
        },
        {
          completedAt: "2026-07-05T11:00:00.000Z",
          errorMessage: "Bearer sk-test-1234567890abcdef",
          headers: {
            authorization: "Bearer sk-test-1234567890abcdef"
          },
          id: "newer",
          ok: false,
          path: "/v1/newer?secret=1",
          profileId: "profile-1",
          statusCode: 502,
          targetConfigId: "cfg-1"
        },
        {
          completedAt: "2026-07-05T12:00:00.000Z",
          id: "success",
          ok: true,
          path: "/v1/success",
          profileId: "profile-1",
          statusCode: 200,
          targetConfigId: "cfg-1"
        }
      ],
      {
        limit: 1_000,
        ok: false,
        profileId: "profile-1",
        since: "2026-07-05T10:30:00.000Z",
        targetConfigId: "cfg-1"
      },
      {
        now: fixedNow,
        secrets: ["secret-token"]
      }
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      errorMessage: "Bearer [redacted]",
      id: "newer",
      path: "/v1/newer"
    });

    for (const forbiddenField of forbiddenRouteProxyDiagnosticFields) {
      expect(entries[0]).not.toHaveProperty(forbiddenField);
    }
  });

  it("filters diagnostic reads by event type", () => {
    const entries = readRouteProxyDiagnosticEntries(
      [
        {
          completedAt: "2026-07-05T10:00:00.000Z",
          eventType: "request",
          id: "request-event",
          ok: true,
          path: "/v1/models",
          statusCode: 200,
          targetConfigId: "cfg-1"
        },
        {
          completedAt: "2026-07-05T11:00:00.000Z",
          eventType: "target-health",
          id: "health-event",
          ok: false,
          path: "/_route-proxy/target-health",
          result: "target-health-change",
          statusCode: 0,
          targetConfigId: "cfg-1"
        }
      ],
      {
        eventType: "target-health",
        limit: 10
      },
      {
        now: fixedNow
      }
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventType: "target-health",
      id: "health-event",
      result: "target-health-change"
    });
  });
});
