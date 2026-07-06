import type { ApiConfigRepository } from "../domain/repositories";
import { normalizeProviderId } from "../types";
import type { ApiConfig, EnvironmentName, OpenAiEndpointMode } from "../types";
import { maskSecret } from "../utils/maskSecret";
import type { SecretService } from "./secretService";

export interface ApiConfigInput {
  name: string;
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  endpointMode?: OpenAiEndpointMode;
  environment: EnvironmentName;
  tags: string[];
  notes: string;
  isEnabled: boolean;
}

export interface UpdateApiConfigOptions {
  replaceApiKey?: boolean;
}

interface ConfigServiceOptions {
  createId?: () => string;
  now?: () => string;
  secretService?: SecretService;
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

function defaultNow(): string {
  return new Date().toISOString();
}

export function normalizeTags(tags: string[]): string[] {
  const seenTags = new Set<string>();
  const normalizedTags: string[] = [];

  for (const tag of tags) {
    const normalizedTag = tag.trim();
    const tagKey = normalizedTag.toLocaleLowerCase();

    if (!normalizedTag || seenTags.has(tagKey)) {
      continue;
    }

    seenTags.add(tagKey);
    normalizedTags.push(normalizedTag);
  }

  return normalizedTags;
}

function normalizeEndpointMode(value: OpenAiEndpointMode | undefined): OpenAiEndpointMode {
  return value === "chat-completions" || value === "responses" || value === "auto" ? value : "auto";
}

function normalizeInput(input: ApiConfigInput): ApiConfigInput & { endpointMode: OpenAiEndpointMode } {
  const normalizedInput = {
    ...input,
    name: input.name.trim(),
    providerId: normalizeProviderId(input.providerId),
    baseUrl: input.baseUrl.trim(),
    apiKey: input.apiKey?.trim(),
    defaultModel: input.defaultModel.trim(),
    endpointMode: normalizeEndpointMode(input.endpointMode),
    notes: input.notes.trim(),
    tags: normalizeTags(input.tags)
  };

  if (!normalizedInput.name) {
    throw new Error("配置名称不能为空");
  }

  if (!normalizedInput.providerId) {
    throw new Error("供应商不能为空");
  }

  if (!normalizedInput.baseUrl) {
    throw new Error("Base URL 不能为空");
  }

  if (!normalizedInput.defaultModel) {
    throw new Error("默认模型不能为空");
  }

  return normalizedInput;
}

async function toSecretState(
  apiKey: string | undefined,
  secretService: SecretService | undefined
): Promise<Pick<ApiConfig, "encryptedApiKey" | "apiKeyPreview" | "hasApiKey">> {
  if (!apiKey) {
    return {
      encryptedApiKey: undefined,
      apiKeyPreview: "未设置",
      hasApiKey: false
    };
  }

  if (!secretService) {
    throw new Error("当前环境未启用安全存储，无法保存 API Key");
  }

  const encryptedApiKey = await secretService.encryptSecret(apiKey);

  if (!encryptedApiKey) {
    throw new Error("API Key 加密失败");
  }

  return {
    encryptedApiKey,
    apiKeyPreview: maskSecret(apiKey),
    hasApiKey: true
  };
}

export async function createApiConfig(
  repository: ApiConfigRepository,
  input: ApiConfigInput,
  options: ConfigServiceOptions = {}
): Promise<ApiConfig> {
  const normalizedInput = normalizeInput(input);
  const now = options.now?.() ?? defaultNow();
  const secretState = await toSecretState(normalizedInput.apiKey, options.secretService);

  const config: ApiConfig = {
    id: options.createId?.() ?? defaultCreateId(),
    name: normalizedInput.name,
    providerId: normalizedInput.providerId,
    baseUrl: normalizedInput.baseUrl,
    encryptedApiKey: secretState.encryptedApiKey,
    apiKeyPreview: secretState.apiKeyPreview,
    hasApiKey: secretState.hasApiKey,
    defaultModel: normalizedInput.defaultModel,
    endpointMode: normalizedInput.endpointMode,
    environment: normalizedInput.environment,
    tags: normalizedInput.tags,
    notes: normalizedInput.notes,
    isEnabled: normalizedInput.isEnabled,
    lastTestStatus: "untested",
    createdAt: now,
    updatedAt: now
  };

  return repository.saveConfig(config);
}

export async function updateApiConfig(
  repository: ApiConfigRepository,
  id: string,
  input: ApiConfigInput,
  options: UpdateApiConfigOptions & ConfigServiceOptions = {}
): Promise<ApiConfig> {
  const existingConfig = await repository.getConfig(id);

  if (!existingConfig) {
    throw new Error(`配置不存在：${id}`);
  }

  const normalizedInput = normalizeInput(input);
  const shouldResetTestStatus =
    existingConfig.providerId !== normalizedInput.providerId ||
    existingConfig.baseUrl !== normalizedInput.baseUrl ||
    existingConfig.defaultModel !== normalizedInput.defaultModel ||
    existingConfig.endpointMode !== normalizedInput.endpointMode ||
    Boolean(options.replaceApiKey);

  const secretState = options.replaceApiKey
    ? await toSecretState(normalizedInput.apiKey, options.secretService)
    : {
        encryptedApiKey: existingConfig.encryptedApiKey,
        apiKeyPreview: existingConfig.apiKeyPreview,
        hasApiKey: existingConfig.hasApiKey
      };

  const nextConfig: ApiConfig = {
    ...existingConfig,
    name: normalizedInput.name,
    providerId: normalizedInput.providerId,
    baseUrl: normalizedInput.baseUrl,
    encryptedApiKey: secretState.encryptedApiKey,
    apiKeyPreview: secretState.apiKeyPreview,
    hasApiKey: secretState.hasApiKey,
    defaultModel: normalizedInput.defaultModel,
    endpointMode: normalizedInput.endpointMode,
    environment: normalizedInput.environment,
    tags: normalizedInput.tags,
    notes: normalizedInput.notes,
    isEnabled: normalizedInput.isEnabled,
    lastTestStatus: shouldResetTestStatus ? "untested" : existingConfig.lastTestStatus,
    lastTestAt: shouldResetTestStatus ? undefined : existingConfig.lastTestAt,
    latencyMs: shouldResetTestStatus ? undefined : existingConfig.latencyMs,
    updatedAt: options.now?.() ?? defaultNow()
  };

  return repository.replaceConfig(nextConfig);
}

export async function deleteApiConfig(repository: ApiConfigRepository, id: string): Promise<void> {
  await repository.deleteConfig(id);
}
