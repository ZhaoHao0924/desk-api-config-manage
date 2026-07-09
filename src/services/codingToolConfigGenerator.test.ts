import { describe, expect, it } from "vitest";
import { defaultProviderModels, defaultProviders } from "../data/sampleData";
import { openAiCompatibleProviderId } from "../types";
import type { ApiProvider, ProviderModel } from "../types";
import { generateCodingToolConfig, getProviderApiKeyEnv } from "./codingToolConfigGenerator";

const anthropicProvider = defaultProviders.find((provider) => provider.id === "anthropic")!;
const openAiProvider = defaultProviders.find((provider) => provider.id === openAiCompatibleProviderId)!;
const openAiModel = defaultProviderModels.find((model) => model.modelId === "gpt-4.1-mini")!;
const noAuthProvider: ApiProvider = {
  id: "local-openai-compatible",
  name: "Local OpenAI-compatible",
  type: "custom",
  defaultBaseUrl: "http://localhost:11434/v1",
  authType: "none",
  isBuiltIn: false
};
const noAuthModel: ProviderModel = {
  id: "model-local-test",
  providerId: "local-openai-compatible",
  modelId: "local-chat",
  displayName: "Local Chat",
  capabilities: ["chat", "local"],
  status: "custom",
  notes: ""
};

describe("codingToolConfigGenerator", () => {
  it("derives provider API key environment names", () => {
    expect(getProviderApiKeyEnv(anthropicProvider)).toBe("ANTHROPIC_API_KEY");
    expect(getProviderApiKeyEnv(openAiProvider)).toBe("OPENAI_COMPATIBLE_API_KEY");
    expect(getProviderApiKeyEnv(noAuthProvider)).toBe("");
  });

  it("generates Claude Code settings", () => {
    const generatedConfig = generateCodingToolConfig("claude-code", {
      provider: openAiProvider,
      model: openAiModel,
      baseUrl: "https://api.openai.com/v1"
    });

    expect(generatedConfig.fileName).toBe(".claude/settings.local.json");
    expect(generatedConfig.content).toContain('"model": "gpt-4.1-mini"');
    expect(generatedConfig.content).toContain('"ANTHROPIC_BASE_URL": "https://api.openai.com/v1"');
    expect(generatedConfig.content).toContain('"ANTHROPIC_AUTH_TOKEN": "$OPENAI_COMPATIBLE_API_KEY"');
    expect(generatedConfig.content).not.toContain('"ANTHROPIC_API_KEY": "$OPENAI_COMPATIBLE_API_KEY"');
  });

  it("uses Anthropic API key env for Claude Code API-key-header providers", () => {
    const generatedConfig = generateCodingToolConfig("claude-code", {
      provider: anthropicProvider,
      model: defaultProviderModels.find((model) => model.modelId === "claude-sonnet-4-5")!,
      baseUrl: "https://api.anthropic.com/v1"
    });

    expect(generatedConfig.content).toContain('"ANTHROPIC_API_KEY": "$ANTHROPIC_API_KEY"');
    expect(generatedConfig.content).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("generates Codex TOML config", () => {
    const generatedConfig = generateCodingToolConfig("codex", {
      provider: openAiProvider,
      model: openAiModel,
      baseUrl: "https://api.openai.com/v1"
    });

    expect(generatedConfig.fileName).toBe(".codex/config.toml");
    expect(generatedConfig.content).toContain('model = "gpt-4.1-mini"');
    expect(generatedConfig.content).toContain('model_provider = "openai-compatible"');
    expect(generatedConfig.content).toContain('env_key = "OPENAI_COMPATIBLE_API_KEY"');
    expect(generatedConfig.content).toContain('wire_api = "responses"');
    expect(generatedConfig.content).not.toContain('wire_api = "chat"');
  });

  it("omits API key env for providers that do not require auth", () => {
    const generatedConfig = generateCodingToolConfig("codex", {
      provider: noAuthProvider,
      model: noAuthModel,
      baseUrl: "http://localhost:11434/v1"
    });

    expect(generatedConfig.content).not.toContain("env_key");
  });

  it("generates CodeBuddy models.json from the official local model schema", () => {
    const generatedConfig = generateCodingToolConfig("codebuddy", {
      provider: openAiProvider,
      model: openAiModel,
      baseUrl: "https://api.openai.com/v1"
    });
    const parsedContent = JSON.parse(generatedConfig.content);

    expect(generatedConfig.fileName).toBe(".codebuddy/models.json");
    expect(parsedContent).toEqual({
      models: [
        {
          id: "gpt-4.1-mini",
          name: "GPT-4.1 mini",
          vendor: openAiProvider.name,
          url: "https://api.openai.com/v1/chat/completions",
          supportsToolCall: true,
          supportsImages: true,
          supportsReasoning: false,
          apiKey: "${OPENAI_COMPATIBLE_API_KEY}"
        }
      ],
      availableModels: ["gpt-4.1-mini"]
    });
  });

  it("omits CodeBuddy apiKey for no-auth local providers", () => {
    const generatedConfig = generateCodingToolConfig("codebuddy", {
      provider: noAuthProvider,
      model: noAuthModel,
      baseUrl: "http://localhost:11434/v1"
    });
    const parsedContent = JSON.parse(generatedConfig.content);

    expect(parsedContent.models[0]).toEqual({
      id: "local-chat",
      name: "Local Chat",
      vendor: "Local OpenAI-compatible",
      url: "http://localhost:11434/v1/chat/completions",
      supportsToolCall: false,
      supportsImages: false,
      supportsReasoning: false
    });
  });

  it("uses a compatible-gateway placeholder for Anthropic CodeBuddy output", () => {
    const generatedConfig = generateCodingToolConfig("codebuddy", {
      provider: anthropicProvider,
      model: defaultProviderModels.find((model) => model.modelId === "claude-sonnet-4-5")!,
      baseUrl: "https://api.anthropic.com/v1"
    });
    const parsedContent = JSON.parse(generatedConfig.content);

    expect(parsedContent.models[0].url).toBe("<OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL>");
    expect(parsedContent.models[0].apiKey).toBe("${CODEBUDDY_MODEL_API_KEY}");
    expect(parsedContent.models[0].url).not.toContain("api.anthropic.com/v1/chat/completions");
  });

  it("keeps CodeBuddy generation render-safe when Base URL is missing", () => {
    const generatedConfig = generateCodingToolConfig("codebuddy", {
      provider: noAuthProvider,
      model: noAuthModel,
      baseUrl: ""
    });
    const parsedContent = JSON.parse(generatedConfig.content);

    expect(parsedContent.models[0].url).toBe("<BASE_URL>/chat/completions");
  });
});
