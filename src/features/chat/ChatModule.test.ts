import { describe, expect, it } from "vitest";
import { openAiCompatibleProviderId, type ApiConfig, type ApiProvider } from "../../types";
import { isChatThinkingSupported, isReadableTextAttachmentName } from "./ChatModule";

const baseConfig: Pick<ApiConfig, "baseUrl"> = {
  baseUrl: "https://api.example.com/v1"
};

const anthropicProvider: Pick<ApiProvider, "id" | "type"> = {
  id: "anthropic",
  type: "anthropic"
};

const openAiProvider: Pick<ApiProvider, "id" | "type"> = {
  id: openAiCompatibleProviderId,
  type: "openai"
};

describe("chat thinking support", () => {
  it("supports manually enabled thinking for Anthropic chat requests", () => {
    expect(isChatThinkingSupported(baseConfig, anthropicProvider, "auto")).toBe(true);
  });

  it("supports manually enabled thinking for OpenAI-compatible Responses requests", () => {
    expect(isChatThinkingSupported(baseConfig, openAiProvider, "responses")).toBe(true);
  });

  it("supports manually enabled thinking for official OpenAI auto mode because it uses Responses", () => {
    expect(
      isChatThinkingSupported({ baseUrl: "https://api.openai.com/v1" }, openAiProvider, "auto")
    ).toBe(true);
  });

  it("does not support thinking for generic Chat Completions-compatible endpoints", () => {
    expect(isChatThinkingSupported(baseConfig, openAiProvider, "auto")).toBe(false);
    expect(isChatThinkingSupported({ baseUrl: "https://integrate.api.nvidia.com/v1" }, openAiProvider, "auto")).toBe(
      false
    );
    expect(
      isChatThinkingSupported({ baseUrl: "https://api.openai.com/v1" }, openAiProvider, "chat-completions")
    ).toBe(false);
  });
});

describe("chat text attachment detection", () => {
  it("treats common JavaScript module files as readable text attachments", () => {
    expect(isReadableTextAttachmentName("mock-stream-server.cjs")).toBe(true);
    expect(isReadableTextAttachmentName("module-entry.mjs")).toBe(true);
  });

  it("uses text MIME types and rejects unknown binary-looking names", () => {
    expect(isReadableTextAttachmentName("notes.bin", "text/plain")).toBe(true);
    expect(isReadableTextAttachmentName("archive.bin")).toBe(false);
  });
});
