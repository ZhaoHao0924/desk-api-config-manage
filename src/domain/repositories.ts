import type { ApiConfig, ApiProvider, CustomHeader, ProviderModel, TestHistoryItem } from "../types";

export interface ProviderRepository {
  listProviders(): Promise<ApiProvider[]>;
  saveProviders(providers: ApiProvider[]): Promise<ApiProvider[]>;
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

export interface CustomHeaderRepository {
  listCustomHeaders(configId: string): Promise<CustomHeader[]>;
  saveCustomHeader(header: CustomHeader): Promise<CustomHeader>;
  deleteCustomHeader(id: string): Promise<void>;
  deleteCustomHeadersByConfigId(configId: string): Promise<void>;
}

export type ConfigRepository = ProviderRepository & ApiConfigRepository & TestHistoryRepository & ProviderModelRepository & CustomHeaderRepository;
