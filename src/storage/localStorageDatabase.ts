import { defaultConfigs, defaultProviderModels, defaultProviders, defaultTestHistory } from "../data/sampleData";
import type { ConfigRepository } from "../domain/repositories";
import { legacyOpenAiCompatibleProviderIds, normalizeProviderId } from "../types";
import type { ApiConfig, ApiProvider, OpenAiEndpointMode, ProviderModel, TestHistoryItem } from "../types";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface DatabaseSnapshot {
  schemaVersion: 3;
  providers: ApiProvider[];
  providerModels: ProviderModel[];
  configs: ApiConfig[];
  testHistory: TestHistoryItem[];
}

interface LegacyDatabaseSnapshotV2 {
  schemaVersion: 2;
  providers: ApiProvider[];
  providerModels: ProviderModel[];
  configs: ApiConfig[];
  testHistory: TestHistoryItem[];
}

interface LegacyDatabaseSnapshotV1 {
  schemaVersion: 1;
  providers: ApiProvider[];
  configs: ApiConfig[];
  testHistory: TestHistoryItem[];
}

export const localStorageDatabaseKey = "desk-api-config-manager.database.v1";
export const localStorageDatabaseSchemaVersion = 3;
const retiredBuiltInProviderIds = new Set([
  "deepseek",
  "ollama",
  "custom",
  ...legacyOpenAiCompatibleProviderIds
]);
const retiredNonOpenAiCompatibleProviderIds = new Set(["deepseek", "ollama", "custom"]);

const seedSnapshot: DatabaseSnapshot = {
  schemaVersion: localStorageDatabaseSchemaVersion,
  providers: defaultProviders,
  providerModels: defaultProviderModels,
  configs: defaultConfigs,
  testHistory: defaultTestHistory
};

function normalizeEndpointMode(value: unknown): OpenAiEndpointMode {
  return value === "chat-completions" || value === "responses" || value === "auto" ? value : "auto";
}

function normalizeConfig(config: ApiConfig): ApiConfig {
  const encryptedApiKey =
    typeof config.encryptedApiKey === "string" && config.encryptedApiKey.length > 0
      ? config.encryptedApiKey
      : undefined;
  const apiKeyPreview = encryptedApiKey
    ? config.apiKeyPreview
    : config.apiKeyPreview === "无需密钥"
      ? config.apiKeyPreview
      : "未设置";

  return {
    ...config,
    encryptedApiKey,
    apiKeyPreview,
    hasApiKey: Boolean(encryptedApiKey),
    providerId: normalizeProviderId(config.providerId),
    endpointMode: normalizeEndpointMode((config as Partial<ApiConfig>).endpointMode),
    tags: [...config.tags]
  };
}

function normalizeProviders(providers: ApiProvider[]): ApiProvider[] {
  const customProviders = providers.filter((provider) => {
    const normalizedProviderId = normalizeProviderId(provider.id);

    return (
      !provider.isBuiltIn &&
      !defaultProviders.some((defaultProvider) => defaultProvider.id === normalizedProviderId) &&
      !retiredBuiltInProviderIds.has(provider.id) &&
      !retiredBuiltInProviderIds.has(normalizedProviderId)
    );
  });

  return [...defaultProviders, ...customProviders];
}

function getProviderModelKey(providerId: string, modelId: string): string {
  return `${normalizeProviderId(providerId)}::${modelId.trim().toLowerCase()}`;
}

function normalizeProviderModel(model: ProviderModel): ProviderModel | undefined {
  const modelId = model.modelId.trim();

  if (!modelId) {
    return undefined;
  }

  const fetchedAt = typeof model.fetchedAt === "string" && model.fetchedAt.trim() ? model.fetchedAt.trim() : undefined;

  return {
    ...model,
    providerId: normalizeProviderId(model.providerId),
    modelId,
    displayName: model.displayName.trim() || modelId,
    capabilities: [...model.capabilities],
    fetchedAt
  };
}

