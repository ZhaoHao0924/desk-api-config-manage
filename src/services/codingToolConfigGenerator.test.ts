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

  it("generates a CodeBuddy provider template", () => {
    const generatedConfig = generateCodingToolConfig("codebuddy", {
      provider: openAiProvider,
      model: openAiModel,
      baseUrl: "https://api.openai.com/v1"
    });

    expect(generatedConfig.fileName).toBe(".codebuddy/model-provider.json");
    expect(generatedConfig.content).toContain('"compatibleApi": "openai-compatible"');
  });
});
