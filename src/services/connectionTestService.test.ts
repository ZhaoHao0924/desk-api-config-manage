import { describe, expect, it, vi } from "vitest";
import type { ApiConfigRepository, TestHistoryRepository } from "../domain/repositories";
import { openAiCompatibleProviderId } from "../types";
import type { ApiConfig, ApiProvider, TestHistoryItem } from "../types";
import {
  buildChatCompletionsUrl,
  buildConnectionTestUrl,
  buildOpenAiResponsesUrl,
  runConnectionTest,
  sanitizeSensitiveText,
  shouldUseOpenAiResponsesApi
} from "./connectionTestService";
import type { SecretCopyOptions, SecretCopyResult, SecretService } from "./secretService";

class MemoryConnectionTestRepository implements ApiConfigRepository, TestHistoryRepository {
  private configs: ApiConfig[];
  private history: TestHistoryItem[] = [];

  constructor(configs: ApiConfig[]) {
    this.configs = configs.map((config) => ({ ...config, tags: [...config.tags] }));
  }

  async listConfigs(): Promise<ApiConfig[]> {
    return this.configs.map((config) => ({ ...config, tags: [...config.tags] }));
  }

  async getConfig(id: string): Promise<ApiConfig | undefined> {
    const config = this.configs.find((item) => item.id === id);
    return config ? { ...config, tags: [...config.tags] } : undefined;
  }

  async saveConfig(config: ApiConfig): Promise<ApiConfig> {
    this.configs = [{ ...config, tags: [...config.tags] }, ...this.configs];
    return { ...config, tags: [...config.tags] };
  }

  async replaceConfig(config: ApiConfig): Promise<ApiConfig> {
    this.configs = this.configs.map((item) => (item.id === config.id ? { ...config, tags: [...config.tags] } : item));
    return { ...config, tags: [...config.tags] };
  }

  async deleteConfig(id: string): Promise<void> {
    this.configs = this.configs.filter((config) => config.id !== id);
  }

  async listTestHistory(configId?: string): Promise<TestHistoryItem[]> {
    const filteredHistory = configId ? this.history.filter((item) => item.configId === configId) : this.history;
    return filteredHistory.map((item) => ({ ...item }));
  }

  async saveTestHistory(item: TestHistoryItem): Promise<TestHistoryItem> {
    this.history = [{ ...item }, ...this.history];
    return { ...item };
  }
}

class FakeSecretService implements SecretService {
  constructor(private readonly plaintext: string) {}

  async isEncryptionAvailable(): Promise<boolean> {
    return true;
  }

  async encryptSecret(): Promise<string> {
    return "encrypted";
  }

  async decryptSecret(): Promise<string> {
    return this.plaintext;
  }

  async copySecretToClipboard(_plaintext: string, options?: SecretCopyOptions): Promise<SecretCopyResult> {
    return {
      clearAfterMs: options?.clearAfterMs ?? 30_000
    };
  }
}

class ThrowingSecretService implements SecretService {
  constructor(private readonly error: Error) {}

  async isEncryptionAvailable(): Promise<boolean> {
    return true;
  }

  async encryptSecret(): Promise<string> {
    return "encrypted";
  }

  async decryptSecret(): Promise<string> {
    throw this.error;
  }

  async copySecretToClipboard(_plaintext: string, options?: SecretCopyOptions): Promise<SecretCopyResult> {
    return {
      clearAfterMs: options?.clearAfterMs ?? 30_000
    };
  }
}

const provider: ApiProvider = {
  id: openAiCompatibleProviderId,
  name: "OpenAI-compatible",
  type: "openai",
  defaultBaseUrl: "https://api.openai.com/v1",
  authType: "bearer",
  isBuiltIn: true
};

const baseConfig: ApiConfig = {
  id: "cfg-test",
  name: "OpenAI Test",
  providerId: openAiCompatibleProviderId,
  baseUrl: "https://api.example.com/v1",
  encryptedApiKey: "encrypted-key",
  apiKeyPreview: "sk-test...cdef",
  hasApiKey: true,
  defaultModel: "gpt-4.1-mini",
  endpointMode: "auto",
  environment: "development",
  tags: ["dev"],
  notes: "",
  isEnabled: true,
  lastTestStatus: "untested",
  createdAt: "2026-07-02T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z"
};

function createMonotonicClock(values: number[]): () => number {
  return () => values.shift() ?? 0;
}

