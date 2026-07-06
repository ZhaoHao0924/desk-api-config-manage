export type ProviderType =
  | "anthropic"
  | "openai"
  | "azure-openai"
  | "deepseek"
  | "qwen"
  | "zhipu"
  | "ollama"
  | "lm-studio"
  | "custom";

export const openAiCompatibleProviderId = "openai-compatible";
export const legacyOpenAiCompatibleProviderIds = ["openai", "gemini", "antigravity", "grok"] as const;

export function normalizeProviderId(providerId: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();

  return normalizedProviderId === openAiCompatibleProviderId ||
    legacyOpenAiCompatibleProviderIds.includes(normalizedProviderId as (typeof legacyOpenAiCompatibleProviderIds)[number])
    ? openAiCompatibleProviderId
    : providerId.trim();
}

export type EnvironmentName = "development" | "testing" | "production" | "personal";

export const environmentLabels: Record<EnvironmentName, string> = {
  development: "开发",
  testing: "测试",
  production: "生产",
  personal: "个人"
};

export const environmentOptions: Array<{ value: EnvironmentName; label: string }> = [
  { value: "development", label: environmentLabels.development },
  { value: "testing", label: environmentLabels.testing },
  { value: "production", label: environmentLabels.production },
  { value: "personal", label: environmentLabels.personal }
];

export type TestStatus = "success" | "failed" | "untested";
export type OpenAiEndpointMode = "auto" | "chat-completions" | "responses";

export type ModelCapability = "chat" | "reasoning" | "vision" | "embedding" | "tools" | "local";

export const modelCapabilityLabels: Record<ModelCapability, string> = {
  chat: "对话",
  reasoning: "推理",
  vision: "视觉",
  embedding: "向量",
  tools: "工具调用",
  local: "本地"
};

export type ProviderModelStatus = "recommended" | "available" | "local" | "custom";

export const openAiEndpointModeLabels: Record<OpenAiEndpointMode, string> = {
  auto: "自动",
  "chat-completions": "Chat Completions",
  responses: "Responses"
};

export const openAiEndpointModeOptions: Array<{ value: OpenAiEndpointMode; label: string }> = [
  { value: "auto", label: openAiEndpointModeLabels.auto },
  { value: "chat-completions", label: openAiEndpointModeLabels["chat-completions"] },
  { value: "responses", label: openAiEndpointModeLabels.responses }
];

export const providerModelStatusLabels: Record<ProviderModelStatus, string> = {
  recommended: "推荐",
  available: "可用",
  local: "本地",
  custom: "自定义"
};

export interface ApiProvider {
  id: string;
  name: string;
  type: ProviderType;
  defaultBaseUrl: string;
  authType: "bearer" | "api-key-header" | "none";
  isBuiltIn: boolean;
}

export interface ProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: ModelCapability[];
  contextWindow?: string;
  fetchedAt?: string;
  status: ProviderModelStatus;
  notes: string;
}

export interface ApiConfig {
  id: string;
  name: string;
  providerId: string;
  baseUrl: string;
  encryptedApiKey?: string;
  apiKeyPreview: string;
  hasApiKey: boolean;
  defaultModel: string;
  endpointMode: OpenAiEndpointMode;
  environment: EnvironmentName;
  tags: string[];
  notes: string;
  isEnabled: boolean;
  lastTestStatus: TestStatus;
  lastTestAt?: string;
  latencyMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TestHistoryItem {
  id: string;
  configId: string;
  status: TestStatus;
  latencyMs?: number;
  requestEndpoint?: string;
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
  testedAt: string;
}

export type SnippetFormat = "env" | "powershell" | "cmd" | "curl" | "python" | "node";
