import { describe, expect, it, vi } from "vitest";
import { openAiCompatibleProviderId } from "../types";
import type { ApiConfig, ApiProvider } from "../types";
import {
  createDesktopRouteProxyTransport,
  createRouteProxyClientAdapterSnippets,
  createRouteProxyEndpointExamples,
  createRouteProxyLocalBaseUrl,
  createRouteProxyStreamingExample,
  createRouteProxyTarget,
  getRouteProxyConfigProblem
} from "./routeProxyTransport";

const provider: ApiProvider = {
  authType: "bearer",
  defaultBaseUrl: "https://api.openai.com/v1",
  id: openAiCompatibleProviderId,
  isBuiltIn: true,
  name: "OpenAI-compatible",
  type: "openai"
};

const config: ApiConfig = {
  apiKeyPreview: "sk-...test",
  baseUrl: "https://api.openai.com/v1",
  createdAt: "2026-07-01T10:00:00.000Z",
  defaultModel: "gpt-4.1-mini",
  encryptedApiKey: "encrypted",
  endpointMode: "auto",
  environment: "development",
  hasApiKey: true,
  id: "cfg-openai",
  isEnabled: true,
  lastTestStatus: "untested",
  name: "OpenAI - Dev",
  notes: "",
  providerId: openAiCompatibleProviderId,
  tags: [],
  updatedAt: "2026-07-01T10:00:00.000Z"
};

