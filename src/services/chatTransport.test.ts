import { describe, expect, it, vi } from "vitest";
import { openAiCompatibleProviderId } from "../types";
import { createDesktopChatTransport } from "./chatTransport";

describe("chatTransport", () => {
  it("returns undefined when the preload chat API is unavailable", () => {
    expect(createDesktopChatTransport(undefined)).toBeUndefined();
  });

  it("delegates chat requests to the preload API", async () => {
    const deskApi: NonNullable<Window["deskApi"]> = {
      getAppVersion: async () => "0.1.0",
      secrets: {
        isEncryptionAvailable: vi.fn(async () => true),
        encrypt: vi.fn(async () => "encrypted"),
        decrypt: vi.fn(async () => "secret"),
        copyToClipboard: vi.fn(async () => ({ clearAfterMs: 30_000 }))
      },
      clipboard: {
        writeText: vi.fn(async () => ({ ok: true }))
      },
      connection: {
        testOpenAiCompatible: vi.fn(async () => ({
          ok: true,
          status: 200,
          latencyMs: 42
        }))
      },
      chat: {
        sendMessage: vi.fn(async () => ({
          content: "pong",
          ok: true,
          status: 200,
          latencyMs: 120,
          requestEndpoint: "https://api.example.com/v1/chat/completions"
        })),
        streamMessage: vi.fn(async (_request, onEvent) => {
          onEvent({ type: "chunk", content: "po" });
          onEvent({
            content: "pong",
            ok: true,
            status: 200,
            latencyMs: 80,
            requestEndpoint: "https://api.example.com/v1/chat/completions",
            type: "done"
          });

          return {
            content: "pong",
            ok: true,
            status: 200,
            latencyMs: 80,
            requestEndpoint: "https://api.example.com/v1/chat/completions"
          };
        })
      },
      models: {
        fetchProviderModels: vi.fn(async () => ({
          models: [],
          requestEndpoint: "https://api.example.com/v1/models"
        }))
      }
    };
    const request = {
      authType: "bearer" as const,
      baseUrl: "https://api.example.com/v1",
      endpointMode: "auto" as const,
      encryptedApiKey: "encrypted",
      messages: [{ content: "ping", role: "user" as const }],
      model: "gpt-4.1-mini",
      providerId: openAiCompatibleProviderId,
      providerType: "openai" as const,
      thinkingEnabled: true,
      timeoutMs: 60_000
    };
    const transport = createDesktopChatTransport(deskApi);

    await expect(transport?.sendMessage(request)).resolves.toEqual({
      content: "pong",
      ok: true,
      status: 200,
      latencyMs: 120,
      requestEndpoint: "https://api.example.com/v1/chat/completions"
    });
    expect(deskApi.chat?.sendMessage).toHaveBeenCalledWith(request);

    const streamEvents: Array<{ content?: string; type: "chunk" | "done" | "error" }> = [];

    await expect(transport?.streamMessage?.(request, (event) => streamEvents.push(event))).resolves.toEqual({
      content: "pong",
      ok: true,
      status: 200,
      latencyMs: 80,
      requestEndpoint: "https://api.example.com/v1/chat/completions"
    });
    expect(deskApi.chat?.streamMessage).toHaveBeenCalledWith(request, expect.any(Function));
    expect(streamEvents).toEqual([
      { type: "chunk", content: "po" },
      {
        content: "pong",
        ok: true,
        status: 200,
        latencyMs: 80,
        requestEndpoint: "https://api.example.com/v1/chat/completions",
        type: "done"
      }
    ]);
  });
});
