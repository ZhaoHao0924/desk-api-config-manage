import { describe, expect, it, vi } from "vitest";
import { openAiCompatibleProviderId } from "../types";
import { createDesktopConnectionTestTransport } from "./connectionTestTransport";

describe("connectionTestTransport", () => {
  it("returns undefined when the preload connection API is unavailable", () => {
    expect(createDesktopConnectionTestTransport(undefined)).toBeUndefined();
  });

  it("delegates connection tests to the preload API", async () => {
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
          latencyMs: 42,
          requestEndpoint: "https://api.example.com/v1/chat/completions"
        }))
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
      model: "gpt-4.1-mini",
      providerId: openAiCompatibleProviderId,
      providerType: "openai" as const,
      timeoutMs: 15_000
    };
    const transport = createDesktopConnectionTestTransport(deskApi);

    await expect(transport?.testOpenAiCompatible(request)).resolves.toEqual({
      ok: true,
      status: 200,
      latencyMs: 42,
      requestEndpoint: "https://api.example.com/v1/chat/completions"
    });
    expect(deskApi.connection.testOpenAiCompatible).toHaveBeenCalledWith(request);
  });
});