describe("routeProxyTransport", () => {
  it("returns undefined when the preload route proxy API is unavailable", () => {
    expect(createDesktopRouteProxyTransport(undefined)).toBeUndefined();
  });

  it("delegates route proxy control calls to the preload API", async () => {
    const status = {
      activeConnections: 0,
      address: "127.0.0.1",
      cooldownMs: 30_000,
      failedRequests: 0,
      failureThreshold: 1,
      lastError: "",
      lastRequestAt: "",
      port: 15_721,
      proxyUrl: "http://127.0.0.1:15721/",
      routingMode: "ordered" as const,
      running: true,
      startedAt: "2026-07-04T12:00:00.000Z",
      successRate: 100,
      successRequests: 1,
      targetBaseUrl: "https://api.openai.com/v1/",
      targetCount: 1,
      targetConfigId: config.id,
      targetHealth: [
        {
          baseUrl: "https://api.openai.com/v1/",
          configId: config.id,
          failureCount: 0,
          lastError: "",
          name: config.name,
          state: "available" as const,
          unavailableUntil: "",
          weight: 1
        }
      ],
      targetName: config.name,
      totalRequests: 1,
      uptimeSeconds: 2
    };
    const requestLogs = [
      {
        attempt: 1,
        completedAt: "2026-07-05T00:00:01.000Z",
        error: "",
        id: "route-proxy-request-1",
        latencyMs: 42,
        method: "GET",
        ok: true,
        path: "/v1/models",
        startedAt: "2026-07-05T00:00:00.958Z",
        statusCode: 200,
        targetConfigId: config.id,
        targetName: config.name
      }
    ];
    const diagnosticsManifest = {
      createdAt: "2026-07-05T00:00:00.000Z",
      enabled: true,
      retention: {
        maxAgeDays: 7,
        maxEntries: 10_000,
        maxTotalBytes: 10_485_760
      },
      schemaVersion: 1 as const,
      updatedAt: "2026-07-05T00:00:00.000Z"
    };
    const diagnosticEntries = [
      {
        attempt: 1,
        completedAt: "2026-07-05T00:00:01.000Z",
        errorCode: "",
        errorMessage: "",
        eventType: "request" as const,
        id: "route-proxy-diagnostic-1",
        latencyMs: 42,
        method: "GET",
        ok: true,
        path: "/v1/models",
        profileId: "profile-1",
        result: "success" as const,
        schemaVersion: 1 as const,
        startedAt: "2026-07-05T00:00:00.958Z",
        statusCode: 200,
        targetConfigId: config.id,
        targetHealthState: "available" as const,
        targetOrdinal: 0
      }
    ];
    const deskApi: NonNullable<Window["deskApi"]> = {
      getAppVersion: async () => "0.1.0",
      secrets: {
        isEncryptionAvailable: vi.fn(async () => true),
        encrypt: vi.fn(async () => "encrypted"),
        decrypt: vi.fn(async () => "secret"),
        copyToClipboard: vi.fn(async () => ({ clearAfterMs: 30_000 }))
      },
      clipboard: {
        writeText: vi.fn(async () => ({ ok: true }))
      },
      connection: {
        testOpenAiCompatible: vi.fn(async () => ({
          latencyMs: 42,
          ok: true,
          status: 200
        }))
      },
      models: {
        fetchProviderModels: vi.fn(async () => ({
          models: []
        }))
      },
      routeProxy: {
        clearDiagnostics: vi.fn(async () => ({
          entries: [],
          manifest: {
            ...diagnosticsManifest,
            enabled: false
          }
        })),
        clearRequestLogs: vi.fn(async () => []),
        disableDiagnostics: vi.fn(async () => ({
          ...diagnosticsManifest,
          enabled: false
        })),
        enableDiagnostics: vi.fn(async () => diagnosticsManifest),
        getDefaultConfig: vi.fn(async () => ({
          listenAddress: "127.0.0.1",
          listenPort: 15_721
        })),
        getDiagnosticsManifest: vi.fn(async () => diagnosticsManifest),
        getRequestLogs: vi.fn(async () => requestLogs),
        getStatus: vi.fn(async () => status),
        readDiagnostics: vi.fn(async () => diagnosticEntries),
        start: vi.fn(async () => status),
        stop: vi.fn(async () => ({
          ...status,
          running: false
        }))
      }
    };
    const request = {
      cooldownMs: 30_000,
      failureThreshold: 1,
      listenAddress: "127.0.0.1",
      listenPort: 15_721,
      target: createRouteProxyTarget(config, provider),
      timeoutMs: 15_000
    };
    const transport = createDesktopRouteProxyTransport(deskApi);

    await expect(transport?.getDefaultConfig()).resolves.toEqual({
      listenAddress: "127.0.0.1",
      listenPort: 15_721
    });
    await expect(transport?.start(request)).resolves.toEqual(status);
    await expect(transport?.getStatus()).resolves.toEqual(status);
    await expect(transport?.getRequestLogs()).resolves.toEqual(requestLogs);
    await expect(transport?.clearRequestLogs()).resolves.toEqual([]);
    await expect(transport?.getDiagnosticsManifest()).resolves.toEqual(diagnosticsManifest);
    await expect(transport?.enableDiagnostics({ maxAgeDays: 3 })).resolves.toEqual(diagnosticsManifest);
    await expect(transport?.readDiagnostics({ eventType: "target-health", limit: 8 })).resolves.toEqual(diagnosticEntries);
    await expect(transport?.disableDiagnostics()).resolves.toMatchObject({ enabled: false });
    await expect(transport?.clearDiagnostics()).resolves.toMatchObject({
      entries: [],
      manifest: {
        enabled: false
      }
    });
    await expect(transport?.stop()).resolves.toMatchObject({ running: false });
    expect(deskApi.routeProxy?.start).toHaveBeenCalledWith(request);
    expect(deskApi.routeProxy?.getRequestLogs).toHaveBeenCalled();
    expect(deskApi.routeProxy?.clearRequestLogs).toHaveBeenCalled();
    expect(deskApi.routeProxy?.enableDiagnostics).toHaveBeenCalledWith({ maxAgeDays: 3 });
    expect(deskApi.routeProxy?.readDiagnostics).toHaveBeenCalledWith({ eventType: "target-health", limit: 8 });
  });

  it("validates whether a config can be used as the route proxy target", () => {
    expect(getRouteProxyConfigProblem(config, provider)).toBe("");
    expect(getRouteProxyConfigProblem({ ...config, isEnabled: false }, provider)).toBe("当前配置未启用");
    expect(getRouteProxyConfigProblem({ ...config, baseUrl: "" }, provider)).toBe("Base URL 不能为空");
    expect(getRouteProxyConfigProblem({ ...config, encryptedApiKey: undefined }, provider)).toBe(
      "请先在配置管理中保存 API Key"
    );
  });

  it("keeps the upstream base path in the suggested local base URL", () => {
    expect(createRouteProxyLocalBaseUrl("127.0.0.1", 15_721, "https://api.openai.com/v1")).toBe(
      "http://127.0.0.1:15721/v1"
    );
    expect(
      createRouteProxyLocalBaseUrl("0.0.0.0", 15_721, "https://generativelanguage.googleapis.com/v1beta/openai")
    ).toBe("http://127.0.0.1:15721/v1beta/openai");
  });

  it("creates route proxy endpoint examples without duplicating slashes", () => {
    expect(createRouteProxyEndpointExamples("http://127.0.0.1:15721/v1/")).toEqual({
      baseUrl: "http://127.0.0.1:15721/v1/",
      chatCompletionsUrl: "http://127.0.0.1:15721/v1/chat/completions",
      modelListUrl: "http://127.0.0.1:15721/v1/models"
    });
  });

  it("creates local route proxy client adapter snippets", () => {
    const snippets = createRouteProxyClientAdapterSnippets("http://127.0.0.1:15721/v1", "gpt-5.5");

    expect(snippets.map((snippet) => snippet.target)).toEqual(["openai-sdk", "codex-responses", "claude-code"]);
    expect(snippets[0]).toMatchObject({
      fileName: ".env",
      protocol: "chat-completions",
      title: "OpenAI SDK"
    });
    expect(snippets[0].content).toContain("OPENAI_BASE_URL=http://127.0.0.1:15721/v1");
    expect(snippets[0].content).toContain("OPENAI_API_KEY=desk-api-local-proxy");
    expect(snippets[0].content).toContain("OPENAI_MODEL=gpt-5.5");

    expect(snippets[1]).toMatchObject({
      fileName: ".codex/config.toml",
      protocol: "responses",
      title: "Codex Responses"
    });
    expect(snippets[1].content).toContain('base_url = "http://127.0.0.1:15721/v1"');
    expect(snippets[1].content).toContain('wire_api = "responses"');

    expect(snippets[2]).toMatchObject({
      fileName: ".claude/settings.local.json",
      protocol: "anthropic-messages",
      title: "Claude Code"
    });
    expect(JSON.parse(snippets[2].content)).toMatchObject({
      env: {
        ANTHROPIC_API_KEY: "desk-api-local-proxy",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721/v1"
      },
      model: "gpt-5.5"
    });
    expect(JSON.stringify(snippets)).not.toContain(`console${"."}log`);
  });

  it("uses a model placeholder in local route proxy client adapter snippets", () => {
    const snippets = createRouteProxyClientAdapterSnippets("http://127.0.0.1:15721/v1", " ");

    expect(snippets[0].content).toContain("OPENAI_MODEL=<model-id>");
    expect(snippets[1].content).toContain('model = "<model-id>"');
    expect(JSON.parse(snippets[2].content).model).toBe("<model-id>");
  });

  it("creates a streaming example that reads SSE events until DONE", () => {
    const example = createRouteProxyStreamingExample("http://127.0.0.1:15721/v1", "gpt-5.5");

    expect(example).toContain('fetch("http://127.0.0.1:15721/v1/chat/completions"');
    expect(example).toContain('model: "gpt-5.5"');
    expect(example).toContain("stream: true");
    expect(example).toContain("let pending = \"\"");
    expect(example).toContain("let receivedText = \"\"");
    expect(example).toContain('event === "[DONE]"');
    expect(example).toContain("shouldStop = true");
    expect(example).not.toContain(`console${"."}log`);
  });
});
