import { describe, expect, it } from "vitest";
import { openAiCompatibleProviderId } from "../types";
import type { ApiConfig, ProviderModel } from "../types";
import { LocalStorageConfigRepository, localStorageDatabaseKey } from "./localStorageDatabase";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("LocalStorageConfigRepository", () => {
  const legacyConfig: ApiConfig = {
    id: "cfg-legacy",
    name: "Legacy",
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyPreview: "sk-legacy...1234",
    hasApiKey: true,
    defaultModel: "gpt-4.1-mini",
    endpointMode: "auto",
    environment: "development",
    tags: ["legacy"],
    notes: "",
    isEnabled: true,
    lastTestStatus: "success",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };

  it("seeds a new database", async () => {
    const repository = new LocalStorageConfigRepository(new MemoryStorage());

    await expect(repository.listProviders()).resolves.toHaveLength(2);
    await expect(repository.listProviderModels()).resolves.toHaveLength(10);
    await expect(repository.listConfigs()).resolves.toHaveLength(5);
  });

  it("filters provider models by provider", async () => {
    const repository = new LocalStorageConfigRepository(new MemoryStorage());

    const anthropicModels = await repository.listProviderModels("anthropic");
    const openAiModels = await repository.listProviderModels(openAiCompatibleProviderId);

    expect(anthropicModels.map((model) => model.modelId)).toEqual(["claude-sonnet-4-5", "claude-opus-4-1"]);
    expect(openAiModels.map((model) => model.modelId)).toEqual([
      "gpt-4.1",
      "gpt-4.1-mini",
      "o3",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "<antigravity-model-id>",
      "grok-4",
      "grok-3-mini"
    ]);
  });

  it("persists fetched provider models without duplicating built-in defaults", async () => {
    const storage = new MemoryStorage();
    const repository = new LocalStorageConfigRepository(storage);
    const fetchedModels: ProviderModel[] = [
      {
        id: "live-openai-compatible-gpt-4-1-mini",
        providerId: openAiCompatibleProviderId,
        modelId: "gpt-4.1-mini",
        displayName: "gpt-4.1-mini",
        capabilities: ["chat"],
        status: "available",
        notes: "fetched"
      },
      {
        id: "live-openai-compatible-z-ai-glm-5-2",
        providerId: "openai",
        modelId: "z-ai/glm-5.2",
        displayName: "z-ai/glm-5.2",
        capabilities: ["chat"],
        fetchedAt: "2026-07-05T03:30:00.000Z",
        status: "available",
        notes: "fetched"
      }
    ];

    const savedModels = await repository.saveProviderModels(openAiCompatibleProviderId, fetchedModels);
    const secondRepository = new LocalStorageConfigRepository(storage);
    const openAiModels = await secondRepository.listProviderModels(openAiCompatibleProviderId);

    expect(savedModels.filter((model) => model.modelId === "gpt-4.1-mini")).toHaveLength(1);
    expect(openAiModels.filter((model) => model.modelId === "gpt-4.1-mini")).toHaveLength(1);
    expect(openAiModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fetchedAt: "2026-07-05T03:30:00.000Z",
          providerId: openAiCompatibleProviderId,
          modelId: "z-ai/glm-5.2",
          displayName: "z-ai/glm-5.2"
        })
      ])
    );
  });

  it("migrates legacy v1 snapshots by adding provider models", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      localStorageDatabaseKey,
      JSON.stringify({
        schemaVersion: 1,
        providers: [],
        configs: [],
        testHistory: []
      })
    );

    const repository = new LocalStorageConfigRepository(storage);

    await expect(repository.listProviderModels()).resolves.toHaveLength(10);
  });

  it("restores built-in providers when a stored snapshot has none", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      localStorageDatabaseKey,
      JSON.stringify({
        schemaVersion: 3,
        providers: [],
        providerModels: [],
        configs: [],
        testHistory: []
      })
    );

    const repository = new LocalStorageConfigRepository(storage);

    await expect(repository.listProviders()).resolves.toHaveLength(2);
    await expect(repository.listProviderModels()).resolves.toHaveLength(10);
    await expect(repository.listConfigs()).resolves.toHaveLength(0);
  });

  it("refreshes stale built-in providers from older snapshots", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      localStorageDatabaseKey,
      JSON.stringify({
        schemaVersion: 3,
        providers: [
          {
            id: "deepseek",
            name: "DeepSeek",
            type: "deepseek",
            defaultBaseUrl: "https://api.deepseek.com/v1",
            authType: "bearer",
            isBuiltIn: true
          },
          {
            id: "ollama",
            name: "Ollama",
            type: "ollama",
            defaultBaseUrl: "http://localhost:11434/v1",
            authType: "none",
            isBuiltIn: true
          }
        ],
        providerModels: [
          {
            id: "model-deepseek-chat",
            providerId: "deepseek",
            modelId: "deepseek-chat",
            displayName: "DeepSeek Chat",
            capabilities: ["chat"],
            status: "recommended",
            notes: ""
          }
        ],
        configs: [],
        testHistory: []
      })
    );

    const repository = new LocalStorageConfigRepository(storage);
    const providers = await repository.listProviders();
    const providerModels = await repository.listProviderModels();

    expect(providers.map((provider) => provider.id)).toEqual([
      "anthropic",
      openAiCompatibleProviderId
    ]);
    expect(providers.find((provider) => provider.id === openAiCompatibleProviderId)?.type).toBe("openai");
    expect(providerModels.some((model) => model.providerId === "deepseek")).toBe(false);
    expect(providerModels.some((model) => model.providerId === "openai")).toBe(false);
    expect(providerModels.some((model) => model.providerId === "gemini")).toBe(false);
  });

  it("migrates masked-only v2 API keys to missing secret state", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      localStorageDatabaseKey,
      JSON.stringify({
        schemaVersion: 2,
        providers: [],
        providerModels: [],
        configs: [legacyConfig],
        testHistory: []
      })
    );

    const repository = new LocalStorageConfigRepository(storage);
    const [config] = await repository.listConfigs();

    expect(config.encryptedApiKey).toBeUndefined();
    expect(config.hasApiKey).toBe(false);
    expect(config.providerId).toBe(openAiCompatibleProviderId);
    expect(config.apiKeyPreview).toBe("未设置");
    expect(JSON.parse(storage.getItem(localStorageDatabaseKey) ?? "{}").schemaVersion).toBe(3);
  });

  it("adds default endpoint mode to stored configs missing it", async () => {
    const storage = new MemoryStorage();
    const { endpointMode: _endpointMode, ...configWithoutEndpointMode } = legacyConfig;
    storage.setItem(
      localStorageDatabaseKey,
      JSON.stringify({
        schemaVersion: 3,
        providers: [],
        providerModels: [],
        configs: [configWithoutEndpointMode],
        testHistory: []
      })
    );

    const repository = new LocalStorageConfigRepository(storage);
    const [config] = await repository.listConfigs();

    expect(config.endpointMode).toBe("auto");
  });

  it("persists encrypted API keys without plaintext values", async () => {
    const storage = new MemoryStorage();
    const repository = new LocalStorageConfigRepository(storage);
    const rawApiKey = "sk-plain-1234567890";

    await repository.saveConfig({
      ...legacyConfig,
      id: "cfg-encrypted",
      encryptedApiKey: "encrypted-value",
      apiKeyPreview: "sk-plain...7890",
      hasApiKey: true
    });

    const rawSnapshot = storage.getItem(localStorageDatabaseKey) ?? "";

    expect(rawSnapshot).toContain("encrypted-value");
    expect(rawSnapshot).not.toContain(rawApiKey);
  });

  it("persists config changes across repository instances", async () => {
    const storage = new MemoryStorage();
    const firstRepository = new LocalStorageConfigRepository(storage);
    const [firstConfig] = await firstRepository.listConfigs();

    await firstRepository.deleteConfig(firstConfig.id);

    const secondRepository = new LocalStorageConfigRepository(storage);
    const configs = await secondRepository.listConfigs();

    expect(configs.some((config) => config.id === firstConfig.id)).toBe(false);
    expect(configs).toHaveLength(4);
  });

  it("persists test history entries", async () => {
    const storage = new MemoryStorage();
    const repository = new LocalStorageConfigRepository(storage);

    await repository.saveTestHistory({
      id: "test-new",
      configId: "cfg-new",
      status: "failed",
      errorCode: "MISSING_API_KEY",
      errorMessage: "缺少 API Key",
      testedAt: "2026-07-02T01:00:00.000Z"
    });

    const secondRepository = new LocalStorageConfigRepository(storage);
    const history = await secondRepository.listTestHistory("cfg-new");

    expect(history).toEqual([
      {
        id: "test-new",
        configId: "cfg-new",
        status: "failed",
        errorCode: "MISSING_API_KEY",
        errorMessage: "缺少 API Key",
        testedAt: "2026-07-02T01:00:00.000Z"
      }
    ]);
  });
});
