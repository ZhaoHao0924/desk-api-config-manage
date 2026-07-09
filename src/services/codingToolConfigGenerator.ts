import type { ApiProvider, ProviderModel } from "../types";
import { openAiCompatibleProviderId } from "../types";
import { buildChatCompletionsUrl } from "./connectionTestService";

export type CodingToolTarget = "claude-code" | "codex" | "codebuddy";

export const codingToolLabels: Record<CodingToolTarget, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  codebuddy: "CodeBuddy"
};

export interface CodingToolConfigInput {
  provider: ApiProvider;
  model: ProviderModel;
  baseUrl: string;
}

export interface GeneratedCodingToolConfig {
  target: CodingToolTarget;
  title: string;
  fileName: string;
  language: "json" | "toml";
  description: string;
  content: string;
}

function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toEnvName(value: string): string {
  const normalizedValue = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalizedValue || "LLM";
}

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

const codexBuiltInProviderKeys = new Set(["openai", "azure", "ollama", "lmstudio"]);

function getCodexProviderKey(provider: ApiProvider): string {
  const providerKey = normalizeIdentifier(provider.name) || "custom-provider";

  return codexBuiltInProviderKeys.has(providerKey) ? `${providerKey}-custom` : providerKey;
}

function getClaudeCodeAuthEnvKey(provider: ApiProvider): "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "" {
  if (provider.authType === "none") {
    return "";
  }

  return provider.authType === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
}

export function getProviderApiKeyEnv(provider: ApiProvider): string {
  if (provider.authType === "none") {
    return "";
  }

  if (provider.type === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }

  if (provider.id === openAiCompatibleProviderId) {
    return "OPENAI_COMPATIBLE_API_KEY";
  }

  if (provider.type === "openai") {
    return "OPENAI_API_KEY";
  }

  return `${toEnvName(provider.name)}_API_KEY`;
}

function getCodeBuddyChatCompletionsUrl(input: CodingToolConfigInput): string {
  if (input.provider.type === "anthropic") {
    return "<OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL>";
  }

  const trimmedBaseUrl = input.baseUrl.trim();

  if (!trimmedBaseUrl) {
    return "<BASE_URL>/chat/completions";
  }

  try {
    return buildChatCompletionsUrl(trimmedBaseUrl, input.provider);
  } catch {
    return `${trimmedBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  }
}

function getCodeBuddyApiKeyEnv(provider: ApiProvider): string {
  if (provider.authType === "none") {
    return "";
  }

  if (provider.type === "anthropic") {
    return "CODEBUDDY_MODEL_API_KEY";
  }

  return getProviderApiKeyEnv(provider);
}

export function generateClaudeCodeConfig(input: CodingToolConfigInput): GeneratedCodingToolConfig {
  const apiKeyEnv = getProviderApiKeyEnv(input.provider);
  const claudeCodeAuthEnvKey = getClaudeCodeAuthEnvKey(input.provider);
  const env: Record<string, string> = {
    ANTHROPIC_MODEL: input.model.modelId,
    ANTHROPIC_CUSTOM_MODEL_OPTION: input.model.modelId,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: input.model.displayName
  };

  if (input.baseUrl) {
    env.ANTHROPIC_BASE_URL = input.baseUrl;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  }

  if (apiKeyEnv && claudeCodeAuthEnvKey) {
    env[claudeCodeAuthEnvKey] = `$${apiKeyEnv}`;
  }

  return {
    target: "claude-code",
    title: "Claude Code settings.local.json",
    fileName: ".claude/settings.local.json",
    language: "json",
    description:
      "用于 Claude Code 项目级设置。Base URL 需要兼容 Anthropic/Claude API；Bearer 网关使用 ANTHROPIC_AUTH_TOKEN。",
    content: JSON.stringify(
      {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        model: input.model.modelId,
        availableModels: [input.model.modelId],
        env
      },
      null,
      2
    )
  };
}

export function generateCodexConfig(input: CodingToolConfigInput): GeneratedCodingToolConfig {
  const providerKey = getCodexProviderKey(input.provider);
  const apiKeyEnv = getProviderApiKeyEnv(input.provider);
  const envKeyLine = apiKeyEnv ? `env_key = ${quoteToml(apiKeyEnv)}\n` : "";

  return {
    target: "codex",
    title: "Codex config.toml",
    fileName: ".codex/config.toml",
    language: "toml",
    description:
      "用于 Codex 项目级配置。Codex 当前自定义模型供应商使用 Responses wire API；纯 Chat Completions 端点需要先提供 Responses 兼容层。",
    content: `model = ${quoteToml(input.model.modelId)}
model_provider = ${quoteToml(providerKey)}

[model_providers.${providerKey}]
name = ${quoteToml(input.provider.name)}
base_url = ${quoteToml(input.baseUrl)}
${envKeyLine}wire_api = "responses"
`
  };
}

export function generateCodeBuddyConfig(input: CodingToolConfigInput): GeneratedCodingToolConfig {
  const apiKeyEnv = getCodeBuddyApiKeyEnv(input.provider);
  const modelConfig: {
    id: string;
    name: string;
    vendor: string;
    apiKey?: string;
    url: string;
    supportsToolCall: boolean;
    supportsImages: boolean;
    supportsReasoning: boolean;
  } = {
    id: input.model.modelId,
    name: input.model.displayName,
    vendor: input.provider.name,
    url: getCodeBuddyChatCompletionsUrl(input),
    supportsToolCall: input.model.capabilities.includes("tools"),
    supportsImages: input.model.capabilities.includes("vision"),
    supportsReasoning: input.model.capabilities.includes("reasoning")
  };

  if (apiKeyEnv) {
    modelConfig.apiKey = `\${${apiKeyEnv}}`;
  }

  return {
    target: "codebuddy",
    title: "CodeBuddy models.json",
    fileName: ".codebuddy/models.json",
    language: "json",
    description:
      "用于 CodeBuddy Code 项目级 models.json；CodeBuddy 文档要求 OpenAI-compatible Chat Completions 完整接口路径，非兼容原生 API 需改为兼容网关 URL。",
    content: JSON.stringify(
      {
        models: [modelConfig],
        availableModels: [input.model.modelId]
      },
      null,
      2
    )
  };
}

export function generateCodingToolConfig(
  target: CodingToolTarget,
  input: CodingToolConfigInput
): GeneratedCodingToolConfig {
  if (target === "claude-code") {
    return generateClaudeCodeConfig(input);
  }

  if (target === "codex") {
    return generateCodexConfig(input);
  }

  return generateCodeBuddyConfig(input);
}
