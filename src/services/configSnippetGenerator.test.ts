import { describe, expect, it } from "vitest";
import { openAiCompatibleProviderId } from "../types";
import type { ApiConfig, SnippetFormat } from "../types";
import { createConfigSnippet, snippetFormatLabels } from "./configSnippetGenerator";

const baseConfig: ApiConfig = {
  apiKeyPreview: "sk-test...1234",
  baseUrl: "https://api.example.com/v1",
  createdAt: "2026-07-09T00:00:00.000Z",
  defaultModel: "gpt-4.1-mini",
  encryptedApiKey: "encrypted-secret-value",
  endpointMode: "chat-completions",
  environment: "development",
  hasApiKey: true,
  id: "cfg-openai-compatible",
  isEnabled: true,
  lastTestStatus: "untested",
  name: "OpenAI-compatible",
  notes: "",
  providerId: openAiCompatibleProviderId,
  tags: [],
  updatedAt: "2026-07-09T00:00:00.000Z"
};

describe("configSnippetGenerator", () => {
  it("generates every M5 accepted generic snippet format", () => {
    const formats: SnippetFormat[] = ["env", "powershell", "cmd", "curl", "python", "node"];
    const snippets = formats.map((format) => createConfigSnippet(format, baseConfig));

    expect(snippets.map((snippet) => snippet.format)).toEqual(formats);
    expect(snippets.map((snippet) => snippet.title)).toEqual([
      ".env",
      "PowerShell",
      "CMD",
      "curl",
      "Python OpenAI SDK",
      "Node.js OpenAI SDK"
    ]);
    expect(Object.keys(snippetFormatLabels).sort()).toEqual([...formats].sort());
  });

  it("keeps generated snippets secret-free", () => {
    const rawSnippets = (Object.keys(snippetFormatLabels) as SnippetFormat[])
      .map((format) => createConfigSnippet(format, baseConfig).content)
      .join("\n");

    expect(rawSnippets).toContain("sk-test...1234");
    expect(rawSnippets).not.toContain("encrypted-secret-value");
  });

  it("creates the masked .env snippet kept by the detail shortcut", () => {
    expect(createConfigSnippet("env", baseConfig).content).toBe(
      "LLM_API_KEY=sk-test...1234\nLLM_BASE_URL=https://api.example.com/v1\nLLM_MODEL=gpt-4.1-mini"
    );
  });

  it("generates chat completions request snippets by default", () => {
    expect(createConfigSnippet("curl", baseConfig).content).toContain(
      "https://api.example.com/v1/chat/completions"
    );
    expect(createConfigSnippet("python", baseConfig).content).toContain("client.chat.completions.create");
    expect(createConfigSnippet("node", baseConfig).content).toContain("client.chat.completions.create");
  });

  it("generates Responses request snippets when the config requests Responses mode", () => {
    const responsesConfig = {
      ...baseConfig,
      endpointMode: "responses" as const
    };

    expect(createConfigSnippet("curl", responsesConfig).content).toContain("https://api.example.com/v1/responses");
    expect(createConfigSnippet("python", responsesConfig).content).toContain("client.responses.create");
    expect(createConfigSnippet("node", responsesConfig).content).toContain("client.responses.create");
  });

  it("uses an API key placeholder when no masked key is available", () => {
    const missingKeyConfig = {
      ...baseConfig,
      apiKeyPreview: "未设置",
      encryptedApiKey: undefined,
      hasApiKey: false
    };

    expect(createConfigSnippet("env", missingKeyConfig).content).toContain('LLM_API_KEY="<API_KEY>"');
    expect(createConfigSnippet("curl", missingKeyConfig).content).toContain("Bearer <API_KEY>");
  });
});

