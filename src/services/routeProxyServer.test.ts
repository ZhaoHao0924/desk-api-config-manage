import {
  createServer,
  request as createHttpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080
]);

const require = createRequire(import.meta.url);
const {
  createRouteProxyController,
  createRouteProxyTargetHealthSnapshot,
  createRouteProxyTargetState,
  getRouteProxyTargetHealthState
} = require("../../electron/routeProxyServer.cjs") as {
  createRouteProxyController: (options?: RouteProxyControllerOptions) => RouteProxyController;
  createRouteProxyTargetHealthSnapshot: (runtime?: RouteProxyRuntimeSnapshot, nowMs?: number) => RouteProxyTargetHealth[];
  createRouteProxyTargetState: (target: RouteProxyTarget, index: number) => RouteProxyTargetState;
  getRouteProxyTargetHealthState: (targetState?: RouteProxyTargetState, nowMs?: number) => "available" | "cooling-down";
};
const { createRouteProxyDiagnosticsStore } = require("../../electron/routeProxyDiagnosticsStore.cjs") as {
  createRouteProxyDiagnosticsStore: (options: {
    now?: () => Date;
    userDataPath: string;
  }) => RouteProxyDiagnosticsStore;
};

interface RouteProxyControllerOptions {
  appendDiagnosticEntry?: (
    entry: Record<string, unknown>,
    options?: {
      secrets?: string[];
    }
  ) => Promise<unknown>;
  maxConvertedResponseBodyBytes?: number;
  maxConvertedStreamEventBytes?: number;
  maxConvertedStreamOutputBytes?: number;
  maxRequestBodyBytes?: number;
  providerFetch?: (input: string, init?: RequestInit) => Promise<Response> | Response;
}

interface RouteProxyController {
  flushDiagnostics(): Promise<void>;
  getRequestLogs(): RouteProxyRequestLog[];
  getStatus(): RouteProxyStatus;
  start(request: RouteProxyStartRequest): Promise<RouteProxyStatus>;
  stop(): Promise<RouteProxyStatus>;
}

interface RouteProxyDiagnosticsStore {
  appendEntry(
    entry: Record<string, unknown>,
    options?: {
      secrets?: string[];
    }
  ): Promise<unknown>;
  enable(): Promise<unknown>;
  getPaths(): {
    diagnosticsDir: string;
    userDataPath: string;
  };
  readEntries(query?: Record<string, unknown>): Promise<RouteProxyDiagnosticEntry[]>;
}

interface RouteProxyDiagnosticEntry {
  attempt: number;
  errorCode: string;
  errorMessage: string;
  eventType: string;
  ok: boolean;
  path: string;
  profileId: string;
  result: string;
  statusCode: number;
  targetConfigId: string;
  targetHealthState: string;
  targetOrdinal: number;
}

interface RouteProxyRequestLog {
  attempt: number;
  error: string;
  ok: boolean;
  path: string;
  statusCode: number;
  targetConfigId: string;
}

interface RouteProxyStatus {
  failedRequests: number;
  port: number;
  proxyUrl: string;
  routingMode: string;
  successRequests: number;
  targetHealth: Array<{
    configId: string;
    failureCount: number;
    state: string;
  }>;
}

interface RouteProxyTargetHealth {
  baseUrl: string;
  configId: string;
  failureCount: number;
  lastError: string;
  name: string;
  state: "available" | "cooling-down";
  unavailableUntil: string;
  weight: number;
}

interface RouteProxyRuntimeSnapshot {
  targetStates: RouteProxyTargetState[];
}

interface RouteProxyTargetState {
  failureCount: number;
  index: number;
  lastError: string;
  target: RouteProxyTarget;
  unavailableUntil: number;
}

interface RouteProxyStartRequest {
  cooldownMs: number;
  failureThreshold: number;
  listenAddress: string;
  listenPort: number;
  profileId?: string;
  routingMode?: "ordered" | "weighted";
  target: RouteProxyTarget;
  targets: RouteProxyTarget[];
  timeoutMs: number;
}

interface RouteProxyTarget {
  authType: "api-key-header" | "bearer" | "none";
  baseUrl: string;
  configId: string;
  configName: string;
  encryptedApiKey: string;
  endpointMode: "auto" | "chat-completions" | "responses";
  providerId: "anthropic" | "openai-compatible";
  providerType: "anthropic" | "openai";
  weight?: number;
}

function createRouteProxyTarget(
  configId: string,
  baseUrl: string,
  weight?: number,
  endpointMode: RouteProxyTarget["endpointMode"] = "auto"
): RouteProxyTarget {
  return {
    authType: "bearer",
    baseUrl,
    configId,
    configName: configId,
    encryptedApiKey: `encrypted-${configId}`,
    endpointMode,
    providerId: "openai-compatible",
    providerType: "openai",
    weight
  };
}

function createAnthropicRouteProxyTarget(configId: string, baseUrl: string): RouteProxyTarget {
  return {
    authType: "none",
    baseUrl,
    configId,
    configName: configId,
    encryptedApiKey: "",
    endpointMode: "auto",
    providerId: "anthropic",
    providerType: "anthropic"
  };
}

async function listen(server: Server, port = 0): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", resolve);
      server.listen(port, "127.0.0.1");
    });

    const address = server.address() as AddressInfo;

    if (port !== 0 || !fetchForbiddenPorts.has(address.port)) {
      return address.port;
    }

    await closeServer(server);
  }

  throw new Error("Unable to allocate a fetch-accessible local port.");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function createTempUserDataPath(): Promise<string> {
  return fs.mkdtemp(path.join(process.cwd(), ".tmp-route-proxy-runtime-diagnostics-"));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};

  new Headers(headers).forEach((value, name) => {
    result[name.toLowerCase()] = value;
  });

  return result;
}

async function requestProxyText(
  proxyUrl: string,
  requestPath: string,
  headers: Record<string, string>,
  method = "GET"
): Promise<{
  body: string;
  headers: IncomingHttpHeaders;
  statusCode: number;
}> {
  const url = new URL(requestPath, proxyUrl);

  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      url,
      {
        headers,
        method
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            statusCode: response.statusCode ?? 0
          });
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

async function startMockUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{
  close(): Promise<void>;
  getHits(): number;
  url: string;
}> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    handler(request, response);
  });
  const port = await listen(server);

  return {
    close: () => closeServer(server),
    getHits: () => hits,
    url: `http://127.0.0.1:${port}/v1`
  };
}