function normalizeProviderModels(models: ProviderModel[]): ProviderModel[] {
  const defaultModelKeys = new Set(
    defaultProviderModels.map((model) => getProviderModelKey(model.providerId, model.modelId))
  );
  const customModelsByKey = new Map<string, ProviderModel>();

  for (const model of models) {
    const rawProviderId = model.providerId.trim().toLowerCase();

    if (retiredNonOpenAiCompatibleProviderIds.has(rawProviderId)) {
      continue;
    }

    const normalizedModel = normalizeProviderModel(model);

    if (!normalizedModel) {
      continue;
    }

    const modelKey = getProviderModelKey(normalizedModel.providerId, normalizedModel.modelId);

    if (defaultModelKeys.has(modelKey)) {
      continue;
    }

    customModelsByKey.set(modelKey, normalizedModel);
  }

  return [...defaultProviderModels, ...customModelsByKey.values()];
}

function cloneSnapshot(snapshot: DatabaseSnapshot): DatabaseSnapshot {
  const providers = normalizeProviders(snapshot.providers);
  const providerModels = normalizeProviderModels(snapshot.providerModels);

  return {
    schemaVersion: snapshot.schemaVersion,
    providers: providers.map((provider) => ({ ...provider })),
    providerModels: providerModels.map((model) => ({
      ...model,
      capabilities: [...model.capabilities]
    })),
    configs: snapshot.configs.map((config) => normalizeConfig(config)),
    testHistory: snapshot.testHistory.map((item) => ({ ...item }))
  };
}

function isSnapshot(value: unknown): value is DatabaseSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as DatabaseSnapshot;

  return (
    candidate.schemaVersion === localStorageDatabaseSchemaVersion &&
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.providerModels) &&
    Array.isArray(candidate.configs) &&
    Array.isArray(candidate.testHistory)
  );
}

function isLegacySnapshotV2(value: unknown): value is LegacyDatabaseSnapshotV2 {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as LegacyDatabaseSnapshotV2;

  return (
    candidate.schemaVersion === 2 &&
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.providerModels) &&
    Array.isArray(candidate.configs) &&
    Array.isArray(candidate.testHistory)
  );
}

function isLegacySnapshotV1(value: unknown): value is LegacyDatabaseSnapshotV1 {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as LegacyDatabaseSnapshotV1;

  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.configs) &&
    Array.isArray(candidate.testHistory)
  );
}

function normalizeSnapshot(value: unknown): DatabaseSnapshot {
  if (isSnapshot(value)) {
    return cloneSnapshot(value);
  }

  if (isLegacySnapshotV2(value)) {
    return cloneSnapshot({
      schemaVersion: localStorageDatabaseSchemaVersion,
      providers: value.providers,
      providerModels: value.providerModels,
      configs: value.configs,
      testHistory: value.testHistory
    });
  }

  if (isLegacySnapshotV1(value)) {
    return cloneSnapshot({
      schemaVersion: localStorageDatabaseSchemaVersion,
      providers: value.providers,
      providerModels: defaultProviderModels,
      configs: value.configs,
      testHistory: value.testHistory
    });
  }

  return cloneSnapshot(seedSnapshot);
}

export class LocalStorageConfigRepository implements ConfigRepository {
  private readonly key: string;
  private readonly storage: StorageLike;

  constructor(storage?: StorageLike, key = localStorageDatabaseKey) {
    if (!storage && typeof window === "undefined") {
      throw new Error("LocalStorageConfigRepository requires a storage adapter outside the browser.");
    }

    this.storage = storage ?? window.localStorage;
    this.key = key;
    this.ensureDatabase();
  }

  async listProviders(): Promise<ApiProvider[]> {
    return this.read().providers.map((provider) => ({ ...provider }));
  }