describe("connectionTestService", () => {
  it("builds OpenAI-compatible chat completions URLs", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions"
    );
    expect(buildChatCompletionsUrl("http://localhost:11434", { type: "ollama" })).toBe(
      "http://localhost:11434/v1/chat/completions"
    );
    expect(buildChatCompletionsUrl("http://localhost:1234/v1", { type: "lm-studio" })).toBe(
      "http://localhost:1234/v1/chat/completions"
    );
  });

  it("builds provider-specific connection test URLs", () => {
    expect(buildConnectionTestUrl("https://api.anthropic.com/v1", { id: "anthropic", type: "anthropic" })).toBe(
      "https://api.anthropic.com/v1/messages"
    );
    expect(buildOpenAiResponsesUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/responses");
    expect(buildConnectionTestUrl("https://api.openai.com/v1", { id: openAiCompatibleProviderId, type: "openai" })).toBe(
      "https://api.openai.com/v1/responses"
    );
    expect(buildConnectionTestUrl("https://api.example.com/v1", { id: openAiCompatibleProviderId, type: "openai" })).toBe(
      "https://api.example.com/v1/chat/completions"
    );
    expect(
      buildConnectionTestUrl("https://api.openai.com/v1", { id: openAiCompatibleProviderId, type: "openai" }, "chat-completions")
    ).toBe("https://api.openai.com/v1/chat/completions");
    expect(buildConnectionTestUrl("https://api.example.com/v1", { id: "custom", type: "openai" }, "responses")).toBe(
      "https://api.example.com/v1/responses"
    );
    expect(
      buildConnectionTestUrl("https://generativelanguage.googleapis.com/v1beta/openai", {
        id: openAiCompatibleProviderId,
        type: "openai"
      })
    ).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(shouldUseOpenAiResponsesApi("https://api.openai.com/v1", { id: openAiCompatibleProviderId, type: "openai" })).toBe(true);
    expect(
      shouldUseOpenAiResponsesApi("https://api.openai.com/v1", { id: openAiCompatibleProviderId, type: "openai" }, "chat-completions")
    ).toBe(false);
    expect(shouldUseOpenAiResponsesApi("https://api.example.com/v1", { id: "custom", type: "openai" }, "responses")).toBe(true);
    expect(shouldUseOpenAiResponsesApi("https://integrate.api.nvidia.com/v1", { id: openAiCompatibleProviderId, type: "openai" })).toBe(false);
  });

  it("runs successful connection tests and persists status history", async () => {
    const rawApiKey = "sk-test-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input.toString()).toBe("https://api.example.com/v1/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${rawApiKey}`);
      expect(JSON.parse(init?.body as string)).toMatchObject({
        model: "gpt-4.1-mini",
        stream: false
      });

      return new Response(JSON.stringify({ id: "chatcmpl-test" }), { status: 200 });
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-1",
      fetchImpl,
      monotonicNow: createMonotonicClock([100, 148]),
      now: () => "2026-07-02T01:00:00.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.config).toMatchObject({
      lastTestStatus: "success",
      lastTestAt: "2026-07-02T01:00:00.000Z",
      latencyMs: 48
    });
    expect(result.historyItem).toMatchObject({
      id: "test-history-1",
      status: "success",
      latencyMs: 48,
      requestEndpoint: "https://api.example.com/v1/chat/completions"
    });
    await expect(repository.listTestHistory(baseConfig.id)).resolves.toHaveLength(1);
  });

  it("sanitizes request endpoint credentials before persisting fetch-path history", async () => {
    const rawApiKey = "sk-test-1234567890abcdef";
    const credentialedConfig: ApiConfig = {
      ...baseConfig,
      baseUrl: "https://user:password@api.example.com/v1"
    };
    const repository = new MemoryConnectionTestRepository([credentialedConfig]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => {
      expect(_input.toString()).toBe("https://user:password@api.example.com/v1/chat/completions");
      return new Response(JSON.stringify({ id: "chatcmpl-test" }), { status: 200 });
    });

    const result = await runConnectionTest(repository, credentialedConfig, provider, {
      createId: () => "test-history-sanitized-endpoint-fetch",
      fetchImpl,
      monotonicNow: createMonotonicClock([150, 177]),
      now: () => "2026-07-02T01:00:10.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "success"
    });
    expect(result.historyItem.requestEndpoint).not.toContain("user:password");
  });

  it("uses the Anthropic Messages API request shape for Anthropic providers", async () => {
    const rawApiKey = "sk-ant-test-1234567890abcdef";
    const anthropicProvider: ApiProvider = {
      id: "anthropic",
      name: "Anthropic",
      type: "anthropic",
      defaultBaseUrl: "https://api.anthropic.com/v1",
      authType: "api-key-header",
      isBuiltIn: true
    };
    const anthropicConfig: ApiConfig = {
      ...baseConfig,
      id: "cfg-anthropic",
      name: "Anthropic Test",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-5"
    };
    const repository = new MemoryConnectionTestRepository([anthropicConfig]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(init?.body as string);

      expect(_input.toString()).toBe("https://api.anthropic.com/v1/messages");
      expect(headers.Authorization).toBeUndefined();
      expect(headers["api-key"]).toBeUndefined();
      expect(headers["x-api-key"]).toBe(rawApiKey);
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(body).toMatchObject({
        max_tokens: 1,
        model: "claude-sonnet-4-5",
        stream: false
      });
      expect(body.messages).toEqual([{ role: "user", content: "ping" }]);

      return new Response(JSON.stringify({ id: "msg-test" }), { status: 200 });
    });

    const result = await runConnectionTest(repository, anthropicConfig, anthropicProvider, {
      createId: () => "test-history-anthropic",
      fetchImpl,
      monotonicNow: createMonotonicClock([200, 232]),
      now: () => "2026-07-04T02:00:00.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      requestEndpoint: "https://api.anthropic.com/v1/messages",
      status: "success",
      latencyMs: 32
    });
  });

  it("uses the Responses API request shape for official OpenAI providers", async () => {
    const rawApiKey = "sk-test-1234567890abcdef";
    const officialOpenAiConfig: ApiConfig = {
      ...baseConfig,
      baseUrl: "https://api.openai.com/v1"
    };
    const repository = new MemoryConnectionTestRepository([officialOpenAiConfig]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(init?.body as string);

      expect(_input.toString()).toBe("https://api.openai.com/v1/responses");
      expect(headers.Authorization).toBe(`Bearer ${rawApiKey}`);
      expect(body).toEqual({
        input: "ping",
        max_output_tokens: 16,
        model: "gpt-4.1-mini",
        store: false
      });
      expect(body.messages).toBeUndefined();

      return new Response(JSON.stringify({ id: "resp-test" }), { status: 200 });
    });

    const result = await runConnectionTest(repository, officialOpenAiConfig, provider, {
      createId: () => "test-history-openai-responses",
      fetchImpl,
      monotonicNow: createMonotonicClock([300, 329]),
      now: () => "2026-07-04T06:00:00.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      requestEndpoint: "https://api.openai.com/v1/responses",
      status: "success",
      latencyMs: 29
    });
  });

  it("honors forced OpenAI-compatible endpoint modes", async () => {
    const rawApiKey = "sk-test-1234567890abcdef";
    const forcedResponsesConfig: ApiConfig = {
      ...baseConfig,
      endpointMode: "responses"
    };
    const repository = new MemoryConnectionTestRepository([forcedResponsesConfig]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);

      expect(_input.toString()).toBe("https://api.example.com/v1/responses");
      expect(body).toEqual({
        input: "ping",
        max_output_tokens: 16,
        model: "gpt-4.1-mini",
        store: false
      });

      return new Response(JSON.stringify({ id: "resp-forced" }), { status: 200 });
    });

    const result = await runConnectionTest(repository, forcedResponsesConfig, provider, {
      createId: () => "test-history-forced-responses",
      fetchImpl,
      monotonicNow: createMonotonicClock([400, 419]),
      now: () => "2026-07-04T06:30:00.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      requestEndpoint: "https://api.example.com/v1/responses",
      status: "success",
      latencyMs: 19
    });
  });

  it("can force official OpenAI configs to use chat completions", async () => {
    const rawApiKey = "sk-test-1234567890abcdef";
    const forcedChatConfig: ApiConfig = {
      ...baseConfig,
      baseUrl: "https://api.openai.com/v1",
      endpointMode: "chat-completions"
    };
    const repository = new MemoryConnectionTestRepository([forcedChatConfig]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);

      expect(_input.toString()).toBe("https://api.openai.com/v1/chat/completions");
      expect(body).toMatchObject({
        messages: [{ role: "user", content: "ping" }],
        model: "gpt-4.1-mini",
        stream: false
      });

      return new Response(JSON.stringify({ id: "chat-forced" }), { status: 200 });
    });

    const result = await runConnectionTest(repository, forcedChatConfig, provider, {
      createId: () => "test-history-forced-chat",
      fetchImpl,
      monotonicNow: createMonotonicClock([430, 452]),
      now: () => "2026-07-04T06:40:00.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      requestEndpoint: "https://api.openai.com/v1/chat/completions",
      status: "success",
      latencyMs: 22
    });
  });

  it("can run through a desktop transport without decrypting in the renderer", async () => {
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => ({
        ok: true,
        status: 200,
        latencyMs: 23,
        requestEndpoint: "https://api.example.com/v1/chat/completions"
      }))
    };

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-transport",
      now: () => "2026-07-02T01:00:30.000Z",
      transport
    });

    expect(transport.testOpenAiCompatible).toHaveBeenCalledWith({
      authType: "bearer",
      baseUrl: "https://api.example.com/v1",
      endpointMode: "auto",
      encryptedApiKey: "encrypted-key",
      model: "gpt-4.1-mini",
      providerId: openAiCompatibleProviderId,
      providerType: "openai",
      timeoutMs: 15_000
    });
    expect(result.config.lastTestStatus).toBe("success");
    expect(result.historyItem.latencyMs).toBe(23);
    expect(result.historyItem.requestEndpoint).toBe("https://api.example.com/v1/chat/completions");
  });

  it("sanitizes desktop transport request endpoints before persisting history", async () => {
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => ({
        ok: true,
        status: 200,
        latencyMs: 23,
        requestEndpoint:
          "https://user:password@api.example.com/v1/chat/completions?api_key=secret&api-version=2026-01-01&access-token=hyphen-access-secret&authorization=Bearer%20query-secret&azureSubscriptionKey=azure-subscription-secret&bearerToken=bearer-query-secret&clientSecret=camel-client-secret&client_secret=oauth-secret&googleApiKey=google-api-secret&id_token=id-secret&key=gateway-secret&ocp-apim-subscription-key=ocp-apim-secret&refreshToken=camel-refresh-secret&secretKey=camel-secret-key&sessionToken=camel-session-secret&signature=encrypted-key&subscriptionKey=subscription-secret&preview=sk-test...cdef&token=secret&xApiKey=camel-x-api-secret&x-goog-api-key=x-goog-secret&xGoogApiKey=camel-x-goog-secret#fragment"
      }))
    };

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-sanitized-endpoint-transport",
      now: () => "2026-07-02T01:00:32.000Z",
      transport
    });

    expect(result.historyItem).toMatchObject({
      requestEndpoint:
        "https://api.example.com/v1/chat/completions?api-version=2026-01-01&signature=[redacted]&preview=[redacted]",
      status: "success"
    });
    expect(result.historyItem.requestEndpoint).not.toContain("user:password");
    expect(result.historyItem.requestEndpoint).not.toContain("access-token");
    expect(result.historyItem.requestEndpoint).not.toContain("api_key");
    expect(result.historyItem.requestEndpoint).not.toContain("authorization=");
    expect(result.historyItem.requestEndpoint).not.toContain("azureSubscriptionKey");
    expect(result.historyItem.requestEndpoint).not.toContain("bearerToken");
    expect(result.historyItem.requestEndpoint).not.toContain("clientSecret");
    expect(result.historyItem.requestEndpoint).not.toContain("client_secret");
    expect(result.historyItem.requestEndpoint).not.toContain("googleApiKey");
    expect(result.historyItem.requestEndpoint).not.toContain("id_token");
    expect(result.historyItem.requestEndpoint).not.toContain("key=");
    expect(result.historyItem.requestEndpoint).not.toContain("ocp-apim-subscription-key");
    expect(result.historyItem.requestEndpoint).not.toContain("refreshToken");
    expect(result.historyItem.requestEndpoint).not.toContain("secretKey");
    expect(result.historyItem.requestEndpoint).not.toContain("sessionToken");
    expect(result.historyItem.requestEndpoint).not.toContain("subscriptionKey");
    expect(result.historyItem.requestEndpoint).not.toContain("token=");
    expect(result.historyItem.requestEndpoint).not.toContain("xApiKey");
    expect(result.historyItem.requestEndpoint).not.toContain("x-goog-api-key");
    expect(result.historyItem.requestEndpoint).not.toContain("xGoogApiKey");
    expect(result.historyItem.requestEndpoint).not.toContain("encrypted-key");
    expect(result.historyItem.requestEndpoint).not.toContain("sk-test...cdef");
  });

  it("does not call desktop transport when the API key is missing", async () => {
    const configWithoutSecret: ApiConfig = {
      ...baseConfig,
      encryptedApiKey: undefined,
      hasApiKey: false,
      apiKeyPreview: "未设置"
    };
    const repository = new MemoryConnectionTestRepository([configWithoutSecret]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => ({
        ok: true,
        status: 200,
        latencyMs: 1
      }))
    };

    const result = await runConnectionTest(repository, configWithoutSecret, provider, {
      createId: () => "test-history-transport-missing-key",
      monotonicNow: createMonotonicClock([12, 15]),
      now: () => "2026-07-02T01:00:35.000Z",
      transport
    });

    expect(transport.testOpenAiCompatible).not.toHaveBeenCalled();
    expect(result.historyItem).toMatchObject({
      errorCode: "MISSING_API_KEY",
      errorMessage: "缺少 API Key",
      latencyMs: 3,
      status: "failed"
    });
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("allows no-auth desktop transport without an API key", async () => {
    const localProvider: ApiProvider = {
      id: "ollama",
      name: "Ollama",
      type: "ollama",
      defaultBaseUrl: "http://localhost:11434/v1",
      authType: "none",
      isBuiltIn: true
    };
    const localConfig: ApiConfig = {
      ...baseConfig,
      id: "cfg-local-transport",
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
      encryptedApiKey: undefined,
      hasApiKey: false,
      apiKeyPreview: "无需密钥",
      defaultModel: "llama3.1"
    };
    const repository = new MemoryConnectionTestRepository([localConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => ({
        ok: true,
        status: 200,
        latencyMs: 19
      }))
    };

    const result = await runConnectionTest(repository, localConfig, localProvider, {
      createId: () => "test-history-local-transport-no-auth",
      now: () => "2026-07-02T01:00:38.000Z",
      transport
    });

    expect(transport.testOpenAiCompatible).toHaveBeenCalledWith({
      authType: "none",
      baseUrl: "http://localhost:11434",
      endpointMode: "auto",
      encryptedApiKey: undefined,
      model: "llama3.1",
      providerId: "ollama",
      providerType: "ollama",
      timeoutMs: 15_000
    });
    expect(result.historyItem).toMatchObject({
      latencyMs: 19,
      requestEndpoint: "http://localhost:11434/v1/chat/completions",
      status: "success"
    });
    expect(result.config.lastTestStatus).toBe("success");
  });

  it("maps and sanitizes desktop transport failures", async () => {
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => ({
        ok: false,
        status: 429,
        latencyMs: 31,
        requestEndpoint: "https://api.example.com/v1/chat/completions",
        responseText:
          "quota hit x-api-key: gateway-token-123 api-key=header-token Authorization: Bearer sk-live-1234567890abcdef encrypted-key sk-test...cdef"
      }))
    };

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-transport-failure",
      now: () => "2026-07-02T01:00:40.000Z",
      transport
    });

    expect(result.config.lastTestStatus).toBe("failed");
    expect(result.historyItem).toMatchObject({
      errorCode: "429",
      errorMessage: "请求过于频繁或额度不足",
      latencyMs: 31,
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorDetail).toBe(
      "quota hit x-api-key: [redacted] api-key=[redacted] Authorization: Bearer [redacted] [redacted] [redacted]"
    );
  });

  it("truncates sanitized desktop transport failure details before persisting them", async () => {
    const rawApiKey = "sk-desktop-long-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => ({
        ok: false,
        status: 500,
        latencyMs: 44,
        requestEndpoint: "https://api.example.com/v1/chat/completions",
        responseText: `desktop oversized failure ${rawApiKey} Authorization: Bearer ${rawApiKey} encrypted-key sk-test...cdef ${"x".repeat(900)}`
      }))
    };

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-transport-long-failure",
      now: () => "2026-07-02T01:00:42.000Z",
      transport
    });

    expect(result.historyItem).toMatchObject({
      errorCode: "500",
      latencyMs: 44,
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorDetail).toBeDefined();
    expect(result.historyItem.errorDetail).not.toContain(rawApiKey);
    expect(result.historyItem.errorDetail).not.toContain("encrypted-key");
    expect(result.historyItem.errorDetail).not.toContain("sk-test...cdef");
    expect(result.historyItem.errorDetail).toContain("[redacted]");
    expect(result.historyItem.errorDetail?.length).toBe(803);
    expect(result.historyItem.errorDetail?.endsWith("...")).toBe(true);
  });

  it("sanitizes thrown desktop transport errors before persisting them", async () => {
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => {
        throw new Error(
          "desktop transport failed Authorization: Bearer sk-desktop-throw-1234567890abcdef encrypted-key sk-test...cdef"
        );
      })
    };

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-transport-thrown-secret",
      monotonicNow: createMonotonicClock([52, 68]),
      now: () => "2026-07-02T01:00:44.000Z",
      transport
    });

    expect(transport.testOpenAiCompatible).toHaveBeenCalledOnce();
    expect(result.historyItem).toMatchObject({
      errorCode: "CONNECTION_ERROR",
      latencyMs: 16,
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorMessage).toContain("desktop transport failed");
    expect(result.historyItem.errorMessage).not.toContain("sk-desktop-throw-1234567890abcdef");
    expect(result.historyItem.errorMessage).not.toContain("encrypted-key");
    expect(result.historyItem.errorMessage).not.toContain("sk-test...cdef");
    expect(result.historyItem.errorMessage).toContain("[redacted]");
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("records aborted desktop transport tests as timeouts", async () => {
    const rawApiKey = "sk-desktop-timeout-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => {
        const error = new Error(`desktop transport aborted ${rawApiKey} encrypted-key sk-test...cdef`);
        error.name = "AbortError";
        throw error;
      })
    };

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-transport-timeout",
      monotonicNow: createMonotonicClock([72, 95]),
      now: () => "2026-07-02T01:00:46.000Z",
      transport
    });

    expect(transport.testOpenAiCompatible).toHaveBeenCalledOnce();
    expect(result.historyItem).toMatchObject({
      errorCode: "TIMEOUT",
      errorMessage: "请求超时",
      latencyMs: 23,
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorMessage).not.toContain(rawApiKey);
    expect(result.historyItem.errorMessage).not.toContain("encrypted-key");
    expect(result.historyItem.errorMessage).not.toContain("sk-test...cdef");
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("records provider-specific endpoints when desktop transport omits the endpoint", async () => {
    const anthropicProvider: ApiProvider = {
      id: "anthropic",
      name: "Anthropic",
      type: "anthropic",
      defaultBaseUrl: "https://api.anthropic.com/v1",
      authType: "api-key-header",
      isBuiltIn: true
    };
    const anthropicConfig: ApiConfig = {
      ...baseConfig,
      id: "cfg-anthropic-transport",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-5"
    };
    const repository = new MemoryConnectionTestRepository([anthropicConfig]);
    const transport = {
      testOpenAiCompatible: vi.fn(async () => ({
        ok: true,
        status: 200,
        latencyMs: 17
      }))
    };

    const result = await runConnectionTest(repository, anthropicConfig, anthropicProvider, {
      createId: () => "test-history-anthropic-transport",
      now: () => "2026-07-04T02:00:30.000Z",
      transport
    });

    expect(transport.testOpenAiCompatible).toHaveBeenCalledWith({
      authType: "api-key-header",
      baseUrl: "https://api.anthropic.com/v1",
      endpointMode: "auto",
      encryptedApiKey: "encrypted-key",
      model: "claude-sonnet-4-5",
      providerId: "anthropic",
      providerType: "anthropic",
      timeoutMs: 15_000
    });
    expect(result.historyItem.requestEndpoint).toBe("https://api.anthropic.com/v1/messages");
  });

  it("normalizes local OpenAI-compatible roots and omits auth headers", async () => {
    const localProvider: ApiProvider = {
      id: "ollama",
      name: "Ollama",
      type: "ollama",
      defaultBaseUrl: "http://localhost:11434/v1",
      authType: "none",
      isBuiltIn: true
    };
    const localConfig: ApiConfig = {
      ...baseConfig,
      id: "cfg-local",
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
      encryptedApiKey: undefined,
      hasApiKey: false,
      apiKeyPreview: "无需密钥",
      defaultModel: "llama3.1"
    };
    const repository = new MemoryConnectionTestRepository([localConfig]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input.toString()).toBe("http://localhost:11434/v1/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response(JSON.stringify({ id: "chatcmpl-local" }), { status: 200 });
    });

    const result = await runConnectionTest(repository, localConfig, localProvider, {
      createId: () => "test-history-local",
      fetchImpl,
      monotonicNow: createMonotonicClock([30, 41]),
      now: () => "2026-07-02T01:00:45.000Z"
    });

    expect(result.historyItem).toMatchObject({
      requestEndpoint: "http://localhost:11434/v1/chat/completions",
      status: "success"
    });
  });

  it("records missing API keys without sending requests", async () => {
    const configWithoutSecret: ApiConfig = {
      ...baseConfig,
      encryptedApiKey: undefined,
      hasApiKey: false,
      apiKeyPreview: "未设置"
    };
    const repository = new MemoryConnectionTestRepository([configWithoutSecret]);
    const fetchImpl = vi.fn();

    const result = await runConnectionTest(repository, configWithoutSecret, provider, {
      createId: () => "test-history-missing-key",
      fetchImpl,
      monotonicNow: createMonotonicClock([10, 13]),
      now: () => "2026-07-02T01:01:00.000Z"
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.historyItem).toMatchObject({
      errorCode: "MISSING_API_KEY",
      errorMessage: "缺少 API Key",
      status: "failed"
    });
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("records unavailable secret storage without sending requests", async () => {
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn();

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-secret-storage-unavailable",
      fetchImpl,
      monotonicNow: createMonotonicClock([14, 18]),
      now: () => "2026-07-02T01:01:30.000Z"
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.historyItem).toMatchObject({
      errorCode: "SECRET_STORAGE_UNAVAILABLE",
      errorMessage: "当前环境未启用安全存储",
      latencyMs: 4,
      status: "failed"
    });
    expect(result.historyItem.requestEndpoint).toBeUndefined();
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("sanitizes HTTP failures before persisting them", async () => {
    const rawApiKey = "sk-live-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async () => {
      return new Response(`invalid key ${rawApiKey} Authorization: Bearer ${rawApiKey} encrypted-key sk-test...cdef`, {
        status: 401
      });
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-401",
      fetchImpl,
      monotonicNow: createMonotonicClock([20, 35]),
      now: () => "2026-07-02T01:02:00.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem.errorCode).toBe("401");
    expect(result.historyItem.errorMessage).toBe("认证失败，请检查 API Key 或权限");
    expect(result.historyItem.errorDetail).not.toContain(rawApiKey);
    expect(result.historyItem.errorDetail).not.toContain("encrypted-key");
    expect(result.historyItem.errorDetail).not.toContain("sk-test...cdef");
    expect(result.historyItem.errorDetail).toContain("[redacted]");
    expect(result.historyItem.requestEndpoint).toBe("https://api.example.com/v1/chat/completions");
  });

  it("truncates sanitized HTTP failure details before persisting them", async () => {
    const rawApiKey = "sk-long-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async () => {
      return new Response(
        `oversized failure ${rawApiKey} Authorization: Bearer ${rawApiKey} encrypted-key sk-test...cdef ${"x".repeat(900)}`,
        { status: 500 }
      );
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-long-http-failure",
      fetchImpl,
      monotonicNow: createMonotonicClock([21, 39]),
      now: () => "2026-07-02T01:02:05.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      errorCode: "500",
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorDetail).toBeDefined();
    expect(result.historyItem.errorDetail).not.toContain(rawApiKey);
    expect(result.historyItem.errorDetail).not.toContain("encrypted-key");
    expect(result.historyItem.errorDetail).not.toContain("sk-test...cdef");
    expect(result.historyItem.errorDetail).toContain("[redacted]");
    expect(result.historyItem.errorDetail?.length).toBe(803);
    expect(result.historyItem.errorDetail?.endsWith("...")).toBe(true);
  });

  it("records HTTP failures when provider response text cannot be read", async () => {
    const responseText = vi.fn(async () => {
      throw new Error("body stream already consumed sk-unreadable-1234567890abcdef");
    });
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async () => {
      return {
        ok: false,
        status: 500,
        text: responseText
      } as unknown as Response;
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-unreadable-http-failure",
      fetchImpl,
      monotonicNow: createMonotonicClock([41, 59]),
      now: () => "2026-07-02T01:02:10.000Z",
      secretService: new FakeSecretService("sk-unreadable-1234567890abcdef")
    });

    expect(responseText).toHaveBeenCalledOnce();
    expect(result.historyItem).toMatchObject({
      errorCode: "500",
      latencyMs: 18,
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorDetail).toBeUndefined();
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("sanitizes secret decryption failures before persisting them", async () => {
    const rawApiKey = "sk-live-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn();

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-secret-decrypt-failure",
      fetchImpl,
      monotonicNow: createMonotonicClock([24, 31]),
      now: () => "2026-07-02T01:02:15.000Z",
      secretService: new ThrowingSecretService(
        new Error(`decrypt failed ${rawApiKey} Authorization: Bearer ${rawApiKey} encrypted-key sk-test...cdef`)
      )
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.historyItem).toMatchObject({
      errorCode: "CONNECTION_ERROR",
      latencyMs: 7,
      status: "failed"
    });
    expect(result.historyItem.requestEndpoint).toBeUndefined();
    expect(result.historyItem.errorMessage).toContain("decrypt failed");
    expect(result.historyItem.errorMessage).not.toContain(rawApiKey);
    expect(result.historyItem.errorMessage).not.toContain("encrypted-key");
    expect(result.historyItem.errorMessage).not.toContain("sk-test...cdef");
    expect(result.historyItem.errorMessage).toContain("[redacted]");
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it.each([
    [404, "接口或模型不存在，请检查 Base URL 和模型名称"],
    [429, "请求过于频繁或额度不足"]
  ])("maps HTTP %i connection failures to readable messages", async (status, expectedMessage) => {
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "provider failure" }), { status });
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => `test-history-${status}`,
      fetchImpl,
      monotonicNow: createMonotonicClock([40, 67]),
      now: () => "2026-07-02T01:02:30.000Z",
      secretService: new FakeSecretService("sk-test-1234567890abcdef")
    });

    expect(result.historyItem).toMatchObject({
      errorCode: String(status),
      errorMessage: expectedMessage,
      status: "failed"
    });
  });

  it("records aborted connection tests as timeouts", async () => {
    const rawApiKey = "sk-timeout-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async () => {
      const error = new Error(`request aborted with ${rawApiKey}`);
      error.name = "AbortError";
      throw error;
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-timeout",
      fetchImpl,
      monotonicNow: createMonotonicClock([70, 95]),
      now: () => "2026-07-02T01:03:00.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      errorCode: "TIMEOUT",
      errorMessage: "请求超时",
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorMessage).not.toContain(rawApiKey);
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("uses a generic message for non-Error thrown fetch failures", async () => {
    const rawApiKey = "sk-string-throw-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async () => {
      throw `provider failed with ${rawApiKey} encrypted-key sk-test...cdef`;
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-non-error-thrown-fetch",
      fetchImpl,
      monotonicNow: createMonotonicClock([96, 118]),
      now: () => "2026-07-02T01:03:15.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      errorCode: "CONNECTION_ERROR",
      errorMessage: "连接测试失败",
      latencyMs: 22,
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorMessage).not.toContain(rawApiKey);
    expect(result.historyItem.errorMessage).not.toContain("encrypted-key");
    expect(result.historyItem.errorMessage).not.toContain("sk-test...cdef");
    expect(result.config.lastTestStatus).toBe("failed");
  });

  it("redacts plaintext keys, encrypted keys, and key previews from thrown errors", async () => {
    const rawApiKey = "sk-throw-1234567890abcdef";
    const repository = new MemoryConnectionTestRepository([baseConfig]);
    const fetchImpl = vi.fn(async () => {
      throw new Error(`upstream failed ${rawApiKey} encrypted-key sk-test...cdef`);
    });

    const result = await runConnectionTest(repository, baseConfig, provider, {
      createId: () => "test-history-thrown-secret",
      fetchImpl,
      monotonicNow: createMonotonicClock([100, 133]),
      now: () => "2026-07-02T01:03:30.000Z",
      secretService: new FakeSecretService(rawApiKey)
    });

    expect(result.historyItem).toMatchObject({
      errorCode: "CONNECTION_ERROR",
      requestEndpoint: "https://api.example.com/v1/chat/completions",
      status: "failed"
    });
    expect(result.historyItem.errorMessage).not.toContain(rawApiKey);
    expect(result.historyItem.errorMessage).not.toContain("encrypted-key");
    expect(result.historyItem.errorMessage).not.toContain("sk-test...cdef");
    expect(result.historyItem.errorMessage).toContain("[redacted]");
  });

  it("sanitizes standalone sensitive text", () => {
    expect(sanitizeSensitiveText("Authorization: Bearer sk-test-1234567890abcdef")).toBe(
      "Authorization: Bearer [redacted]"
    );
    expect(sanitizeSensitiveText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [redacted]");
    expect(
      sanitizeSensitiveText(
        'x-api-key: gateway-token-123 xApiKey=camel-x-api-secret x-goog-api-key=x-goog-secret xGoogApiKey=camel-x-goog-secret googleApiKey=google-api-secret api-key=header-token api_key=query-token apiToken=api-token-secret authToken=auth-token-secret azureSubscriptionKey=azure-subscription-secret bearerToken=bearer-token-secret clientSecret=camel-client-secret client_secret=client-secret ocp-apim-subscription-key=ocp-apim-secret refreshToken=camel-refresh-secret refresh_token=refresh-secret idToken=id-camel-secret id_token=id-secret session=session-secret sessionToken=session-camel-secret subscriptionKey=subscription-secret access-token=hyphen-access-secret accessToken=access-camel-secret access_token=access-secret secretKey=secret-key-value token="url-token"'
      )
    ).toBe(
      'x-api-key: [redacted] xApiKey=[redacted] x-goog-api-key=[redacted] xGoogApiKey=[redacted] googleApiKey=[redacted] api-key=[redacted] api_key=[redacted] apiToken=[redacted] authToken=[redacted] azureSubscriptionKey=[redacted] bearerToken=[redacted] clientSecret=[redacted] client_secret=[redacted] ocp-apim-subscription-key=[redacted] refreshToken=[redacted] refresh_token=[redacted] idToken=[redacted] id_token=[redacted] session=[redacted] sessionToken=[redacted] subscriptionKey=[redacted] access-token=[redacted] accessToken=[redacted] access_token=[redacted] secretKey=[redacted] token="[redacted]"'
    );
    expect(sanitizeSensitiveText("fetch failed https://user:password@api.example.com/v1/models")).toBe(
      "fetch failed https://api.example.com/v1/models"
    );
    expect(
      sanitizeSensitiveText(
        'Cookie: session=client-secret; Set-Cookie: refresh=server-secret; proxyAuthorization="Basic proxy-secret"'
      )
    ).toBe('Cookie: [redacted]; Set-Cookie: [redacted]; proxyAuthorization="[redacted]"');
  });
});