describe("routeProxyServer", () => {
  it("creates sanitized route proxy target health snapshots", () => {
    const nowMs = Date.parse("2026-07-05T08:00:00.000Z");
    const availableTargetState = createRouteProxyTargetState(createRouteProxyTarget("available", "http://127.0.0.1:3001/v1"), 0);
    const coolingTargetState = createRouteProxyTargetState(createRouteProxyTarget("cooling", "http://127.0.0.1:3002/v1"), 1);

    coolingTargetState.failureCount = 2;
    coolingTargetState.lastError = "HTTP 502";
    coolingTargetState.unavailableUntil = nowMs + 30_000;

    expect(getRouteProxyTargetHealthState(availableTargetState, nowMs)).toBe("available");
    expect(getRouteProxyTargetHealthState(coolingTargetState, nowMs)).toBe("cooling-down");
    expect(getRouteProxyTargetHealthState(coolingTargetState, nowMs + 30_000)).toBe("available");

    const snapshot = createRouteProxyTargetHealthSnapshot(
      {
        targetStates: [availableTargetState, coolingTargetState]
      },
      nowMs
    );

    expect(snapshot).toEqual([
      {
        baseUrl: "http://127.0.0.1:3001/v1",
        configId: "available",
        failureCount: 0,
        lastError: "",
        name: "available",
        state: "available",
        unavailableUntil: "",
        weight: 1
      },
      {
        baseUrl: "http://127.0.0.1:3002/v1",
        configId: "cooling",
        failureCount: 2,
        lastError: "HTTP 502",
        name: "cooling",
        state: "cooling-down",
        unavailableUntil: "2026-07-05T08:00:30.000Z",
        weight: 1
      }
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("encrypted-");
  });

  it("strips client-only and sensitive request headers before provider fetch", async () => {
    const forwardedUrls: string[] = [];
    const forwardedHeaders: Record<string, string>[] = [];
    const controller = createRouteProxyController({
      providerFetch: async (input, init) => {
        forwardedUrls.push(String(input));
        forwardedHeaders.push(headersToRecord(init?.headers));

        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:65534/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });

      const response = await requestProxyText(
        status.proxyUrl,
        "v1/models?api_key=sk-client-query-secret&access_token=client-token-secret&access-token=client-hyphen-access-secret&api-version=2026-01-01&apiToken=client-api-token-secret&authorization=Bearer%20client-query-secret&azureSubscriptionKey=client-azure-subscription-secret&bearerToken=client-bearer-token-secret&clientSecret=client-camel-secret&client_secret=client-oauth-secret&googleApiKey=client-google-api-secret&key=client-key-secret&ocp-apim-subscription-key=client-ocp-apim-secret&refreshToken=client-camel-refresh-secret&refresh_token=client-refresh-secret&idToken=client-camel-id-secret&id_token=client-id-secret&secretKey=client-secret-key-secret&sessionToken=client-camel-session-secret&subscriptionKey=client-subscription-secret&xApiKey=client-camel-x-api-secret&x-goog-api-key=client-x-goog-secret&xGoogApiKey=client-camel-x-goog-secret",
        {
          "accept-encoding": "gzip, deflate, br",
          "api-key": "client-api-key-secret",
          authorization: "Bearer client-secret",
          connection: "keep-alive",
          "content-type": "application/json",
          cookie: "session=client-secret",
          "ocp-apim-subscription-key": "client-ocp-apim-header-secret",
          origin: "http://127.0.0.1:5173",
          referer: "http://127.0.0.1:5173/route-proxy",
          "sec-ch-ua": '"Chromium";v="143"',
          "sec-fetch-mode": "cors",
          "subscription-key": "client-subscription-header-secret",
          "user-agent": "client-user-agent",
          "x-api-key": "client-x-api-key-secret",
          "x-goog-api-key": "client-x-goog-header-secret",
          "x-client-trace": "trace-one"
        }
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(forwardedUrls).toHaveLength(1);
      const forwardedUrl = new URL(forwardedUrls[0]);

      expect(forwardedUrl.pathname).toBe("/v1/models");
      expect(forwardedUrl.searchParams.get("api-version")).toBe("2026-01-01");
      expect(forwardedUrl.searchParams.get("api_key")).toBeNull();
      expect(forwardedUrl.searchParams.get("access_token")).toBeNull();
      expect(forwardedUrl.searchParams.get("access-token")).toBeNull();
      expect(forwardedUrl.searchParams.get("apiToken")).toBeNull();
      expect(forwardedUrl.searchParams.get("authorization")).toBeNull();
      expect(forwardedUrl.searchParams.get("azureSubscriptionKey")).toBeNull();
      expect(forwardedUrl.searchParams.get("bearerToken")).toBeNull();
      expect(forwardedUrl.searchParams.get("clientSecret")).toBeNull();
      expect(forwardedUrl.searchParams.get("client_secret")).toBeNull();
      expect(forwardedUrl.searchParams.get("googleApiKey")).toBeNull();
      expect(forwardedUrl.searchParams.get("key")).toBeNull();
      expect(forwardedUrl.searchParams.get("ocp-apim-subscription-key")).toBeNull();
      expect(forwardedUrl.searchParams.get("refreshToken")).toBeNull();
      expect(forwardedUrl.searchParams.get("refresh_token")).toBeNull();
      expect(forwardedUrl.searchParams.get("idToken")).toBeNull();
      expect(forwardedUrl.searchParams.get("id_token")).toBeNull();
      expect(forwardedUrl.searchParams.get("secretKey")).toBeNull();
      expect(forwardedUrl.searchParams.get("sessionToken")).toBeNull();
      expect(forwardedUrl.searchParams.get("subscriptionKey")).toBeNull();
      expect(forwardedUrl.searchParams.get("xApiKey")).toBeNull();
      expect(forwardedUrl.searchParams.get("x-goog-api-key")).toBeNull();
      expect(forwardedUrl.searchParams.get("xGoogApiKey")).toBeNull();
      expect(forwardedUrl.toString()).not.toContain("sk-client-query-secret");
      expect(forwardedUrl.toString()).not.toContain("client-token-secret");
      expect(forwardedUrl.toString()).not.toContain("client-hyphen-access-secret");
      expect(forwardedUrl.toString()).not.toContain("client-api-token-secret");
      expect(forwardedUrl.toString()).not.toContain("client-query-secret");
      expect(forwardedUrl.toString()).not.toContain("client-azure-subscription-secret");
      expect(forwardedUrl.toString()).not.toContain("client-bearer-token-secret");
      expect(forwardedUrl.toString()).not.toContain("client-camel-secret");
      expect(forwardedUrl.toString()).not.toContain("client-oauth-secret");
      expect(forwardedUrl.toString()).not.toContain("client-google-api-secret");
      expect(forwardedUrl.toString()).not.toContain("client-key-secret");
      expect(forwardedUrl.toString()).not.toContain("client-ocp-apim-secret");
      expect(forwardedUrl.toString()).not.toContain("client-camel-refresh-secret");
      expect(forwardedUrl.toString()).not.toContain("client-refresh-secret");
      expect(forwardedUrl.toString()).not.toContain("client-camel-id-secret");
      expect(forwardedUrl.toString()).not.toContain("client-id-secret");
      expect(forwardedUrl.toString()).not.toContain("client-secret-key-secret");
      expect(forwardedUrl.toString()).not.toContain("client-camel-session-secret");
      expect(forwardedUrl.toString()).not.toContain("client-subscription-secret");
      expect(forwardedUrl.toString()).not.toContain("client-camel-x-api-secret");
      expect(forwardedUrl.toString()).not.toContain("client-x-goog-secret");
      expect(forwardedUrl.toString()).not.toContain("client-camel-x-goog-secret");
      expect(forwardedHeaders).toHaveLength(1);
      expect(forwardedHeaders[0]).toMatchObject({
        authorization: "Bearer encrypted-primary",
        "content-type": "application/json",
        "x-client-trace": "trace-one"
      });
      expect(forwardedHeaders[0]).not.toHaveProperty("ocp-apim-subscription-key");
      expect(forwardedHeaders[0]).not.toHaveProperty("subscription-key");
      expect(forwardedHeaders[0]).not.toHaveProperty("x-goog-api-key");
      expect(JSON.stringify(forwardedHeaders[0])).not.toContain("client-ocp-apim-header-secret");
      expect(JSON.stringify(forwardedHeaders[0])).not.toContain("client-subscription-header-secret");
      expect(JSON.stringify(forwardedHeaders[0])).not.toContain("client-x-goog-header-secret");
      expect(forwardedHeaders[0]["accept-encoding"]).toBeUndefined();
      expect(forwardedHeaders[0]["api-key"]).toBeUndefined();
      expect(forwardedHeaders[0].cookie).toBeUndefined();
      expect(forwardedHeaders[0].origin).toBeUndefined();
      expect(forwardedHeaders[0].referer).toBeUndefined();
      expect(forwardedHeaders[0]["sec-ch-ua"]).toBeUndefined();
      expect(forwardedHeaders[0]["sec-fetch-mode"]).toBeUndefined();
      expect(forwardedHeaders[0]["user-agent"]).toBeUndefined();
      expect(forwardedHeaders[0]["x-api-key"]).toBeUndefined();
      expect(forwardedHeaders[0].authorization).not.toBe("Bearer client-secret");
    } finally {
      await controller.stop();
    }
  });

  it("bounds non-sensitive query parameters before provider fetch", async () => {
    const forwardedUrls: string[] = [];
    const controller = createRouteProxyController({
      providerFetch: async (input) => {
        forwardedUrls.push(String(input));

        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:65534/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const normalQueryParameters = Array.from(
        { length: 140 },
        (_value, index) => `x-param-${String(index + 1).padStart(3, "0")}=value-${index + 1}`
      );
      const response = await requestProxyText(
        status.proxyUrl,
        [
          "v1/models?api-version=2026-01-01",
          "api_key=sk-query-secret",
          "x-goog-api-key=query-google-secret",
          `x-${"a".repeat(140)}=too-long-query-name`,
          `x-oversized=${"v".repeat(4300)}`,
          ...normalQueryParameters
        ].join("&"),
        {}
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(forwardedUrls).toHaveLength(1);
      const forwardedUrl = new URL(forwardedUrls[0]);
      const forwardedQueryParameters = [...forwardedUrl.searchParams.entries()];

      expect(forwardedUrl.pathname).toBe("/v1/models");
      expect(forwardedUrl.search.length).toBeLessThanOrEqual(8193);
      expect(forwardedQueryParameters).toHaveLength(128);
      expect(forwardedUrl.searchParams.get("api-version")).toBe("2026-01-01");
      expect(forwardedUrl.searchParams.get("x-param-001")).toBe("value-1");
      expect(forwardedUrl.searchParams.get("x-param-127")).toBe("value-127");
      expect(forwardedUrl.searchParams.get("x-param-128")).toBeNull();
      expect(forwardedUrl.searchParams.get("api_key")).toBeNull();
      expect(forwardedUrl.searchParams.get("x-goog-api-key")).toBeNull();
      expect(forwardedUrl.searchParams.get("x-oversized")).toBeNull();
      expect(forwardedUrl.toString()).not.toContain("sk-query-secret");
      expect(forwardedUrl.toString()).not.toContain("query-google-secret");
      expect(forwardedUrl.toString()).not.toContain("too-long-query-name");
      expect(forwardedUrl.toString()).not.toContain("v".repeat(200));
    } finally {
      await controller.stop();
    }
  });

  it("bounds client request headers before provider fetch", async () => {
    const forwardedHeaders: Record<string, string>[] = [];
    const controller = createRouteProxyController({
      providerFetch: async (_input, init) => {
        forwardedHeaders.push(headersToRecord(init?.headers));

        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:65534/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const requestHeaders: Record<string, string> = {
        [`x-${"a".repeat(140)}`]: "too-long-name",
        "x-oversized-value": "v".repeat(8300)
      };

      for (let index = 1; index <= 70; index += 1) {
        requestHeaders[`x-forwarded-${String(index).padStart(2, "0")}`] = `value-${index}`;
      }

      const response = await requestProxyText(status.proxyUrl, "v1/models", requestHeaders);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(forwardedHeaders).toHaveLength(1);
      const forwardedCustomHeaders = Object.keys(forwardedHeaders[0]).filter((name) => name.startsWith("x-forwarded-"));

      expect(forwardedCustomHeaders).toHaveLength(64);
      expect(forwardedHeaders[0].authorization).toBe("Bearer encrypted-primary");
      expect(forwardedHeaders[0]["x-forwarded-01"]).toBe("value-1");
      expect(forwardedHeaders[0]["x-forwarded-64"]).toBe("value-64");
      expect(forwardedHeaders[0]["x-forwarded-65"]).toBeUndefined();
      expect(forwardedHeaders[0]["x-oversized-value"]).toBeUndefined();
      expect(JSON.stringify(forwardedHeaders[0])).not.toContain("too-long-name");
      expect(JSON.stringify(forwardedHeaders[0])).not.toContain("x-aaaaaaaaaaaaaaaaaaaa");
      expect(JSON.stringify(forwardedHeaders[0])).not.toContain("v".repeat(200));
    } finally {
      await controller.stop();
    }
  });

  it("rejects oversized request bodies before provider fetch", async () => {
    const providerFetch = vi.fn();
    const controller = createRouteProxyController({
      maxRequestBodyBytes: 8,
      providerFetch
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:65534/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/chat/completions`, {
        body: "0123456789",
        headers: {
          "content-type": "text/plain"
        },
        method: "POST"
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "Request body is too large."
      });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "Request body is too large.",
          ok: false,
          path: "/v1/chat/completions",
          statusCode: 413,
          targetConfigId: ""
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("filters sensitive CORS preflight request headers before returning local CORS policy", async () => {
    let providerFetchCalled = false;
    const controller = createRouteProxyController({
      providerFetch: async () => {
        providerFetchCalled = true;

        return new Response("should not be called", { status: 500 });
      }
    });

    try {
      const proxyPort = await getFreePort();
      const target = createRouteProxyTarget("primary", "https://provider.example.com/v1");
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });

      const response = await requestProxyText(
        status.proxyUrl,
        "v1/chat/completions",
        {
          "access-control-request-headers":
            "Authorization, Content-Type, X-Api-Key, X-Client-Trace, Cookie, X-Goog-Api-Key, Ocp-Apim-Subscription-Key, Proxy-Authorization, Sec-Fetch-Mode, Bad Header, Anthropic-Version, X-Client-Trace",
          "access-control-request-method": "POST",
          origin: "http://127.0.0.1:5173"
        },
        "OPTIONS"
      );

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(providerFetchCalled).toBe(false);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-methods"]).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS");
      expect(response.headers["access-control-expose-headers"]).toBe("content-type,request-id,x-request-id");
      expect(response.headers["access-control-allow-headers"]).toBe(
        "authorization,content-type,x-api-key,x-client-trace,anthropic-version"
      );
      expect(response.headers["access-control-allow-headers"]).not.toContain("cookie");
      expect(response.headers["access-control-allow-headers"]).not.toContain("x-goog-api-key");
      expect(response.headers["access-control-allow-headers"]).not.toContain("ocp-apim-subscription-key");
      expect(response.headers["access-control-allow-headers"]).not.toContain("proxy-authorization");
      expect(response.headers["access-control-allow-headers"]).not.toContain("sec-fetch-mode");
      expect(response.headers["access-control-allow-headers"]).not.toContain("bad header");
    } finally {
      await controller.stop();
    }
  });

  it("bounds CORS preflight allowed request headers before returning local CORS policy", async () => {
    let providerFetchCalled = false;
    const controller = createRouteProxyController({
      providerFetch: async () => {
        providerFetchCalled = true;

        return new Response("should not be called", { status: 500 });
      }
    });

    try {
      const proxyPort = await getFreePort();
      const target = createRouteProxyTarget("primary", "https://provider.example.com/v1");
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const requestedHeaders = [
        "X-Trace-01",
        "Cookie",
        "X-Goog-Api-Key",
        `X-${"A".repeat(160)}`,
        ...Array.from({ length: 40 }, (_value, index) => `X-Trace-${String(index + 2).padStart(2, "0")}`)
      ].join(", ");

      const response = await requestProxyText(
        status.proxyUrl,
        "v1/chat/completions",
        {
          "access-control-request-headers": requestedHeaders,
          "access-control-request-method": "POST",
          origin: "http://127.0.0.1:5173"
        },
        "OPTIONS"
      );
      const allowHeaders = String(response.headers["access-control-allow-headers"] || "");
      const allowedHeaderNames = allowHeaders.split(",");

      expect(response.statusCode).toBe(204);
      expect(providerFetchCalled).toBe(false);
      expect(allowHeaders.length).toBeLessThanOrEqual(2048);
      expect(allowedHeaderNames).toHaveLength(32);
      expect(allowedHeaderNames[0]).toBe("x-trace-01");
      expect(allowedHeaderNames[31]).toBe("x-trace-32");
      expect(allowHeaders).not.toContain("x-trace-33");
      expect(allowHeaders).not.toContain("cookie");
      expect(allowHeaders).not.toContain("x-goog-api-key");
      expect(allowHeaders).not.toContain(`x-${"a".repeat(20)}`);
    } finally {
      await controller.stop();
    }
  });

  it("strips upstream sensitive response headers before returning local proxy responses", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            "access-control-allow-credentials": "true",
            "access-control-allow-origin": "https://provider.example.com",
            "access-control-allow-private-network": "true",
            "access-control-expose-headers": "authorization,set-cookie,x-provider-secret",
            "access-control-max-age": "86400",
            "api-key": "provider-api-key-secret",
            authorization: "Bearer provider-auth-secret",
            "authentication-info": 'nextnonce="provider-auth-info-secret"',
            "content-location": "https://provider.example.com/v1/files?api_key=provider-content-location-secret",
            "content-type": "application/json",
            link: '<https://provider.example.com/v1/models?page=2&api_key=provider-link-secret>; rel="next"',
            location: "https://provider.example.com/v1/models?api_key=provider-location-secret",
            "ocp-apim-subscription-key": "provider-apim-secret",
            "proxy-authentication-info": 'nextnonce="provider-proxy-auth-info-secret"',
            refresh: "0; url=https://provider.example.com/v1/models?token=provider-refresh-secret",
            "request-id": "req-safe",
            "set-cookie": "session=provider-secret; Path=/; HttpOnly",
            "set-cookie2": "legacy=provider-secret; Path=/",
            "subscription-key": "provider-subscription-secret",
            "www-authenticate": 'Bearer realm="provider", error="invalid_token", token="provider-auth-challenge-secret"',
            "x-api-key": "provider-x-api-secret",
            "x-goog-api-key": "provider-x-goog-secret"
          },
          status: 200
        })
    });

    try {
      const proxyPort = await getFreePort();
      const target = createRouteProxyTarget("primary", "https://provider.example.com/v1");
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });

      const response = await requestProxyText(status.proxyUrl, "v1/models", {});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-private-network"]).toBeUndefined();
      expect(response.headers["access-control-expose-headers"]).toBe("content-type,request-id,x-request-id");
      expect(response.headers["access-control-max-age"]).toBeUndefined();
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["request-id"]).toBe("req-safe");
      expect(response.headers.authorization).toBeUndefined();
      expect(response.headers["api-key"]).toBeUndefined();
      expect(response.headers["authentication-info"]).toBeUndefined();
      expect(response.headers["content-location"]).toBeUndefined();
      expect(response.headers.link).toBeUndefined();
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["ocp-apim-subscription-key"]).toBeUndefined();
      expect(response.headers["proxy-authentication-info"]).toBeUndefined();
      expect(response.headers.refresh).toBeUndefined();
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["set-cookie2"]).toBeUndefined();
      expect(response.headers["subscription-key"]).toBeUndefined();
      expect(response.headers["www-authenticate"]).toBeUndefined();
      expect(response.headers["x-api-key"]).toBeUndefined();
      expect(response.headers["x-goog-api-key"]).toBeUndefined();
      expect(JSON.stringify(response.headers)).not.toContain("provider-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-auth-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-api-key-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-auth-info-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-content-location-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-link-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-location-secret");
      expect(JSON.stringify(response.headers)).not.toContain("x-provider-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-apim-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-proxy-auth-info-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-refresh-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-subscription-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-auth-challenge-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-x-api-secret");
      expect(JSON.stringify(response.headers)).not.toContain("provider-x-goog-secret");
    } finally {
      await controller.stop();
    }
  });

  it("bounds upstream response headers before returning local proxy responses", async () => {
    const responseHeaders: Record<string, string> = {
      "content-type": "application/json",
      "request-id": "req-safe",
      [`x-${"a".repeat(140)}`]: "too-long-name",
      "x-oversized-value": "v".repeat(9000)
    };

    for (let index = 1; index <= 70; index += 1) {
      responseHeaders[`x-forwarded-${String(index).padStart(2, "0")}`] = `value-${index}`;
    }

    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: responseHeaders,
          status: 200
        })
    });

    try {
      const proxyPort = await getFreePort();
      const target = createRouteProxyTarget("primary", "https://provider.example.com/v1");
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });

      const response = await requestProxyText(status.proxyUrl, "v1/models", {});
      const forwardedHeaders = Object.keys(response.headers).filter((name) => name.startsWith("x-forwarded-"));

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["request-id"]).toBe("req-safe");
      expect(forwardedHeaders).toHaveLength(62);
      expect(response.headers["x-forwarded-01"]).toBe("value-1");
      expect(response.headers["x-forwarded-62"]).toBe("value-62");
      expect(response.headers["x-forwarded-63"]).toBeUndefined();
      expect(response.headers["x-oversized-value"]).toBeUndefined();
      expect(JSON.stringify(response.headers)).not.toContain("too-long-name");
      expect(JSON.stringify(response.headers)).not.toContain("x-aaaaaaaaaaaaaaaaaaaa");
      expect(JSON.stringify(response.headers)).not.toContain("v".repeat(200));
    } finally {
      await controller.stop();
    }
  });

  it("retries HTTP 5xx upstream responses on backup targets", async () => {
    const primary = await startMockUpstream((_request, response) => {
      response.writeHead(502, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ error: "bad gateway" }));
    });
    const backup = await startMockUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true }));
    });
    const controller = createRouteProxyController();

    try {
      const primaryTarget = createRouteProxyTarget("primary", primary.url);
      const backupTarget = createRouteProxyTarget("backup", backup.url);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target: primaryTarget,
        targets: [primaryTarget, backupTarget],
        timeoutMs: 5_000
      });

      const response = await fetch(`${status.proxyUrl}v1/models`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(primary.getHits()).toBe(1);
      expect(backup.getHits()).toBe(1);
      expect(controller.getRequestLogs()).toMatchObject([
        {
          attempt: 2,
          ok: true,
          path: "/v1/models",
          statusCode: 200,
          targetConfigId: "backup"
        },
        {
          attempt: 1,
          ok: false,
          path: "/v1/models",
          statusCode: 502,
          targetConfigId: "primary"
        }
      ]);
      expect(controller.getStatus()).toMatchObject({
        failedRequests: 0,
        successRequests: 1,
        targetHealth: [
          {
            configId: "primary",
            failureCount: 1,
            state: "cooling-down"
          },
          {
            configId: "backup",
            failureCount: 0,
            state: "available"
          }
        ]
      });
    } finally {
      await controller.stop();
      await primary.close();
      await backup.close();
    }
  });

  it("retries network errors on backup targets and redacts target secrets from logs", async () => {
    const forwardedUrls: string[] = [];
    const controller = createRouteProxyController({
      providerFetch: async (input) => {
        forwardedUrls.push(String(input));

        if (String(input).includes("127.0.0.1:3001")) {
          throw new Error(
            "connect ECONNREFUSED https://user:password@127.0.0.1:3001/v1 Cookie: session=client-secret; Authorization: Basic basic-secret encrypted-primary"
          );
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }
    });

    try {
      const primaryTarget = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const backupTarget = createRouteProxyTarget("backup", "http://127.0.0.1:3002/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target: primaryTarget,
        targets: [primaryTarget, backupTarget],
        timeoutMs: 5_000
      });

      const response = await fetch(`${status.proxyUrl}v1/models`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(forwardedUrls).toEqual(["http://127.0.0.1:3001/v1/models", "http://127.0.0.1:3002/v1/models"]);
      expect(controller.getRequestLogs()).toMatchObject([
        {
          attempt: 2,
          error: "",
          ok: true,
          path: "/v1/models",
          statusCode: 200,
          targetConfigId: "backup"
        },
        {
          attempt: 1,
          error: "connect ECONNREFUSED https://127.0.0.1:3001/v1 Cookie: [redacted]; Authorization: [redacted]",
          ok: false,
          path: "/v1/models",
          statusCode: 0,
          targetConfigId: "primary"
        }
      ]);
      expect(JSON.stringify(controller.getRequestLogs())).not.toContain("encrypted-primary");
      expect(JSON.stringify(controller.getRequestLogs())).not.toContain("basic-secret");
      expect(JSON.stringify(controller.getRequestLogs())).not.toContain("client-secret");
      expect(JSON.stringify(controller.getRequestLogs())).not.toContain("user:password");
      expect(controller.getStatus()).toMatchObject({
        failedRequests: 0,
        successRequests: 1,
        targetHealth: [
          {
            configId: "primary",
            failureCount: 1,
            state: "cooling-down"
          },
          {
            configId: "backup",
            failureCount: 0,
            state: "available"
          }
        ]
      });
    } finally {
      await controller.stop();
    }
  });

  it("skips cooling-down targets and returns to higher-priority targets after cooldown", async () => {
    let nowMs = Date.parse("2026-07-05T08:00:00.000Z");
    let primaryHits = 0;
    let backupHits = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const primary = await startMockUpstream((_request, response) => {
      primaryHits += 1;

      if (primaryHits === 1) {
        response.writeHead(502, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify({ error: "bad gateway" }));
        return;
      }

      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ target: "primary" }));
    });
    const backup = await startMockUpstream((_request, response) => {
      backupHits += 1;
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ target: "backup" }));
    });
    const controller = createRouteProxyController();

    try {
      const primaryTarget = createRouteProxyTarget("primary", primary.url);
      const backupTarget = createRouteProxyTarget("backup", backup.url);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 5_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target: primaryTarget,
        targets: [primaryTarget, backupTarget],
        timeoutMs: 5_000
      });

      const firstResponse = await fetch(`${status.proxyUrl}v1/models`);

      expect(firstResponse.status).toBe(200);
      await expect(firstResponse.json()).resolves.toEqual({ target: "backup" });
      expect(primaryHits).toBe(1);
      expect(backupHits).toBe(1);
      expect(controller.getStatus().targetHealth).toMatchObject([
        {
          configId: "primary",
          state: "cooling-down"
        },
        {
          configId: "backup",
          state: "available"
        }
      ]);

      const secondResponse = await fetch(`${status.proxyUrl}v1/models`);

      expect(secondResponse.status).toBe(200);
      await expect(secondResponse.json()).resolves.toEqual({ target: "backup" });
      expect(primaryHits).toBe(1);
      expect(backupHits).toBe(2);

      nowMs += 5_000;
      const thirdResponse = await fetch(`${status.proxyUrl}v1/models`);

      expect(thirdResponse.status).toBe(200);
      await expect(thirdResponse.json()).resolves.toEqual({ target: "primary" });
      expect(primaryHits).toBe(2);
      expect(backupHits).toBe(2);
      expect(controller.getStatus().targetHealth).toMatchObject([
        {
          configId: "primary",
          failureCount: 0,
          state: "available"
        },
        {
          configId: "backup",
          failureCount: 0,
          state: "available"
        }
      ]);
    } finally {
      dateNowSpy.mockRestore();
      await controller.stop();
      await primary.close();
      await backup.close();
    }
  });

  it("uses target weights only when weighted routing mode is selected", async () => {
    const forwardedUrls: string[] = [];
    const controller = createRouteProxyController({
      providerFetch: async (input) => {
        const forwardedUrl = String(input);
        forwardedUrls.push(forwardedUrl);

        return new Response(
          JSON.stringify({
            target: forwardedUrl.includes("127.0.0.1:3002") ? "backup" : "primary"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const primaryTarget = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1", 2);
      const backupTarget = createRouteProxyTarget("backup", "http://127.0.0.1:3002/v1", 1);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        routingMode: "weighted",
        target: primaryTarget,
        targets: [primaryTarget, backupTarget],
        timeoutMs: 5_000
      });

      const responses = [
        await fetch(`${status.proxyUrl}v1/models`).then((response) => response.json()),
        await fetch(`${status.proxyUrl}v1/models`).then((response) => response.json()),
        await fetch(`${status.proxyUrl}v1/models`).then((response) => response.json())
      ];

      expect(responses).toEqual([{ target: "primary" }, { target: "primary" }, { target: "backup" }]);
      expect(forwardedUrls).toEqual([
        "http://127.0.0.1:3001/v1/models",
        "http://127.0.0.1:3001/v1/models",
        "http://127.0.0.1:3002/v1/models"
      ]);
      expect(controller.getStatus()).toMatchObject({
        routingMode: "weighted",
        successRequests: 3,
        targetHealth: [
          {
            configId: "primary",
            weight: 2
          },
          {
            configId: "backup",
            weight: 1
          }
        ]
      });
    } finally {
      await controller.stop();
    }
  });

  it("converts local Responses requests to upstream chat completions when the target is not Responses-native", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          headers: headersToRecord(init?.headers),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "converted reply",
                  role: "assistant"
                }
              }
            ],
            created: 1_788_000_000,
            id: "chatcmpl-local",
            model: "upstream-model",
            usage: {
              completion_tokens: 2,
              prompt_tokens: 4,
              total_tokens: 6
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello from responses",
          instructions: "be concise",
          max_output_tokens: 32,
          model: "client-model",
          seed: 1234,
          store: false
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "api-key": "client-api-key-secret",
          authorization: "Bearer client-secret",
          "content-type": "application/json",
          "x-api-key": "client-x-api-key-secret"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "chatcmpl-local",
        model: "upstream-model",
        object: "response",
        output: [
          {
            content: [
              {
                text: "converted reply",
                type: "output_text"
              }
            ],
            role: "assistant",
            type: "message"
          }
        ],
        output_text: "converted reply",
        status: "completed",
        usage: {
          total_tokens: 6
        }
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].input).toBe("http://127.0.0.1:3001/v1/chat/completions");
      expect(fetchCalls[0].headers.authorization).toBe("Bearer encrypted-primary");
      expect(fetchCalls[0].headers.authorization).not.toBe("Bearer client-secret");
      expect(fetchCalls[0].headers["anthropic-version"]).toBeUndefined();
      expect(fetchCalls[0].headers["api-key"]).toBeUndefined();
      expect(fetchCalls[0].headers["x-api-key"]).toBeUndefined();
      expect(fetchCalls[0].body).toMatchObject({
        max_tokens: 32,
        messages: [
          {
            content: "be concise",
            role: "system"
          },
          {
            content: "hello from responses",
            role: "user"
          }
        ],
        model: "client-model",
        seed: 1234,
        stream: false
      });
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "",
          ok: true,
          path: "/v1/responses",
          statusCode: 200,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves multiple upstream chat completions choices for converted Responses requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "first converted choice",
                  role: "assistant"
                }
              },
              {
                finish_reason: "stop",
                message: {
                  content: "second converted choice",
                  role: "assistant"
                }
              }
            ],
            created: 1_788_000_001,
            id: "chatcmpl-multi-choice",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "return two choices",
          model: "client-model",
          store: false
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.output_text).toBe("first converted choice\nsecond converted choice");
      expect(responseJson.output).toHaveLength(2);
      expect(responseJson.output).toMatchObject([
        {
          content: [
            {
              text: "first converted choice",
              type: "output_text"
            }
          ],
          id: "msg_0",
          role: "assistant",
          type: "message"
        },
        {
          content: [
            {
              text: "second converted choice",
              type: "output_text"
            }
          ],
          id: "msg_1",
          role: "assistant",
          type: "message"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("keeps generated Responses function-call ids unique across multiple upstream choices", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "function_call",
                message: {
                  function_call: {
                    arguments: "{\"city\":\"Paris\"}",
                    name: "lookup_weather"
                  },
                  role: "assistant"
                }
              },
              {
                finish_reason: "function_call",
                message: {
                  function_call: {
                    arguments: "{\"city\":\"Tokyo\"}",
                    name: "lookup_time"
                  },
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-multi-function-call",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "call two tools",
          model: "client-model",
          store: false
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.output_text).toBe("");
      expect(responseJson.output).toEqual([
        {
          arguments: "{\"city\":\"Paris\"}",
          call_id: "call_0",
          name: "lookup_weather",
          status: "completed",
          type: "function_call"
        },
        {
          arguments: "{\"city\":\"Tokyo\"}",
          call_id: "call_1",
          name: "lookup_time",
          status: "completed",
          type: "function_call"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves explicit Responses tool-call ids across multiple upstream choices", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Paris\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather_primary",
                      type: "function"
                    }
                  ]
                }
              },
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Tokyo\"}",
                        name: "lookup_time"
                      },
                      id: "call_time_backup",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-multi-tool-call",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "call two tools",
          model: "client-model",
          store: false
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.output).toEqual([
        {
          arguments: "{\"city\":\"Paris\"}",
          call_id: "call_weather_primary",
          name: "lookup_weather",
          status: "completed",
          type: "function_call"
        },
        {
          arguments: "{\"city\":\"Tokyo\"}",
          call_id: "call_time_backup",
          name: "lookup_time",
          status: "completed",
          type: "function_call"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves mixed Responses text and tool calls from one upstream choice", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "I need to check the weather first.",
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Shanghai\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-mixed-tool",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "weather please",
          model: "client-model",
          store: false
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.output_text).toBe("I need to check the weather first.");
      expect(responseJson.output).toEqual([
        {
          content: [
            {
              annotations: [],
              text: "I need to check the weather first.",
              type: "output_text"
            }
          ],
          id: "msg_0",
          role: "assistant",
          status: "completed",
          type: "message"
        },
        {
          arguments: "{\"city\":\"Shanghai\"}",
          call_id: "call_weather",
          name: "lookup_weather",
          status: "completed",
          type: "function_call"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves multiple Responses tool calls from one upstream choice", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Shanghai\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather",
                      type: "function"
                    },
                    {
                      function: {
                        arguments: "{\"timezone\":\"Asia/Shanghai\"}",
                        name: "lookup_time"
                      },
                      id: "call_time",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-multi-tool-same-choice",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "need weather and time",
          model: "client-model",
          store: false
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.output_text).toBe("");
      expect(responseJson.output).toEqual([
        {
          arguments: "{\"city\":\"Shanghai\"}",
          call_id: "call_weather",
          name: "lookup_weather",
          status: "completed",
          type: "function_call"
        },
        {
          arguments: "{\"timezone\":\"Asia/Shanghai\"}",
          call_id: "call_time",
          name: "lookup_time",
          status: "completed",
          type: "function_call"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves local Responses developer messages for upstream chat completions", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "developer role converted",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-developer-role",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: [
            {
              content: "Follow developer policy",
              role: "developer"
            },
            {
              content: "Hello",
              role: "user"
            }
          ],
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        output_text: "developer role converted"
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            messages: [
              {
                content: "Follow developer policy",
                role: "developer"
              },
              {
                content: "Hello",
                role: "user"
              }
            ],
            model: "client-model",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves upstream chat completions refusal text for converted Responses requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: null,
                  refusal: "I cannot help with that request.",
                  role: "assistant"
                }
              }
            ],
            created: 1_788_000_001,
            id: "chatcmpl-refusal",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "restricted request",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        output: [
          {
            content: [
              {
                text: "I cannot help with that request.",
                type: "output_text"
              }
            ],
            role: "assistant",
            type: "message"
          }
        ],
        output_text: "I cannot help with that request."
      });
    } finally {
      await controller.stop();
    }
  });

  it("preserves upstream chat completions choice text for converted Responses requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                text: "legacy choice text"
              }
            ],
            id: "chatcmpl-choice-text",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        output_text: "legacy choice text"
      });
    } finally {
      await controller.stop();
    }
  });

  it("converts local Responses function tools and upstream tool calls", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "",
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Shanghai\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            created: 1_788_000_010,
            id: "chatcmpl-tool",
            model: "upstream-model",
            usage: {
              completion_tokens: 5,
              prompt_tokens: 11,
              total_tokens: 16
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const weatherToolParameters = {
        additionalProperties: false,
        properties: {
          city: {
            type: "string"
          }
        },
        required: ["city"],
        type: "object"
      };
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Need weather",
          model: "client-model",
          parallel_tool_calls: false,
          tool_choice: {
            name: "lookup_weather",
            type: "function"
          },
          tools: [
            {
              description: "Lookup weather.",
              name: "lookup_weather",
              parameters: weatherToolParameters,
              strict: true,
              type: "function"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "chatcmpl-tool",
        model: "upstream-model",
        object: "response",
        output: [
          {
            arguments: "{\"city\":\"Shanghai\"}",
            call_id: "call_weather",
            name: "lookup_weather",
            status: "completed",
            type: "function_call"
          }
        ],
        output_text: "",
        status: "completed",
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          total_tokens: 16
        }
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].input).toBe("http://127.0.0.1:3001/v1/chat/completions");
      expect(fetchCalls[0].body).toMatchObject({
        messages: [
          {
            content: "Need weather",
            role: "user"
          }
        ],
        model: "client-model",
        parallel_tool_calls: false,
        stream: false,
        tool_choice: {
          function: {
            name: "lookup_weather"
          },
          type: "function"
        },
        tools: [
          {
            function: {
              description: "Lookup weather.",
              name: "lookup_weather",
              parameters: weatherToolParameters,
              strict: true
            },
            type: "function"
          }
        ]
      });
    } finally {
      await controller.stop();
    }
  });

  it("converts local Responses JSON schema text format to upstream chat completions response format", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "{\"city\":\"Shanghai\"}",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-response-format",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const schema = {
        additionalProperties: false,
        properties: {
          city: {
            type: "string"
          }
        },
        required: ["city"],
        type: "object"
      };
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Return city JSON",
          model: "client-model",
          text: {
            format: {
              description: "City response.",
              name: "city_response",
              schema,
              strict: true,
              type: "json_schema"
            }
          }
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        output_text: "{\"city\":\"Shanghai\"}"
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            messages: [
              {
                content: "Return city JSON",
                role: "user"
              }
            ],
            model: "client-model",
            response_format: {
              json_schema: {
                description: "City response.",
                name: "city_response",
                schema,
                strict: true
              },
              type: "json_schema"
            },
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts local Responses JSON object text format to upstream chat completions response format", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "{\"ok\":true}",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-json-object",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Return JSON",
          model: "client-model",
          text: {
            format: {
              type: "json_object"
            }
          }
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        output_text: "{\"ok\":true}"
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            messages: [
              {
                content: "Return JSON",
                role: "user"
              }
            ],
            model: "client-model",
            response_format: {
              type: "json_object"
            },
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts legacy upstream function calls for local Responses requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "function_call",
                message: {
                  content: "",
                  function_call: {
                    arguments: "{\"city\":\"Shanghai\"}",
                    name: "lookup_weather"
                  },
                  role: "assistant"
                }
              }
            ],
            created: 1_788_000_010,
            id: "chatcmpl-legacy-function",
            model: "upstream-model",
            usage: {
              completion_tokens: 5,
              prompt_tokens: 11,
              total_tokens: 16
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Need weather",
          model: "client-model",
          tools: [
            {
              name: "lookup_weather",
              parameters: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              type: "function"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "chatcmpl-legacy-function",
        model: "upstream-model",
        output: [
          {
            arguments: "{\"city\":\"Shanghai\"}",
            call_id: "call_0",
            name: "lookup_weather",
            status: "completed",
            type: "function_call"
          }
        ],
        output_text: "",
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          total_tokens: 16
        }
      });
    } finally {
      await controller.stop();
    }
  });

  it("converts local Responses function-call history to upstream chat completions messages", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "final weather reply",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-responses-tool-history",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: [
            {
              content: "Need weather",
              role: "user"
            },
            {
              arguments: "{\"city\":\"Shanghai\"}",
              call_id: "call_weather",
              name: "lookup_weather",
              type: "function_call"
            },
            {
              call_id: "call_weather",
              output: [
                {
                  text: "Sunny, 27C",
                  type: "output_text"
                }
              ],
              type: "function_call_output"
            },
            {
              content: [
                {
                  text: "Use that result.",
                  type: "input_text"
                }
              ],
              role: "user"
            }
          ],
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "chatcmpl-responses-tool-history",
        model: "upstream-model",
        output: [
          {
            content: [
              {
                text: "final weather reply",
                type: "output_text"
              }
            ],
            role: "assistant",
            type: "message"
          }
        ],
        output_text: "final weather reply"
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            messages: [
              {
                content: "Need weather",
                role: "user"
              },
              {
                content: "",
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: "{\"city\":\"Shanghai\"}",
                      name: "lookup_weather"
                    },
                    id: "call_weather",
                    type: "function"
                  }
                ]
              },
              {
                content: "Sunny, 27C",
                role: "tool",
                tool_call_id: "call_weather"
              },
              {
                content: [
                  {
                    text: "Use that result.",
                    type: "text"
                  }
                ],
                role: "user"
              }
            ],
            model: "client-model",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts local Responses multimodal input parts to upstream chat completions content parts", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "multimodal converted reply",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-responses-multimodal",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
      const imageUrlObject = {
        detail: "high",
        ignored: "not-forwarded",
        url: "https://example.test/object-image.png"
      };
      const expectedImageUrlObject = {
        detail: "high",
        url: imageUrlObject.url
      };
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: [
            {
              content: [
                {
                  text: "describe this image",
                  type: "input_text"
                },
                {
                  detail: "low",
                  image_url: imageUrl,
                  type: "input_image"
                },
                {
                  detail: "ignored-sibling-detail",
                  image_url: imageUrlObject,
                  type: "input_image"
                },
                {
                  file_id: "ignored-file-id",
                  type: "input_file"
                }
              ],
              role: "user"
            },
            {
              content: [
                {
                  text: "prior assistant context",
                  type: "output_text"
                }
              ],
              role: "assistant"
            }
          ],
          instructions: "use visual details",
          max_output_tokens: 24,
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        output_text: "multimodal converted reply",
        status: "completed"
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 24,
            messages: [
              {
                content: "use visual details",
                role: "system"
              },
              {
                content: [
                  {
                    text: "describe this image",
                    type: "text"
                  },
                  {
                    image_url: {
                      detail: "low",
                      url: imageUrl
                    },
                    type: "image_url"
                  },
                  {
                    image_url: expectedImageUrlObject,
                    type: "image_url"
                  }
                ],
                role: "user"
              },
              {
                content: [
                  {
                    text: "prior assistant context",
                    type: "text"
                  }
                ],
                role: "assistant"
              }
            ],
            model: "client-model",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
      expect(JSON.stringify(fetchCalls[0].body)).not.toContain("ignored-file-id");
      expect(JSON.stringify(fetchCalls[0].body)).not.toContain("not-forwarded");
      expect(JSON.stringify(fetchCalls[0].body)).not.toContain("ignored-sibling-detail");
    } finally {
      await controller.stop();
    }
  });

  it("extracts array content parts for converted Responses outputs", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: [
                    "first text part",
                    {
                      text: "second text part",
                      type: "text"
                    },
                    {
                      content: "third text part",
                      type: "output_text"
                    },
                    {
                      refusal: "fourth refusal part",
                      type: "refusal"
                    },
                    {
                      image_url: {
                        url: "ignored-image-url"
                      },
                      type: "image_url"
                    }
                  ],
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-content-parts",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();
      const expectedOutput = "first text part\nsecond text part\nthird text part\nfourth refusal part";

      expect(response.status).toBe(200);
      expect(responseJson.output_text).toBe(expectedOutput);
      expect(responseJson.output[0].content[0].text).toBe(expectedOutput);
      expect(JSON.stringify(responseJson)).not.toContain("ignored-image-url");
    } finally {
      await controller.stop();
    }
  });

  it("bounds converted non-streaming upstream response bodies", async () => {
    const controller = createRouteProxyController({
      maxConvertedResponseBodyBytes: 64,
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "x".repeat(160),
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-large",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "Upstream response body is too large."
      });
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "Upstream response body is too large.",
          ok: false,
          path: "/v1/responses",
          statusCode: 502,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("bounds converted non-streaming response metadata fields", async () => {
    const longId = `chatcmpl-${"i".repeat(700)}`;
    const longModel = `model-${"m".repeat(700)}`;
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "metadata reply",
                  role: "owner"
                }
              }
            ],
            id: longId,
            model: longModel
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.id).toHaveLength(512);
      expect(responseJson.model).toHaveLength(512);
      expect(responseJson.output[0].role).toBe("assistant");
      expect(JSON.stringify(responseJson)).not.toContain("i".repeat(600));
      expect(JSON.stringify(responseJson)).not.toContain("m".repeat(600));
      expect(responseJson.output_text).toBe("metadata reply");
    } finally {
      await controller.stop();
    }
  });

  it("normalizes converted Responses usage fields", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "usage reply",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-usage",
            model: "upstream-model",
            usage: {
              completion_tokens: 2,
              nested: {
                value: "nested-usage-value"
              },
              prompt_tokens: 4,
              prompt_tokens_details: {
                cached_tokens: 1
              },
              total_tokens: 1_500_000_000,
              vendor_payload: "vendor-usage-value"
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.usage).toEqual({
        input_tokens: 4,
        output_tokens: 2,
        total_tokens: 1_000_000_000
      });
      expect(JSON.stringify(responseJson)).not.toContain("nested-usage-value");
      expect(JSON.stringify(responseJson)).not.toContain("vendor-usage-value");
      expect(JSON.stringify(responseJson)).not.toContain("prompt_tokens_details");
    } finally {
      await controller.stop();
    }
  });

  it("keeps Responses requests on the upstream Responses path when the target is Responses-native", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(JSON.stringify({ output_text: "native responses" }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "https://api.openai.com/v1", undefined, "responses");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ output_text: "native responses" });
      expect(fetchCalls).toEqual([
        {
          body: {
            input: "hello",
            model: "client-model"
          },
          input: "https://api.openai.com/v1/responses"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("keeps official OpenAI auto Responses requests on the upstream Responses path", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(JSON.stringify({ output_text: "official auto responses" }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "https://api.openai.com/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ output_text: "official auto responses" });
      expect(fetchCalls).toEqual([
        {
          body: {
            input: "hello",
            model: "client-model"
          },
          input: "https://api.openai.com/v1/responses"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("bridges streaming local Responses requests to upstream chat completions SSE", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              'data: {"id":"chatcmpl-stream","created":1788000010,"model":"upstream-stream","choices":[{"delta":{"role":"assistant","content":"Hel"},"index":0}]}\n\n',
              'data: {"id":"chatcmpl-stream","created":1788000010,"model":"upstream-stream","choices":[{"delta":{"content":"lo"},"finish_reason":"stop","index":0}],"usage":{"total_tokens":5}}\n\n',
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        fetchCalls.push({
          body: JSON.parse(bodyText),
          headers: headersToRecord(init?.headers),
          input
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          max_output_tokens: 48,
          model: "client-model",
          stream: true
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "api-key": "client-api-key-secret",
          authorization: "Bearer client-secret",
          "content-type": "application/json",
          "x-api-key": "client-x-api-key-secret"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(responseText).toContain("event: response.created");
      expect(responseText).toContain("event: response.output_text.delta");
      expect(responseText).toContain('"delta":"Hel"');
      expect(responseText).toContain('"delta":"lo"');
      expect(responseText).toContain("event: response.output_text.done");
      expect(responseText).toContain('"text":"Hello"');
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain('"output_text":"Hello"');
      expect(responseText).toContain('"total_tokens":5');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].input).toBe("http://127.0.0.1:3001/v1/chat/completions");
      expect(fetchCalls[0].headers.authorization).toBe("Bearer encrypted-primary");
      expect(fetchCalls[0].headers.authorization).not.toBe("Bearer client-secret");
      expect(fetchCalls[0].headers["anthropic-version"]).toBeUndefined();
      expect(fetchCalls[0].headers["api-key"]).toBeUndefined();
      expect(fetchCalls[0].headers["x-api-key"]).toBeUndefined();
      expect(fetchCalls[0].body).toMatchObject({
        max_tokens: 48,
        messages: [
          {
            content: "hello",
            role: "user"
          }
        ],
        model: "client-model",
        stream: true
      });
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "",
          ok: true,
          path: "/v1/responses",
          statusCode: 200,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves streaming upstream chat completions refusal deltas for converted Responses requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              'data: {"id":"chatcmpl-refusal-stream","created":1788000011,"model":"upstream-stream","choices":[{"delta":{"role":"assistant","refusal":"I cannot help."},"index":0}]}\n\n',
              'data: {"id":"chatcmpl-refusal-stream","created":1788000011,"model":"upstream-stream","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "restricted request",
          model: "client-model",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: response.output_text.delta");
      expect(responseText).toContain('"delta":"I cannot help."');
      expect(responseText).toContain("event: response.output_text.done");
      expect(responseText).toContain('"text":"I cannot help."');
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain('"output_text":"I cannot help."');
    } finally {
      await controller.stop();
    }
  });

  it("converts streaming local Responses tool-call deltas from upstream chat completions SSE", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\"",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        }
                      ]
                    },
                    index: 0
                  }
                ],
                created: 1_788_000_010,
                id: "chatcmpl-tool-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: {
                            arguments: ":\"Shanghai\"}"
                          },
                          index: 0
                        }
                      ]
                    },
                    finish_reason: "tool_calls",
                    index: 0
                  }
                ],
                id: "chatcmpl-tool-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 4,
                  prompt_tokens: 9,
                  total_tokens: 13
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const weatherToolParameters = {
        properties: {
          city: {
            type: "string"
          }
        },
        required: ["city"],
        type: "object"
      };
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Need weather",
          model: "client-model",
          stream: true,
          tool_choice: "required",
          tools: [
            {
              name: "lookup_weather",
              parameters: weatherToolParameters,
              type: "function"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: response.created");
      expect(responseText).toContain("event: response.output_item.added");
      expect(responseText).toContain("event: response.function_call_arguments.delta");
      expect(responseText).toContain("event: response.function_call_arguments.done");
      expect(responseText).toContain("event: response.output_item.done");
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain('"call_id":"call_weather"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain('"arguments":"{\\"city\\":\\"Shanghai\\"}"');
      expect(responseText).toContain('"output_text":""');
      expect(responseText).toContain('"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}');
      expect(responseText).not.toContain("event: response.output_text.delta");
      expect(responseText).not.toContain("event: response.output_text.done");
      expect(fetchCalls).toEqual([
        {
          body: {
            messages: [
              {
                content: "Need weather",
                role: "user"
              }
            ],
            model: "client-model",
            stream: true,
            tool_choice: "required",
            tools: [
              {
                function: {
                  name: "lookup_weather",
                  parameters: weatherToolParameters
                },
                type: "function"
              }
            ]
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts legacy streaming local Responses function-call deltas from upstream chat completions SSE", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      function_call: {
                        arguments: "{\"city\"",
                        name: "lookup_weather"
                      },
                      role: "assistant"
                    },
                    index: 0
                  }
                ],
                created: 1_788_000_010,
                id: "chatcmpl-legacy-function-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      function_call: {
                        arguments: ":\"Shanghai\"}"
                      }
                    },
                    finish_reason: "function_call",
                    index: 0
                  }
                ],
                id: "chatcmpl-legacy-function-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 4,
                  prompt_tokens: 9,
                  total_tokens: 13
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Need weather",
          model: "client-model",
          stream: true,
          tool_choice: "required",
          tools: [
            {
              name: "lookup_weather",
              parameters: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              type: "function"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: response.output_item.added");
      expect(responseText).toContain("event: response.function_call_arguments.delta");
      expect(responseText).toContain("event: response.function_call_arguments.done");
      expect(responseText).toContain("event: response.output_item.done");
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain('"call_id":"call_0"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain('"arguments":"{\\"city\\":\\"Shanghai\\"}"');
      expect(responseText).toContain('"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}');
      expect(responseText).not.toContain("event: response.output_text.delta");
      expect(responseText).not.toContain("event: response.output_text.done");
    } finally {
      await controller.stop();
    }
  });

  it("keeps multiple streaming Responses tool-call deltas separated by upstream index", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\"",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        },
                        {
                          function: {
                            arguments: "{\"timezone\"",
                            name: "lookup_time"
                          },
                          id: "call_time",
                          index: 1,
                          type: "function"
                        }
                      ]
                    },
                    index: 0
                  }
                ],
                created: 1_788_000_010,
                id: "chatcmpl-multi-tool-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: {
                            arguments: ":\"Asia/Shanghai\"}"
                          },
                          index: 1
                        },
                        {
                          function: {
                            arguments: ":\"Shanghai\"}"
                          },
                          index: 0
                        }
                      ]
                    },
                    finish_reason: "tool_calls",
                    index: 0
                  }
                ],
                id: "chatcmpl-multi-tool-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 8,
                  prompt_tokens: 14,
                  total_tokens: 22
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Need weather and time",
          model: "client-model",
          stream: true,
          tool_choice: "required",
          tools: [
            {
              name: "lookup_weather",
              parameters: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              type: "function"
            },
            {
              name: "lookup_time",
              parameters: {
                properties: {
                  timezone: {
                    type: "string"
                  }
                },
                required: ["timezone"],
                type: "object"
              },
              type: "function"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText.match(/event: response\.output_item\.added/g) ?? []).toHaveLength(2);
      expect(responseText.match(/event: response\.output_item\.done/g) ?? []).toHaveLength(2);
      expect(responseText).toContain('"output_index":0');
      expect(responseText).toContain('"output_index":1');
      expect(responseText).toContain('"call_id":"call_weather"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain('"arguments":"{\\"city\\":\\"Shanghai\\"}"');
      expect(responseText).toContain('"call_id":"call_time"');
      expect(responseText).toContain('"name":"lookup_time"');
      expect(responseText).toContain('"arguments":"{\\"timezone\\":\\"Asia/Shanghai\\"}"');
      expect(responseText).toContain('"usage":{"input_tokens":14,"output_tokens":8,"total_tokens":22}');
      expect(responseText).not.toContain("event: response.output_text.delta");
      expect(responseText).not.toContain("event: response.output_text.done");
    } finally {
      await controller.stop();
    }
  });

  it("keeps mixed streaming Responses text before upstream tool-call deltas", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "Let me check.",
                      role: "assistant"
                    },
                    index: 0
                  }
                ],
                created: 1_788_000_010,
                id: "chatcmpl-mixed-tool-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\":\"Shanghai\"}",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        }
                      ]
                    },
                    finish_reason: "tool_calls",
                    index: 0
                  }
                ],
                id: "chatcmpl-mixed-tool-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 6,
                  prompt_tokens: 10,
                  total_tokens: 16
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Need weather",
          model: "client-model",
          stream: true,
          tool_choice: "required",
          tools: [
            {
              name: "lookup_weather",
              parameters: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              type: "function"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();
      const textDeltaIndex = responseText.indexOf("event: response.output_text.delta");
      const toolAddedIndex = responseText.indexOf("event: response.output_item.added");
      const completedIndex = responseText.indexOf("event: response.completed");

      expect(response.status).toBe(200);
      expect(textDeltaIndex).toBeGreaterThanOrEqual(0);
      expect(toolAddedIndex).toBeGreaterThan(textDeltaIndex);
      expect(completedIndex).toBeGreaterThan(toolAddedIndex);
      expect(responseText).toContain('"output_index":0');
      expect(responseText).toContain('"output_index":1');
      expect(responseText).toContain('"text":"Let me check."');
      expect(responseText).toContain('"output_text":"Let me check."');
      expect(responseText).toContain('"call_id":"call_weather"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain('"arguments":"{\\"city\\":\\"Shanghai\\"}"');
      expect(responseText).toContain('"usage":{"input_tokens":10,"output_tokens":6,"total_tokens":16}');
    } finally {
      await controller.stop();
    }
  });

  it("keeps mixed streaming Responses tool-call output before later text deltas", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\":\"Shanghai\"}",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        }
                      ]
                    },
                    index: 0
                  }
                ],
                created: 1_788_000_010,
                id: "chatcmpl-tool-before-text-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "Weather lookup queued."
                    },
                    finish_reason: "stop",
                    index: 0
                  }
                ],
                id: "chatcmpl-tool-before-text-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 7,
                  prompt_tokens: 10,
                  total_tokens: 17
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "Need weather",
          model: "client-model",
          stream: true,
          tool_choice: "required",
          tools: [
            {
              name: "lookup_weather",
              parameters: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              type: "function"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();
      const toolAddedIndex = responseText.indexOf("event: response.output_item.added");
      const toolDoneIndex = responseText.indexOf("event: response.output_item.done");
      const textDeltaIndex = responseText.indexOf("event: response.output_text.delta");
      const completedDataLine = responseText
        .split("\n")
        .find((line) => line.startsWith("data: ") && line.includes('"type":"response.completed"'));
      const completedEvent = JSON.parse((completedDataLine ?? "data: {}").slice("data: ".length));

      expect(response.status).toBe(200);
      expect(toolAddedIndex).toBeGreaterThanOrEqual(0);
      expect(toolDoneIndex).toBeGreaterThan(toolAddedIndex);
      expect(textDeltaIndex).toBeGreaterThan(toolDoneIndex);
      expect(responseText).toContain('"output_index":0');
      expect(responseText).toContain('"output_index":1');
      expect(responseText).toContain('"call_id":"call_weather"');
      expect(responseText).toContain('"arguments":"{\\"city\\":\\"Shanghai\\"}"');
      expect(responseText).toContain('"text":"Weather lookup queued."');
      expect(responseText).toContain('"usage":{"input_tokens":10,"output_tokens":7,"total_tokens":17}');
      expect(completedEvent.response.output).toMatchObject([
        {
          arguments: "{\"city\":\"Shanghai\"}",
          call_id: "call_weather",
          name: "lookup_weather",
          type: "function_call"
        },
        {
          content: [
            {
              text: "Weather lookup queued.",
              type: "output_text"
            }
          ],
          type: "message"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("normalizes converted streaming Responses usage fields", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              'data: {"id":"chatcmpl-stream-usage","created":1788000010,"model":"upstream-stream","choices":[{"delta":{"role":"assistant","content":"Stream"},"index":0}]}\n\n',
              'data: {"id":"chatcmpl-stream-usage","created":1788000010,"model":"upstream-stream","choices":[{"delta":{"content":" usage"},"finish_reason":"stop","index":0}],"usage":{"completion_tokens":2,"nested":{"value":"nested-stream-usage"},"prompt_tokens":4,"prompt_tokens_details":{"cached_tokens":1},"total_tokens":1500000000,"vendor_payload":"vendor-stream-usage"}}\n\n',
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain('"output_text":"Stream usage"');
      expect(responseText).toContain('"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":1000000000}');
      expect(responseText).not.toContain("nested-stream-usage");
      expect(responseText).not.toContain("vendor-stream-usage");
      expect(responseText).not.toContain("prompt_tokens_details");
    } finally {
      await controller.stop();
    }
  });

  it("extracts array content parts for converted streaming Responses deltas", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: [
                        "first stream part",
                        {
                          text: "second stream part",
                          type: "text"
                        },
                        {
                          content: "third stream part",
                          type: "output_text"
                        },
                        {
                          refusal: "fourth stream refusal part",
                          type: "refusal"
                        },
                        {
                          image_url: {
                            url: "ignored-stream-image-url"
                          },
                          type: "image_url"
                        }
                      ],
                      role: "assistant"
                    },
                    index: 0
                  }
                ],
                id: "chatcmpl-stream-parts",
                model: "upstream-stream"
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();
      const expectedOutput = "first stream part\\nsecond stream part\\nthird stream part\\nfourth stream refusal part";

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: response.output_text.delta");
      expect(responseText).toContain(`"delta":"${expectedOutput}"`);
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain(`"output_text":"${expectedOutput}"`);
      expect(responseText).not.toContain("ignored-stream-image-url");
    } finally {
      await controller.stop();
    }
  });

  it("bounds converted streaming upstream SSE event buffers", async () => {
    const controller = createRouteProxyController({
      maxConvertedStreamEventBytes: 64,
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            streamController.enqueue(encoder.encode(`data: ${"x".repeat(160)}`));
            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).not.toContain("x".repeat(80));
      expect(responseText).not.toContain("response.completed");
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "Upstream SSE event is too large.",
          ok: false,
          path: "/v1/responses",
          statusCode: 200,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("bounds converted streaming accumulated Responses output text", async () => {
    const controller = createRouteProxyController({
      maxConvertedStreamOutputBytes: 8,
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              'data: {"id":"chatcmpl-output","model":"upstream-stream","choices":[{"delta":{"role":"assistant","content":"abc"},"index":0}]}\n\n',
              'data: {"id":"chatcmpl-output","model":"upstream-stream","choices":[{"delta":{"content":"def"},"index":0}]}\n\n',
              'data: {"id":"chatcmpl-output","model":"upstream-stream","choices":[{"delta":{"content":"ghi"},"finish_reason":"stop","index":0}]}\n\n'
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain('"delta":"abc"');
      expect(responseText).toContain('"delta":"def"');
      expect(responseText).not.toContain('"delta":"ghi"');
      expect(responseText).not.toContain("response.completed");
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "Converted stream output is too large.",
          ok: false,
          path: "/v1/responses",
          statusCode: 200,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("bounds converted streaming response metadata fields", async () => {
    const longId = `chatcmpl-${"i".repeat(700)}`;
    const longModel = `model-${"m".repeat(700)}`;
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            streamController.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      delta: {
                        content: "ok",
                        role: "owner"
                      },
                      index: 0
                    }
                  ],
                  id: longId,
                  model: longModel
                })}\n\n`
              )
            );
            streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: response.created");
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain('"role":"assistant"');
      expect(responseText).not.toContain("i".repeat(600));
      expect(responseText).not.toContain("m".repeat(600));
      expect(responseText).toContain('"output_text":"ok"');
    } finally {
      await controller.stop();
    }
  });

  it("returns a client error when a converted Responses request is not JSON", async () => {
    const providerFetch = vi.fn();
    const controller = createRouteProxyController({
      providerFetch
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: "{not-json",
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Responses conversion requires a JSON request body."
      });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "Responses conversion requires a JSON request body.",
          ok: false,
          path: "/v1/responses",
          statusCode: 400,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("passes upstream HTTP errors through for converted Responses requests", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(JSON.stringify({ error: { message: "upstream rejected" } }), {
          headers: {
            "content-type": "application/json"
          },
          status: 401
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/responses`, {
        body: JSON.stringify({
          input: "hello",
          model: "client-model"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: { message: "upstream rejected" } });
      expect(fetchCalls).toMatchObject([
        {
          body: {
            messages: [
              {
                content: "hello",
                role: "user"
              }
            ],
            model: "client-model",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "HTTP 401",
          ok: false,
          path: "/v1/responses",
          statusCode: 401,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts local Anthropic Messages requests to upstream chat completions when the target is OpenAI-compatible", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          headers: headersToRecord(init?.headers),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: [
                    {
                      text: "anthropic bridge reply",
                      type: "text"
                    }
                  ],
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-anthropic-bridge",
            model: "upstream-model",
            usage: {
              completion_tokens: 4,
              prompt_tokens: 3,
              total_tokens: 7
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [
            {
              content: [
                {
                  text: "describe this image",
                  type: "text"
                },
                {
                  source: {
                    data: "iVBORw0KGgo=",
                    media_type: "image/png",
                    type: "base64"
                  },
                  type: "image"
                }
              ],
              role: "user"
            },
            {
              content: "prior reply",
              role: "assistant"
            }
          ],
          metadata: {
            user_id: "local-user"
          },
          model: "claude-client",
          stop_sequences: ["END"],
          system: [
            {
              text: "be concise",
              type: "text"
            }
          ],
          temperature: 0.2,
          top_p: 0.9
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "api-key": "client-api-key-secret",
          authorization: "Bearer client-secret",
          "content-type": "application/json",
          "x-api-key": "client-x-api-key-secret"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [
          {
            text: "anthropic bridge reply",
            type: "text"
          }
        ],
        id: "chatcmpl-anthropic-bridge",
        model: "upstream-model",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: {
          input_tokens: 3,
          output_tokens: 4
        }
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].input).toBe("http://127.0.0.1:3001/v1/chat/completions");
      expect(fetchCalls[0].headers.authorization).toBe("Bearer encrypted-primary");
      expect(fetchCalls[0].headers.authorization).not.toBe("Bearer client-secret");
      expect(fetchCalls[0].headers["anthropic-version"]).toBeUndefined();
      expect(fetchCalls[0].headers["api-key"]).toBeUndefined();
      expect(fetchCalls[0].headers["x-api-key"]).toBeUndefined();
      expect(fetchCalls[0].body).toMatchObject({
        max_tokens: 64,
        messages: [
          {
            content: "be concise",
            role: "system"
          },
          {
            content: [
              {
                text: "describe this image",
                type: "text"
              },
              {
                image_url: {
                  url: "data:image/png;base64,iVBORw0KGgo="
                },
                type: "image_url"
              }
            ],
            role: "user"
          },
          {
            content: "prior reply",
            role: "assistant"
          }
        ],
        model: "claude-client",
        stop: ["END"],
        stream: false,
        temperature: 0.2,
        top_p: 0.9,
        user: "local-user"
      });
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "",
          ok: true,
          path: "/v1/messages",
          statusCode: 200,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves multiple upstream chat completions choices for converted Anthropic Messages requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "first anthropic choice",
                  role: "assistant"
                }
              },
              {
                finish_reason: "stop",
                message: {
                  content: "second anthropic choice",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-anthropic-multi-choice",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [
            {
              content: "return two choices",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.content).toEqual([
        {
          text: "first anthropic choice",
          type: "text"
        },
        {
          text: "second anthropic choice",
          type: "text"
        }
      ]);
      expect(responseJson).toMatchObject({
        id: "chatcmpl-anthropic-multi-choice",
        model: "upstream-model",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message"
      });
    } finally {
      await controller.stop();
    }
  });

  it("uses tool_use stop reason when a later upstream choice contains Anthropic tool use", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "I need one more check.",
                  role: "assistant"
                }
              },
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Shanghai\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-anthropic-later-tool-choice",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [
            {
              content: "weather please",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.content).toEqual([
        {
          text: "I need one more check.",
          type: "text"
        },
        {
          id: "call_weather",
          input: {
            city: "Shanghai"
          },
          name: "lookup_weather",
          type: "tool_use"
        }
      ]);
      expect(responseJson.stop_reason).toBe("tool_use");
    } finally {
      await controller.stop();
    }
  });

  it("keeps generated Anthropic tool-use ids unique across multiple upstream choices", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "function_call",
                message: {
                  function_call: {
                    arguments: "{\"city\":\"Paris\"}",
                    name: "lookup_weather"
                  },
                  role: "assistant"
                }
              },
              {
                finish_reason: "function_call",
                message: {
                  function_call: {
                    arguments: "{\"city\":\"Tokyo\"}",
                    name: "lookup_time"
                  },
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-anthropic-multi-function-call",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [
            {
              content: "call two tools",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.content).toEqual([
        {
          id: "toolu_0",
          input: {
            city: "Paris"
          },
          name: "lookup_weather",
          type: "tool_use"
        },
        {
          id: "toolu_1",
          input: {
            city: "Tokyo"
          },
          name: "lookup_time",
          type: "tool_use"
        }
      ]);
      expect(responseJson.stop_reason).toBe("tool_use");
    } finally {
      await controller.stop();
    }
  });

  it("preserves explicit Anthropic tool-use ids across multiple upstream choices", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Paris\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather_primary",
                      type: "function"
                    }
                  ]
                }
              },
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Tokyo\"}",
                        name: "lookup_time"
                      },
                      id: "call_time_backup",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-anthropic-multi-tool-call",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [
            {
              content: "call two tools",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.content).toEqual([
        {
          id: "call_weather_primary",
          input: {
            city: "Paris"
          },
          name: "lookup_weather",
          type: "tool_use"
        },
        {
          id: "call_time_backup",
          input: {
            city: "Tokyo"
          },
          name: "lookup_time",
          type: "tool_use"
        }
      ]);
      expect(responseJson.stop_reason).toBe("tool_use");
    } finally {
      await controller.stop();
    }
  });

  it("preserves mixed Anthropic text and tool use from one upstream choice", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "I need to check the weather first.",
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Shanghai\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-anthropic-mixed-tool",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [
            {
              content: "weather please",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.content).toEqual([
        {
          text: "I need to check the weather first.",
          type: "text"
        },
        {
          id: "call_weather",
          input: {
            city: "Shanghai"
          },
          name: "lookup_weather",
          type: "tool_use"
        }
      ]);
      expect(responseJson.stop_reason).toBe("tool_use");
    } finally {
      await controller.stop();
    }
  });

  it("preserves multiple Anthropic tool-use blocks from one upstream choice", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Shanghai\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather",
                      type: "function"
                    },
                    {
                      function: {
                        arguments: "{\"timezone\":\"Asia/Shanghai\"}",
                        name: "lookup_time"
                      },
                      id: "call_time",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-anthropic-multi-tool-same-choice",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [
            {
              content: "need weather and time",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseJson = await response.json();

      expect(response.status).toBe(200);
      expect(responseJson.content).toEqual([
        {
          id: "call_weather",
          input: {
            city: "Shanghai"
          },
          name: "lookup_weather",
          type: "tool_use"
        },
        {
          id: "call_time",
          input: {
            timezone: "Asia/Shanghai"
          },
          name: "lookup_time",
          type: "tool_use"
        }
      ]);
      expect(responseJson.stop_reason).toBe("tool_use");
    } finally {
      await controller.stop();
    }
  });

  it("preserves upstream chat completions refusal text for converted Anthropic Messages requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: null,
                  refusal: "I cannot help with that request.",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-anthropic-refusal",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "restricted request",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [
          {
            text: "I cannot help with that request.",
            type: "text"
          }
        ],
        id: "chatcmpl-anthropic-refusal",
        model: "upstream-model",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message"
      });
    } finally {
      await controller.stop();
    }
  });

  it("preserves upstream chat completions choice text for converted Anthropic Messages requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                text: "legacy anthropic choice text"
              }
            ],
            id: "chatcmpl-anthropic-choice-text",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "hello",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [
          {
            text: "legacy anthropic choice text",
            type: "text"
          }
        ],
        id: "chatcmpl-anthropic-choice-text",
        type: "message"
      });
    } finally {
      await controller.stop();
    }
  });

  it("maps Anthropic URL image content and max-token stop reasons during conversion", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "length",
                message: {
                  content: "truncated reply",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-length",
            model: "upstream-model",
            usage: {
              completion_tokens: 8,
              prompt_tokens: 5,
              total_tokens: 13
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [
            {
              content: [
                {
                  text: "inspect",
                  type: "text"
                },
                {
                  source: {
                    type: "url",
                    url: "https://example.test/image.png"
                  },
                  type: "image"
                }
              ],
              role: "user"
            }
          ],
          model: "claude-client",
          system: "short"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [
          {
            text: "truncated reply",
            type: "text"
          }
        ],
        stop_reason: "max_tokens",
        usage: {
          input_tokens: 5,
          output_tokens: 8
        }
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 16,
            messages: [
              {
                content: "short",
                role: "system"
              },
              {
                content: [
                  {
                    text: "inspect",
                    type: "text"
                  },
                  {
                    image_url: {
                      url: "https://example.test/image.png"
                    },
                    type: "image_url"
                  }
                ],
                role: "user"
              }
            ],
            model: "claude-client",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("maps Anthropic tool-use stop reasons during conversion", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "tool call requested",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-tool-use",
            model: "upstream-model",
            usage: {
              completion_tokens: 3,
              prompt_tokens: 6,
              total_tokens: 9
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 24,
          messages: [
            {
              content: "use a tool if needed",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [
          {
            text: "tool call requested",
            type: "text"
          }
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 6,
          output_tokens: 3
        }
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 24,
            messages: [
              {
                content: "use a tool if needed",
                role: "user"
              }
            ],
            model: "claude-client",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts local Anthropic tools and upstream tool calls", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "",
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"city\":\"Shanghai\"}",
                        name: "lookup_weather"
                      },
                      id: "call_weather",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-anthropic-tool",
            model: "upstream-model",
            usage: {
              completion_tokens: 7,
              prompt_tokens: 12,
              total_tokens: 19
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const inputSchema = {
        additionalProperties: false,
        properties: {
          city: {
            type: "string"
          }
        },
        required: ["city"],
        type: "object"
      };
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "Need weather",
              role: "user"
            }
          ],
          model: "claude-client",
          tool_choice: {
            disable_parallel_tool_use: true,
            name: "lookup_weather",
            type: "tool"
          },
          tools: [
            {
              description: "Lookup weather.",
              input_schema: inputSchema,
              name: "lookup_weather"
            },
            {
              name: "web_search",
              type: "web_search_20250305"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      const responseJson = await response.json();
      expect(responseJson).toMatchObject({
        id: "chatcmpl-anthropic-tool",
        model: "upstream-model",
        role: "assistant",
        stop_reason: "tool_use",
        stop_sequence: null,
        type: "message",
        usage: {
          input_tokens: 12,
          output_tokens: 7
        }
      });
      expect(responseJson.content).toEqual([
        {
          id: "call_weather",
          input: {
            city: "Shanghai"
          },
          name: "lookup_weather",
          type: "tool_use"
        }
      ]);
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 32,
            messages: [
              {
                content: "Need weather",
                role: "user"
              }
            ],
            model: "claude-client",
            parallel_tool_calls: false,
            stream: false,
            tool_choice: {
              function: {
                name: "lookup_weather"
              },
              type: "function"
            },
            tools: [
              {
                function: {
                  description: "Lookup weather.",
                  name: "lookup_weather",
                  parameters: inputSchema
                },
                type: "function"
              }
            ]
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts legacy upstream function calls to Anthropic tool use", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "function_call",
                message: {
                  content: "",
                  function_call: {
                    arguments: "{\"city\":\"Shanghai\"}",
                    name: "lookup_weather"
                  },
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-anthropic-legacy-function",
            model: "upstream-model",
            usage: {
              completion_tokens: 7,
              prompt_tokens: 12,
              total_tokens: 19
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "Need weather",
              role: "user"
            }
          ],
          model: "claude-client",
          tools: [
            {
              input_schema: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              name: "lookup_weather"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [
          {
            id: "toolu_0",
            input: {
              city: "Shanghai"
            },
            name: "lookup_weather",
            type: "tool_use"
          }
        ],
        id: "chatcmpl-anthropic-legacy-function",
        model: "upstream-model",
        stop_reason: "tool_use",
        usage: {
          input_tokens: 12,
          output_tokens: 7
        }
      });
    } finally {
      await controller.stop();
    }
  });

  it("converts local Anthropic tool-use and tool-result history to upstream chat completions messages", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "final weather reply",
                  role: "assistant"
                }
              }
            ],
            id: "chatcmpl-anthropic-tool-history",
            model: "upstream-model"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 48,
          messages: [
            {
              content: "Need weather",
              role: "user"
            },
            {
              content: [
                {
                  id: "toolu_weather",
                  input: {
                    city: "Shanghai"
                  },
                  name: "lookup_weather",
                  type: "tool_use"
                }
              ],
              role: "assistant"
            },
            {
              content: [
                {
                  content: "Sunny, 27C",
                  tool_use_id: "toolu_weather",
                  type: "tool_result"
                },
                {
                  text: "Use that result.",
                  type: "text"
                }
              ],
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [
          {
            text: "final weather reply",
            type: "text"
          }
        ],
        id: "chatcmpl-anthropic-tool-history",
        model: "upstream-model",
        stop_reason: "end_turn"
      });
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 48,
            messages: [
              {
                content: "Need weather",
                role: "user"
              },
              {
                content: "",
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: "{\"city\":\"Shanghai\"}",
                      name: "lookup_weather"
                    },
                    id: "toolu_weather",
                    type: "function"
                  }
                ]
              },
              {
                content: "Sunny, 27C",
                role: "tool",
                tool_call_id: "toolu_weather"
              },
              {
                content: [
                  {
                    text: "Use that result.",
                    type: "text"
                  }
                ],
                role: "user"
              }
            ],
            model: "claude-client",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("passes upstream HTTP errors through for converted Anthropic Messages requests", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(JSON.stringify({ error: { message: "anthropic upstream rejected" } }), {
          headers: {
            "content-type": "application/json"
          },
          status: 401
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [
            {
              content: "hello",
              role: "user"
            }
          ],
          model: "claude-client"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: { message: "anthropic upstream rejected" } });
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 16,
            messages: [
              {
                content: "hello",
                role: "user"
              }
            ],
            model: "claude-client",
            stream: false
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "HTTP 401",
          ok: false,
          path: "/v1/messages",
          statusCode: 401,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("keeps Anthropic Messages requests on the upstream Messages path when the target is Anthropic-native", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(JSON.stringify({ content: [{ text: "native anthropic", type: "text" }] }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }
    });

    try {
      const target = createAnthropicRouteProxyTarget("anthropic-primary", "https://api.anthropic.com/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const body = {
        max_tokens: 32,
        messages: [
          {
            content: "hello",
            role: "user"
          }
        ],
        model: "claude-client"
      };
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ content: [{ text: "native anthropic", type: "text" }] });
      expect(fetchCalls).toEqual([
        {
          body,
          input: "https://api.anthropic.com/v1/messages"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("returns a client error when a converted Anthropic Messages request is not JSON", async () => {
    const providerFetch = vi.fn();
    const controller = createRouteProxyController({
      providerFetch
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: "{not-json",
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Anthropic Messages conversion requires a JSON request body."
      });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "Anthropic Messages conversion requires a JSON request body.",
          ok: false,
          path: "/v1/messages",
          statusCode: 400,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("bridges streaming local Anthropic Messages requests to upstream chat completions SSE", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              'data: {"id":"chatcmpl-anthropic-stream","model":"upstream-stream","choices":[{"delta":{"role":"assistant","content":"Hel"},"index":0}]}\n\n',
              "data: ping\n\n",
              'data: {"id":"chatcmpl-anthropic-stream","model":"upstream-stream","choices":[{"delta":{"content":"lo"},"finish_reason":"stop","index":0}],"usage":{"completion_tokens":2,"prompt_tokens":3,"total_tokens":5}}\n\n',
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        fetchCalls.push({
          body: JSON.parse(bodyText),
          headers: headersToRecord(init?.headers),
          input
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "hello",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "api-key": "client-api-key-secret",
          authorization: "Bearer client-secret",
          "content-type": "application/json",
          "x-api-key": "client-x-api-key-secret"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(responseText).toContain("event: message_start");
      expect(responseText).toContain('"type":"message_start"');
      expect(responseText).toContain('"id":"chatcmpl-anthropic-stream"');
      expect(responseText).toContain('"model":"upstream-stream"');
      expect(responseText).toContain("event: content_block_start");
      expect(responseText).toContain("event: content_block_delta");
      expect(responseText).toContain('"text":"Hel"');
      expect(responseText).toContain('"text":"lo"');
      expect(responseText).toContain("event: content_block_stop");
      expect(responseText).toContain("event: message_delta");
      expect(responseText).toContain('"stop_reason":"end_turn"');
      expect(responseText).toContain('"output_tokens":2');
      expect(responseText).toContain("event: message_stop");
      expect(responseText).not.toContain("ping");
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].input).toBe("http://127.0.0.1:3001/v1/chat/completions");
      expect(fetchCalls[0].headers.authorization).toBe("Bearer encrypted-primary");
      expect(fetchCalls[0].headers.authorization).not.toBe("Bearer client-secret");
      expect(fetchCalls[0].headers["anthropic-version"]).toBeUndefined();
      expect(fetchCalls[0].headers["api-key"]).toBeUndefined();
      expect(fetchCalls[0].headers["x-api-key"]).toBeUndefined();
      expect(fetchCalls[0].body).toMatchObject({
        max_tokens: 32,
        messages: [
          {
            content: "hello",
            role: "user"
          }
        ],
        model: "claude-client",
        stream: true
      });
      expect(controller.getRequestLogs()).toMatchObject([
        {
          error: "",
          ok: true,
          path: "/v1/messages",
          statusCode: 200,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves streaming upstream chat completions refusal deltas for converted Anthropic Messages requests", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              'data: {"id":"chatcmpl-anthropic-refusal-stream","model":"upstream-stream","choices":[{"delta":{"role":"assistant","refusal":"I cannot help."},"index":0}]}\n\n',
              'data: {"id":"chatcmpl-anthropic-refusal-stream","model":"upstream-stream","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "restricted request",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: content_block_start");
      expect(responseText).toContain("event: content_block_delta");
      expect(responseText).toContain('"type":"text_delta"');
      expect(responseText).toContain('"text":"I cannot help."');
      expect(responseText).toContain("event: content_block_stop");
      expect(responseText).toContain("event: message_delta");
      expect(responseText).toContain('"stop_reason":"end_turn"');
      expect(responseText).toContain("event: message_stop");
    } finally {
      await controller.stop();
    }
  });

  it("converts streaming local Anthropic tool-use deltas from upstream chat completions SSE", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\"",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        }
                      ]
                    },
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-tool-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: {
                            arguments: ":\"Shanghai\"}"
                          },
                          index: 0
                        }
                      ]
                    },
                    finish_reason: "tool_calls",
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-tool-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 4,
                  prompt_tokens: 9,
                  total_tokens: 13
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const inputSchema = {
        properties: {
          city: {
            type: "string"
          }
        },
        required: ["city"],
        type: "object"
      };
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "Need weather",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true,
          tool_choice: {
            type: "any"
          },
          tools: [
            {
              input_schema: inputSchema,
              name: "lookup_weather"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: message_start");
      expect(responseText).toContain("event: content_block_start");
      expect(responseText).toContain('"type":"tool_use"');
      expect(responseText).toContain('"id":"call_weather"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain("event: content_block_delta");
      expect(responseText).toContain('"type":"input_json_delta"');
      expect(responseText).toContain('"partial_json":"{\\"city\\""');
      expect(responseText).toContain('"partial_json":":\\"Shanghai\\"}"');
      expect(responseText).toContain("event: content_block_stop");
      expect(responseText).toContain("event: message_delta");
      expect(responseText).toContain('"stop_reason":"tool_use"');
      expect(responseText).toContain('"output_tokens":4');
      expect(responseText).toContain("event: message_stop");
      expect(responseText).not.toContain('"type":"text_delta"');
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 32,
            messages: [
              {
                content: "Need weather",
                role: "user"
              }
            ],
            model: "claude-client",
            stream: true,
            tool_choice: "required",
            tools: [
              {
                function: {
                  name: "lookup_weather",
                  parameters: inputSchema
                },
                type: "function"
              }
            ]
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("converts legacy streaming local Anthropic function-call deltas from upstream chat completions SSE", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      function_call: {
                        arguments: "{\"city\"",
                        name: "lookup_weather"
                      },
                      role: "assistant"
                    },
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-legacy-function-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      function_call: {
                        arguments: ":\"Shanghai\"}"
                      }
                    },
                    finish_reason: "function_call",
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-legacy-function-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 4,
                  prompt_tokens: 9,
                  total_tokens: 13
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "Need weather",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true,
          tool_choice: {
            type: "any"
          },
          tools: [
            {
              input_schema: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              name: "lookup_weather"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: content_block_start");
      expect(responseText).toContain('"type":"tool_use"');
      expect(responseText).toContain('"id":"toolu_0"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain("event: content_block_delta");
      expect(responseText).toContain('"type":"input_json_delta"');
      expect(responseText).toContain('"partial_json":"{\\"city\\""');
      expect(responseText).toContain('"partial_json":":\\"Shanghai\\"}"');
      expect(responseText).toContain("event: content_block_stop");
      expect(responseText).toContain("event: message_delta");
      expect(responseText).toContain('"stop_reason":"tool_use"');
      expect(responseText).toContain('"input_tokens":0');
      expect(responseText).toContain('"output_tokens":4');
      expect(responseText).not.toContain('"type":"text_delta"');
    } finally {
      await controller.stop();
    }
  });

  it("keeps multiple streaming Anthropic tool-use deltas separated by upstream index", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\"",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        },
                        {
                          function: {
                            arguments: "{\"timezone\"",
                            name: "lookup_time"
                          },
                          id: "call_time",
                          index: 1,
                          type: "function"
                        }
                      ]
                    },
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-multi-tool-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: {
                            arguments: ":\"Asia/Shanghai\"}"
                          },
                          index: 1
                        },
                        {
                          function: {
                            arguments: ":\"Shanghai\"}"
                          },
                          index: 0
                        }
                      ]
                    },
                    finish_reason: "tool_calls",
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-multi-tool-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 8,
                  prompt_tokens: 14,
                  total_tokens: 22
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 48,
          messages: [
            {
              content: "Need weather and time",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true,
          tool_choice: {
            type: "any"
          },
          tools: [
            {
              input_schema: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              name: "lookup_weather"
            },
            {
              input_schema: {
                properties: {
                  timezone: {
                    type: "string"
                  }
                },
                required: ["timezone"],
                type: "object"
              },
              name: "lookup_time"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(responseText.match(/event: content_block_start/g) ?? []).toHaveLength(2);
      expect(responseText.match(/event: content_block_stop/g) ?? []).toHaveLength(2);
      expect(responseText).toContain('"index":0,"type":"content_block_start"');
      expect(responseText).toContain('"index":1,"type":"content_block_start"');
      expect(responseText).toContain('"id":"call_weather"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain('"partial_json":"{\\"city\\""');
      expect(responseText).toContain('"partial_json":":\\"Shanghai\\"}"');
      expect(responseText).toContain('"id":"call_time"');
      expect(responseText).toContain('"name":"lookup_time"');
      expect(responseText).toContain('"partial_json":"{\\"timezone\\""');
      expect(responseText).toContain('"partial_json":":\\"Asia/Shanghai\\"}"');
      expect(responseText).toContain('"stop_reason":"tool_use"');
      expect(responseText).toContain('"input_tokens":0');
      expect(responseText).toContain('"output_tokens":8');
      expect(responseText).not.toContain('"type":"text_delta"');
    } finally {
      await controller.stop();
    }
  });

  it("keeps mixed streaming Anthropic text before upstream tool-use deltas", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "Let me check.",
                      role: "assistant"
                    },
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-mixed-tool-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\":\"Shanghai\"}",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        }
                      ]
                    },
                    finish_reason: "tool_calls",
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-mixed-tool-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 6,
                  prompt_tokens: 10,
                  total_tokens: 16
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "Need weather",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true,
          tool_choice: {
            type: "any"
          },
          tools: [
            {
              input_schema: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              name: "lookup_weather"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();
      const textDeltaIndex = responseText.indexOf('"type":"text_delta"');
      const textStopIndex = responseText.indexOf('{"index":0,"type":"content_block_stop"}');
      const toolStartIndex = responseText.indexOf('"type":"tool_use"');
      const messageStopIndex = responseText.indexOf("event: message_stop");

      expect(response.status).toBe(200);
      expect(textDeltaIndex).toBeGreaterThanOrEqual(0);
      expect(textStopIndex).toBeGreaterThan(textDeltaIndex);
      expect(toolStartIndex).toBeGreaterThan(textStopIndex);
      expect(messageStopIndex).toBeGreaterThan(toolStartIndex);
      expect(responseText).toContain('"text":"Let me check."');
      expect(responseText).toContain('"id":"call_weather"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain('"partial_json":"{\\"city\\":\\"Shanghai\\"}"');
      expect(responseText).toContain('"stop_reason":"tool_use"');
      expect(responseText).toContain('"input_tokens":0');
      expect(responseText).toContain('"output_tokens":6');
    } finally {
      await controller.stop();
    }
  });

  it("keeps mixed streaming Anthropic tool-use output before later text deltas", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"city\":\"Shanghai\"}",
                            name: "lookup_weather"
                          },
                          id: "call_weather",
                          index: 0,
                          type: "function"
                        }
                      ]
                    },
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-tool-before-text-stream",
                model: "upstream-stream"
              })}\n\n`,
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "Weather lookup queued."
                    },
                    finish_reason: "stop",
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-tool-before-text-stream",
                model: "upstream-stream",
                usage: {
                  completion_tokens: 7,
                  prompt_tokens: 10,
                  total_tokens: 17
                }
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "Need weather",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true,
          tool_choice: {
            type: "any"
          },
          tools: [
            {
              input_schema: {
                properties: {
                  city: {
                    type: "string"
                  }
                },
                required: ["city"],
                type: "object"
              },
              name: "lookup_weather"
            }
          ]
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();
      const toolStartIndex = responseText.indexOf('"type":"tool_use"');
      const toolStopIndex = responseText.indexOf('{"index":0,"type":"content_block_stop"}');
      const textStartIndex = responseText.indexOf('"content_block":{"text":"","type":"text"}');
      const textDeltaIndex = responseText.indexOf('"type":"text_delta"');
      const textStopIndex = responseText.indexOf('{"index":1,"type":"content_block_stop"}');

      expect(response.status).toBe(200);
      expect(toolStartIndex).toBeGreaterThanOrEqual(0);
      expect(toolStopIndex).toBeGreaterThan(toolStartIndex);
      expect(textStartIndex).toBeGreaterThan(toolStopIndex);
      expect(textDeltaIndex).toBeGreaterThan(textStartIndex);
      expect(textStopIndex).toBeGreaterThan(textDeltaIndex);
      expect(responseText).toContain('"id":"call_weather"');
      expect(responseText).toContain('"name":"lookup_weather"');
      expect(responseText).toContain('"partial_json":"{\\"city\\":\\"Shanghai\\"}"');
      expect(responseText).toContain('"text":"Weather lookup queued."');
      expect(responseText).toContain('"stop_reason":"end_turn"');
      expect(responseText).toContain('"input_tokens":0');
      expect(responseText).toContain('"output_tokens":7');
    } finally {
      await controller.stop();
    }
  });

  it("extracts array content parts for converted streaming Anthropic deltas", async () => {
    const controller = createRouteProxyController({
      providerFetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            for (const chunk of [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: [
                        "first anthropic stream part",
                        {
                          text: "second anthropic stream part",
                          type: "text"
                        },
                        {
                          content: "third anthropic stream part",
                          type: "output_text"
                        },
                        {
                          refusal: "fourth anthropic stream refusal part",
                          type: "refusal"
                        },
                        {
                          image_url: {
                            url: "ignored-anthropic-stream-image-url"
                          },
                          type: "image_url"
                        }
                      ],
                      role: "assistant"
                    },
                    index: 0
                  }
                ],
                id: "chatcmpl-anthropic-stream-parts",
                model: "upstream-stream"
              })}\n\n`,
              "data: [DONE]\n\n"
            ]) {
              streamController.enqueue(encoder.encode(chunk));
            }

            streamController.close();
          }
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: [
            {
              content: "hello",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();
      const expectedDelta =
        "first anthropic stream part\\nsecond anthropic stream part\\nthird anthropic stream part\\nfourth anthropic stream refusal part";

      expect(response.status).toBe(200);
      expect(responseText).toContain("event: content_block_delta");
      expect(responseText).toContain(`"text":"${expectedDelta}"`);
      expect(responseText).toContain("event: message_stop");
      expect(responseText).not.toContain("ignored-anthropic-stream-image-url");
    } finally {
      await controller.stop();
    }
  });

  it("maps streaming Anthropic max-token stop reasons during conversion", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            streamController.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-anthropic-length","model":"upstream-stream","choices":[{"delta":{"content":"Truncated"},"finish_reason":"length","index":0}],"usage":{"completion_tokens":9,"prompt_tokens":4,"total_tokens":13}}\n\n'
              )
            );
            streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
            streamController.close();
          }
        });

        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 8,
          messages: [
            {
              content: "summarize",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(responseText).toContain("event: content_block_delta");
      expect(responseText).toContain('"text":"Truncated"');
      expect(responseText).toContain("event: message_delta");
      expect(responseText).toContain('"stop_reason":"max_tokens"');
      expect(responseText).toContain('"input_tokens":4');
      expect(responseText).toContain('"output_tokens":9');
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 8,
            messages: [
              {
                content: "summarize",
                role: "user"
              }
            ],
            model: "claude-client",
            stream: true
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("maps streaming Anthropic tool-use stop reasons during conversion", async () => {
    const fetchCalls: Array<{
      body: Record<string, unknown>;
      input: string;
    }> = [];
    const controller = createRouteProxyController({
      providerFetch: async (input: string, init?: RequestInit) => {
        const bodyText = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(streamController) {
            streamController.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-anthropic-tool-stream","model":"upstream-stream","choices":[{"delta":{"content":"Tool needed"},"finish_reason":"tool_calls","index":0}],"usage":{"completion_tokens":5,"prompt_tokens":7,"total_tokens":12}}\n\n'
              )
            );
            streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
            streamController.close();
          }
        });

        fetchCalls.push({
          body: JSON.parse(bodyText),
          input
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream"
          },
          status: 200
        });
      }
    });

    try {
      const target = createRouteProxyTarget("primary", "http://127.0.0.1:3001/v1");
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });
      const response = await fetch(`${status.proxyUrl}v1/messages`, {
        body: JSON.stringify({
          max_tokens: 12,
          messages: [
            {
              content: "use a tool if needed",
              role: "user"
            }
          ],
          model: "claude-client",
          stream: true
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      const responseText = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(responseText).toContain("event: content_block_delta");
      expect(responseText).toContain('"text":"Tool needed"');
      expect(responseText).toContain("event: message_delta");
      expect(responseText).toContain('"stop_reason":"tool_use"');
      expect(responseText).toContain('"input_tokens":7');
      expect(responseText).toContain('"output_tokens":5');
      expect(fetchCalls).toEqual([
        {
          body: {
            max_tokens: 12,
            messages: [
              {
                content: "use a tool if needed",
                role: "user"
              }
            ],
            model: "claude-client",
            stream: true
          },
          input: "http://127.0.0.1:3001/v1/chat/completions"
        }
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("writes durable target health transition events for cooldown and recovery", async () => {
    let nowMs = Date.parse("2026-07-05T08:00:00.000Z");
    let primaryHits = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const primary = await startMockUpstream((_request, response) => {
      primaryHits += 1;

      if (primaryHits === 1) {
        response.writeHead(502, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify({ error: "bad gateway" }));
        return;
      }

      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ target: "primary" }));
    });
    const backup = await startMockUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ target: "backup" }));
    });
    const userDataPath = await createTempUserDataPath();
    const diagnosticsStore = createRouteProxyDiagnosticsStore({
      userDataPath
    });
    const controller = createRouteProxyController({
      appendDiagnosticEntry: (entry, options) => diagnosticsStore.appendEntry(entry, options)
    });

    try {
      await diagnosticsStore.enable();

      const primaryTarget = createRouteProxyTarget("primary", primary.url);
      const backupTarget = createRouteProxyTarget("backup", backup.url);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 5_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        profileId: "profile-health",
        target: primaryTarget,
        targets: [primaryTarget, backupTarget],
        timeoutMs: 5_000
      });

      const firstResponse = await fetch(`${status.proxyUrl}v1/models`);

      expect(firstResponse.status).toBe(200);
      await expect(firstResponse.json()).resolves.toEqual({ target: "backup" });

      nowMs += 5_000;
      const secondResponse = await fetch(`${status.proxyUrl}v1/models`);

      expect(secondResponse.status).toBe(200);
      await expect(secondResponse.json()).resolves.toEqual({ target: "primary" });
      await controller.flushDiagnostics();

      const entries = await diagnosticsStore.readEntries({ limit: 20 });
      const healthEvents = entries.filter((entry) => entry.eventType === "target-health");

      expect(healthEvents).toHaveLength(2);
      expect(healthEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            errorCode: "target_cooling_down",
            errorMessage: "HTTP 502",
            ok: false,
            path: "/_route-proxy/target-health",
            profileId: "profile-health",
            result: "target-health-change",
            statusCode: 0,
            targetConfigId: "primary",
            targetHealthState: "cooling-down",
            targetOrdinal: 0
          }),
          expect.objectContaining({
            errorCode: "target_recovered",
            errorMessage: "",
            ok: true,
            path: "/_route-proxy/target-health",
            profileId: "profile-health",
            result: "target-health-change",
            statusCode: 0,
            targetConfigId: "primary",
            targetHealthState: "available",
            targetOrdinal: 0
          })
        ])
      );
      expect(JSON.stringify(healthEvents)).not.toContain(primary.url);
      expect(JSON.stringify(healthEvents)).not.toContain("encrypted-primary");
    } finally {
      dateNowSpy.mockRestore();
      await controller.stop();
      await primary.close();
      await backup.close();
      await fs.rm(userDataPath, { force: true, recursive: true });
    }
  });

  it("does not retry HTTP 4xx upstream responses on backup targets", async () => {
    const primary = await startMockUpstream((_request, response) => {
      response.writeHead(400, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ error: "bad request" }));
    });
    const backup = await startMockUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true }));
    });
    const controller = createRouteProxyController();

    try {
      const primaryTarget = createRouteProxyTarget("primary", primary.url);
      const backupTarget = createRouteProxyTarget("backup", backup.url);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target: primaryTarget,
        targets: [primaryTarget, backupTarget],
        timeoutMs: 5_000
      });

      const response = await fetch(`${status.proxyUrl}v1/models`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad request" });
      expect(primary.getHits()).toBe(1);
      expect(backup.getHits()).toBe(0);
      expect(controller.getRequestLogs()).toMatchObject([
        {
          attempt: 1,
          ok: false,
          path: "/v1/models",
          statusCode: 400,
          targetConfigId: "primary"
        }
      ]);
      expect(controller.getStatus()).toMatchObject({
        failedRequests: 1,
        successRequests: 0,
        targetHealth: [
          {
            configId: "primary",
            failureCount: 0,
            state: "available"
          },
          {
            configId: "backup",
            failureCount: 0,
            state: "available"
          }
        ]
      });
    } finally {
      await controller.stop();
      await primary.close();
      await backup.close();
    }
  });

  it("does not create durable diagnostics files while runtime append is disabled", async () => {
    const upstream = await startMockUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true }));
    });
    const userDataPath = await createTempUserDataPath();
    const diagnosticsStore = createRouteProxyDiagnosticsStore({
      userDataPath
    });
    const controller = createRouteProxyController({
      appendDiagnosticEntry: (entry, options) => diagnosticsStore.appendEntry(entry, options)
    });

    try {
      const target = createRouteProxyTarget("primary", upstream.url);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        target,
        targets: [target],
        timeoutMs: 5_000
      });

      const response = await fetch(`${status.proxyUrl}v1/models`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      await controller.flushDiagnostics();
      expect(await diagnosticsStore.readEntries()).toEqual([]);
      expect(await pathExists(diagnosticsStore.getPaths().diagnosticsDir)).toBe(false);
    } finally {
      await controller.stop();
      await upstream.close();
      await fs.rm(userDataPath, { force: true, recursive: true });
    }
  });

  it("waits for pending durable diagnostics writes before flush resolves", async () => {
    const upstream = await startMockUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true }));
    });
    let markDiagnosticWriteStarted: () => void = () => undefined;
    let releaseDiagnosticWrite: () => void = () => undefined;
    const diagnosticWriteStarted = new Promise<void>((resolve) => {
      markDiagnosticWriteStarted = resolve;
    });
    const diagnosticWriteRelease = new Promise<void>((resolve) => {
      releaseDiagnosticWrite = resolve;
    });
    const diagnosticEntries: Record<string, unknown>[] = [];
    let diagnosticWriteCompleted = false;
    let flushCompleted = false;
    const controller = createRouteProxyController({
      appendDiagnosticEntry: async (entry) => {
        diagnosticEntries.push(entry);
        markDiagnosticWriteStarted();
        await diagnosticWriteRelease;
        diagnosticWriteCompleted = true;
      }
    });

    try {
      const target = createRouteProxyTarget("primary", upstream.url);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        profileId: "profile-flush",
        target,
        targets: [target],
        timeoutMs: 5_000
      });

      const response = await fetch(`${status.proxyUrl}v1/models`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      await diagnosticWriteStarted;

      const flushPromise = controller.flushDiagnostics().then(() => {
        flushCompleted = true;
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(flushCompleted).toBe(false);
      expect(diagnosticWriteCompleted).toBe(false);

      releaseDiagnosticWrite();
      await flushPromise;

      expect(flushCompleted).toBe(true);
      expect(diagnosticWriteCompleted).toBe(true);
      expect(diagnosticEntries).toMatchObject([
        {
          ok: true,
          path: "/v1/models",
          profileId: "profile-flush",
          statusCode: 200,
          targetConfigId: "primary"
        }
      ]);
    } finally {
      releaseDiagnosticWrite();
      await controller.stop();
      await upstream.close();
    }
  });

  it("writes sanitized durable diagnostics entries when runtime append is enabled", async () => {
    const primary = await startMockUpstream((_request, response) => {
      response.writeHead(502, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ error: "bad gateway" }));
    });
    const backup = await startMockUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true }));
    });
    const userDataPath = await createTempUserDataPath();
    const diagnosticsStore = createRouteProxyDiagnosticsStore({
      userDataPath
    });
    const controller = createRouteProxyController({
      appendDiagnosticEntry: (entry, options) => diagnosticsStore.appendEntry(entry, options)
    });

    try {
      await diagnosticsStore.enable();

      const primaryTarget = createRouteProxyTarget("primary", primary.url);
      const backupTarget = createRouteProxyTarget("backup", backup.url);
      const proxyPort = await getFreePort();
      const status = await controller.start({
        cooldownMs: 30_000,
        failureThreshold: 1,
        listenAddress: "127.0.0.1",
        listenPort: proxyPort,
        profileId: "profile-one",
        target: primaryTarget,
        targets: [primaryTarget, backupTarget],
        timeoutMs: 5_000
      });

      const response = await fetch(`${status.proxyUrl}v1/models?api_key=sk-secret12345678`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      await controller.flushDiagnostics();

      const entries = await diagnosticsStore.readEntries({ limit: 10 });

      expect(entries).toHaveLength(3);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attempt: 2,
            errorCode: "",
            errorMessage: "",
            eventType: "request",
            ok: true,
            path: "/v1/models",
            profileId: "profile-one",
            result: "success",
            statusCode: 200,
            targetConfigId: "backup",
            targetHealthState: "available",
            targetOrdinal: 1
          }),
          expect.objectContaining({
            attempt: 1,
            errorCode: "http_502",
            errorMessage: "HTTP 502",
            eventType: "request",
            ok: false,
            path: "/v1/models",
            profileId: "profile-one",
            result: "upstream-http-error",
            statusCode: 502,
            targetConfigId: "primary",
            targetHealthState: "cooling-down",
            targetOrdinal: 0
          }),
          expect.objectContaining({
            attempt: 1,
            errorCode: "target_cooling_down",
            errorMessage: "HTTP 502",
            eventType: "target-health",
            ok: false,
            path: "/_route-proxy/target-health",
            profileId: "profile-one",
            result: "target-health-change",
            statusCode: 0,
            targetConfigId: "primary",
            targetHealthState: "cooling-down",
            targetOrdinal: 0
          })
        ])
      );

      const serializedEntries = JSON.stringify(entries);

      expect(serializedEntries).not.toContain("?api_key");
      expect(serializedEntries).not.toContain("sk-secret");
      expect(serializedEntries).not.toContain(primary.url);
      expect(serializedEntries).not.toContain(backup.url);
      expect(serializedEntries).not.toContain("encrypted-primary");
      expect(serializedEntries).not.toContain("encrypted-backup");
      expect(await pathExists(diagnosticsStore.getPaths().diagnosticsDir)).toBe(true);
    } finally {
      await controller.stop();
      await primary.close();
      await backup.close();
      await fs.rm(userDataPath, { force: true, recursive: true });
    }
  });
});
