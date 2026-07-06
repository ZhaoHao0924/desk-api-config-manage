import { openAiCompatibleProviderId } from "../types";
import type { ApiConfig, ApiProvider, ProviderModel, TestHistoryItem } from "../types";

const seedTimestamp = "2026-07-01T10:00:00.000Z";
const missingApiKeyPreview = "未设置";

export const defaultProviders: ApiProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    authType: "api-key-header",
    isBuiltIn: true
  },
  {
    id: openAiCompatibleProviderId,
    name: "OpenAI-compatible",
    type: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    authType: "bearer",
    isBuiltIn: true
  }
];

export const defaultProviderModels: ProviderModel[] = [
  {
    id: "model-anthropic-claude-sonnet",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    capabilities: ["chat", "reasoning", "tools"],
    contextWindow: "200K tokens",
    status: "recommended",
    notes: "适合日常代码、写作和复杂推理任务。连接测试后续需要 Anthropic 专用请求格式。"
  },
  {
    id: "model-anthropic-claude-opus",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    displayName: "Claude Opus 4.1",
    capabilities: ["chat", "reasoning", "tools"],
    contextWindow: "200K tokens",
    status: "available",
    notes: "面向高难度推理、规划和长上下文任务。"
  },
  {
    id: "model-openai-gpt-4-1",
    providerId: openAiCompatibleProviderId,
    modelId: "gpt-4.1",
    displayName: "GPT-4.1",
    capabilities: ["chat", "vision", "tools"],
    contextWindow: "1M tokens",
    status: "recommended",
    notes: "通用旗舰模型，适合复杂代码、写作和多模态任务。"
  },
  {
    id: "model-openai-gpt-4-1-mini",
    providerId: openAiCompatibleProviderId,
    modelId: "gpt-4.1-mini",
    displayName: "GPT-4.1 mini",
    capabilities: ["chat", "vision", "tools"],
    contextWindow: "1M tokens",
    status: "recommended",
    notes: "成本和速度更均衡，适合默认开发配置。"
  },
  {
    id: "model-openai-o3",
    providerId: openAiCompatibleProviderId,
    modelId: "o3",
    displayName: "o3",
    capabilities: ["chat", "reasoning", "tools"],
    contextWindow: "200K tokens",
    status: "available",
    notes: "偏推理和复杂问题求解。"
  },
  {
    id: "model-gemini-2-5-pro",
    providerId: openAiCompatibleProviderId,
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    capabilities: ["chat", "reasoning", "vision", "tools"],
    contextWindow: "1M tokens",
    status: "recommended",
    notes: "通过 Gemini OpenAI-compatible endpoint 使用。"
  },
  {
    id: "model-gemini-2-5-flash",
    providerId: openAiCompatibleProviderId,
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    capabilities: ["chat", "vision", "tools"],
    contextWindow: "1M tokens",
    status: "available",
    notes: "适合低延迟和成本敏感的日常任务。"
  },
  {
    id: "model-antigravity-default",
    providerId: openAiCompatibleProviderId,
    modelId: "<antigravity-model-id>",
    displayName: "Antigravity model",
    capabilities: ["chat"],
    status: "custom",
    notes: "Antigravity 暂作为可填写 Base URL 和模型名的内置入口。"
  },
  {
    id: "model-grok-4",
    providerId: openAiCompatibleProviderId,
    modelId: "grok-4",
    displayName: "Grok 4",
    capabilities: ["chat", "reasoning", "tools"],
    contextWindow: "256K tokens",
    status: "recommended",
    notes: "通过 xAI OpenAI-compatible endpoint 使用。"
  },
  {
    id: "model-grok-3-mini",
    providerId: openAiCompatibleProviderId,
    modelId: "grok-3-mini",
    displayName: "Grok 3 mini",
    capabilities: ["chat", "reasoning"],
    contextWindow: "128K tokens",
    status: "available",
    notes: "适合速度和成本更敏感的任务。"
  }
];

export const defaultConfigs: ApiConfig[] = [
  {
    id: "cfg-anthropic-dev",
    name: "Anthropic - 开发",
    providerId: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyPreview: missingApiKeyPreview,
    hasApiKey: false,
    defaultModel: "claude-sonnet-4-5",
    endpointMode: "auto",
    environment: "development",
    tags: ["开发", "代码"],
    notes: "Anthropic 专用连接测试后续实现",
    isEnabled: true,
    lastTestStatus: "untested",
    createdAt: seedTimestamp,
    updatedAt: seedTimestamp
  },
  {
    id: "cfg-openai-dev",
    name: "OpenAI - 开发",
    providerId: openAiCompatibleProviderId,
    baseUrl: "https://api.openai.com/v1",
    apiKeyPreview: missingApiKeyPreview,
    hasApiKey: false,
    defaultModel: "gpt-4.1-mini",
    endpointMode: "auto",
    environment: "development",
    tags: ["开发", "聊天"],
    notes: "默认 OpenAI-compatible 配置",
    isEnabled: true,
    lastTestStatus: "untested",
    createdAt: seedTimestamp,
    updatedAt: seedTimestamp
  },
  {
    id: "cfg-gemini-dev",
    name: "Gemini - 开发",
    providerId: openAiCompatibleProviderId,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyPreview: missingApiKeyPreview,
    hasApiKey: false,
    defaultModel: "gemini-2.5-flash",
    endpointMode: "auto",
    environment: "development",
    tags: ["开发", "多模态"],
    notes: "使用 Gemini OpenAI-compatible endpoint",
    isEnabled: true,
    lastTestStatus: "untested",
    createdAt: seedTimestamp,
    updatedAt: seedTimestamp
  },
  {
    id: "cfg-antigravity-template",
    name: "Antigravity - 模板",
    providerId: openAiCompatibleProviderId,
    baseUrl: "",
    apiKeyPreview: missingApiKeyPreview,
    hasApiKey: false,
    defaultModel: "<antigravity-model-id>",
    endpointMode: "auto",
    environment: "personal",
    tags: ["模板"],
    notes: "请填写 Antigravity 可用的 Base URL 和模型名",
    isEnabled: false,
    lastTestStatus: "untested",
    createdAt: seedTimestamp,
    updatedAt: seedTimestamp
  },
  {
    id: "cfg-grok-dev",
    name: "Grok - 开发",
    providerId: openAiCompatibleProviderId,
    baseUrl: "https://api.x.ai/v1",
    apiKeyPreview: missingApiKeyPreview,
    hasApiKey: false,
    defaultModel: "grok-4",
    endpointMode: "auto",
    environment: "development",
    tags: ["开发", "推理"],
    notes: "使用 xAI OpenAI-compatible endpoint",
    isEnabled: true,
    lastTestStatus: "untested",
    createdAt: seedTimestamp,
    updatedAt: seedTimestamp
  }
];

export const defaultTestHistory: TestHistoryItem[] = [];