  async listProviderModels(providerId?: string): Promise<ProviderModel[]> {
    const models = this.read().providerModels;
    const normalizedProviderId = providerId ? normalizeProviderId(providerId) : undefined;
    const filteredModels = normalizedProviderId
      ? models.filter((model) => normalizeProviderId(model.providerId) === normalizedProviderId)
      : models;

    return filteredModels.map((model) => ({
      ...model,
      capabilities: [...model.capabilities]
    }));
  }

  async saveProviderModels(providerId: string, models: ProviderModel[]): Promise<ProviderModel[]> {
    const snapshot = this.read();
    const normalizedProviderId = normalizeProviderId(providerId);
    const nextModels = models
      .map((model) => normalizeProviderModel({ ...model, providerId: normalizedProviderId }))
      .filter((model): model is ProviderModel => Boolean(model));

    snapshot.providerModels = normalizeProviderModels([...snapshot.providerModels, ...nextModels]);
    this.write(snapshot);

    return this.listProviderModels();
  }

  async listConfigs(): Promise<ApiConfig[]> {
    return this.read().configs.map((config) => ({ ...config, tags: [...config.tags] }));
  }

  async getConfig(id: string): Promise<ApiConfig | undefined> {
    const config = this.read().configs.find((item) => item.id === id);
    return config ? { ...config, tags: [...config.tags] } : undefined;
  }

  async saveConfig(config: ApiConfig): Promise<ApiConfig> {
    const snapshot = this.read();
    const nextConfig = normalizeConfig(config);
    snapshot.configs = [nextConfig, ...snapshot.configs];
    this.write(snapshot);
    return { ...nextConfig, tags: [...nextConfig.tags] };
  }

  async replaceConfig(config: ApiConfig): Promise<ApiConfig> {
    const snapshot = this.read();
    const configIndex = snapshot.configs.findIndex((item) => item.id === config.id);

    if (configIndex === -1) {
      throw new Error(`Config not found: ${config.id}`);
    }

    const nextConfig = normalizeConfig(config);
    snapshot.configs[configIndex] = nextConfig;
    this.write(snapshot);
    return { ...nextConfig, tags: [...nextConfig.tags] };
  }

  async deleteConfig(id: string): Promise<void> {
    const snapshot = this.read();
    snapshot.configs = snapshot.configs.filter((config) => config.id !== id);
    snapshot.testHistory = snapshot.testHistory.filter((item) => item.configId !== id);
    this.write(snapshot);
  }

  async listTestHistory(configId?: string): Promise<TestHistoryItem[]> {
    const history = this.read().testHistory;
    const filteredHistory = configId ? history.filter((item) => item.configId === configId) : history;
    return filteredHistory.map((item) => ({ ...item }));
  }

  async saveTestHistory(item: TestHistoryItem): Promise<TestHistoryItem> {
    const snapshot = this.read();
    const nextItem = { ...item };
    snapshot.testHistory = [nextItem, ...snapshot.testHistory];
    this.write(snapshot);
    return { ...nextItem };
  }

  reset(): void {
    this.write(cloneSnapshot(seedSnapshot));
  }

  private ensureDatabase(): void {
    const existingValue = this.storage.getItem(this.key);

    if (!existingValue) {
      this.write(cloneSnapshot(seedSnapshot));
      return;
    }

    try {
      const parsedValue: unknown = JSON.parse(existingValue);
      const normalizedSnapshot = normalizeSnapshot(parsedValue);

      this.write(normalizedSnapshot);
    } catch {
      this.write(cloneSnapshot(seedSnapshot));
    }
  }

  private read(): DatabaseSnapshot {
    const rawValue = this.storage.getItem(this.key);

    if (!rawValue) {
      return cloneSnapshot(seedSnapshot);
    }

    const parsedValue: unknown = JSON.parse(rawValue);
    return normalizeSnapshot(parsedValue);
  }

  private write(snapshot: DatabaseSnapshot): void {
    this.storage.setItem(this.key, JSON.stringify(snapshot));
  }
}
