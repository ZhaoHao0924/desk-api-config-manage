import type { ApiConfig, ApiProvider, ProviderModel, TestHistoryItem } from "../types";

export interface ProviderRepository {
  listProviders(): Promise<ApiProvider[]>;
}

export interface ApiConfigRepository {
  listConfigs(): Promise<ApiConfig[]>;
  getConfig(id: string): Promise<ApiConfig | undefined>;
  saveConfig(config: ApiConfig): Promise<ApiConfig>;
  replaceConfig(config: ApiConfig): Promise<ApiConfig>;
  deleteConfig(id: string): Promise<void>;
}

export interface TestHistoryRepository {
  listTestHistory(configId?: string): Promise<TestHistoryItem[]>;
  saveTestHistory(item: TestHistoryItem): Promise<TestHistoryItem>;
}

export interface ProviderModelRepository {
  listProviderModels(providerId?: string): Promise<ProviderModel[]>;
  saveProviderModels(providerId: string, models: ProviderModel[]): Promise<ProviderModel[]>;
}

export type ConfigRepository = ProviderRepository & ApiConfigRepository & TestHistoryRepository & ProviderModelRepository;
