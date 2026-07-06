import { describe, expect, it, vi } from "vitest";
import { createDesktopModelFetchTransport } from "./modelFetchTransport";

describe("modelFetchTransport", () => {
  it("returns undefined when the preload model API is unavailable", () => {
    expect(createDesktopModelFetchTransport(undefined)).toBeUndefined();
  });

  it("delegates provider model fetches to the preload API", async () => {
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
      models: {
        fetchProviderModels: vi.fn(async () => ({
          ok: true,
          models: ["gpt-4.1-mini", "gpt-4.1"],
          requestEndpoint: "https://api.openai.com/v1/models",
          status: 200
        }))
      }
    };
    const request = {
      apiKey: "sk-test",
      authType: "bearer" as const,
      baseUrl: "https://api.openai.com/v1",
      encryptedApiKey: "encrypted-key",
      providerType: "openai" as const,
      timeoutMs: 15_000
    };
    const transport = createDesktopModelFetchTransport(deskApi);

    await expect(transport?.fetchProviderModels(request)).resolves.toEqual({
      ok: true,
      models: ["gpt-4.1-mini", "gpt-4.1"],
      requestEndpoint: "https://api.openai.com/v1/models",
      status: 200
    });
    expect(deskApi.models.fetchProviderModels).toHaveBeenCalledWith(request);
  });

  it("sanitizes provider model fetch transport results before returning them", async () => {
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
      models: {
        fetchProviderModels: vi.fn(async () => ({
          errorMessage:
            "model fetch failed https://user:password@api.openai.com/v1/models xApiKey=camel-x-api-secret x-goog-api-key=x-goog-secret xGoogApiKey=camel-x-goog-secret googleApiKey=google-api-secret azureSubscriptionKey=azure-subscription-secret clientSecret=camel-client-secret ocp-apim-subscription-key=ocp-apim-secret refreshToken=camel-refresh-secret subscriptionKey=subscription-secret access-token=hyphen-access-secret Cookie: session=model-cookie; Authorization: Bearer sk-form-1234567890abcdef Authorization: Basic basic-secret encrypted-key api-key=gateway-token",
          models: [],
          ok: false,
          requestEndpoint:
            "https://user:password@api.openai.com/v1/models?api_key=secret&api-version=2026-01-01&access-token=hyphen-access-secret&authorization=Bearer%20query-secret&azureSubscriptionKey=azure-subscription-secret&bearerToken=bearer-query-secret&clientSecret=camel-client-secret&client_secret=oauth-secret&googleApiKey=google-api-secret&key=gateway-secret&ocp-apim-subscription-key=ocp-apim-secret&refreshToken=camel-refresh-secret&refresh_token=refresh-secret&secretKey=camel-secret-key&sessionToken=camel-session-secret&signature=encrypted-key&subscriptionKey=subscription-secret&token=secret&xApiKey=camel-x-api-secret&x-goog-api-key=x-goog-secret&xGoogApiKey=camel-x-goog-secret#fragment",
          status: 401
        }))
      }
    };
    const request = {
      apiKey: "sk-form-1234567890abcdef",
      authType: "bearer" as const,
      baseUrl: "https://api.openai.com/v1",
      encryptedApiKey: "encrypted-key",
      providerType: "openai" as const,
      timeoutMs: 15_000
    };
    const transport = createDesktopModelFetchTransport(deskApi);
    const result = await transport?.fetchProviderModels(request);

    expect(result).toEqual({
      errorMessage:
        "model fetch failed https://api.openai.com/v1/models xApiKey=[redacted] x-goog-api-key=[redacted] xGoogApiKey=[redacted] googleApiKey=[redacted] azureSubscriptionKey=[redacted] clientSecret=[redacted] ocp-apim-subscription-key=[redacted] refreshToken=[redacted] subscriptionKey=[redacted] access-token=[redacted] Cookie: [redacted]; Authorization: Bearer [redacted] Authorization: [redacted]",
      models: [],
      ok: false,
      requestEndpoint: "https://api.openai.com/v1/models?api-version=2026-01-01&signature=[redacted]",
      status: 401
    });
    expect(result?.requestEndpoint).not.toContain("access-token");
    expect(result?.requestEndpoint).not.toContain("authorization=");
    expect(result?.requestEndpoint).not.toContain("azureSubscriptionKey");
    expect(result?.requestEndpoint).not.toContain("bearerToken");
    expect(result?.errorMessage).not.toContain("model-cookie");
    expect(result?.requestEndpoint).not.toContain("clientSecret");
    expect(result?.requestEndpoint).not.toContain("client_secret");
    expect(result?.requestEndpoint).not.toContain("googleApiKey");
    expect(result?.requestEndpoint).not.toContain("key=");
    expect(result?.requestEndpoint).not.toContain("ocp-apim-subscription-key");
    expect(result?.requestEndpoint).not.toContain("refreshToken");
    expect(result?.requestEndpoint).not.toContain("refresh_token");
    expect(result?.requestEndpoint).not.toContain("secretKey");
    expect(result?.requestEndpoint).not.toContain("sessionToken");
    expect(result?.requestEndpoint).not.toContain("subscriptionKey");
    expect(result?.requestEndpoint).not.toContain("xApiKey");
    expect(result?.requestEndpoint).not.toContain("x-goog-api-key");
    expect(result?.requestEndpoint).not.toContain("xGoogApiKey");
    expect(deskApi.models.fetchProviderModels).toHaveBeenCalledWith(request);
  });

  it("sanitizes thrown provider model fetch transport errors before returning them", async () => {
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
      models: {
        fetchProviderModels: vi.fn(async () => {
          throw new Error(
            "model fetch failed Authorization: Bearer sk-form-1234567890abcdef encrypted-key token=gateway-token"
          );
        })
      }
    };
    const request = {
      apiKey: "sk-form-1234567890abcdef",
      authType: "bearer" as const,
      baseUrl: "https://api.openai.com/v1",
      encryptedApiKey: "encrypted-key",
      providerType: "openai" as const,
      timeoutMs: 15_000
    };
    const transport = createDesktopModelFetchTransport(deskApi);

    await expect(transport?.fetchProviderModels(request)).rejects.toThrow(
      "model fetch failed Authorization: Bearer [redacted] [redacted] token=[redacted]"
    );
    expect(deskApi.models.fetchProviderModels).toHaveBeenCalledWith(request);
  });

  it("replaces non-Error thrown provider model fetch transport values with a generic error", async () => {
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
      models: {
        fetchProviderModels: vi.fn(async () => {
          throw "provider threw sk-form-1234567890abcdef encrypted-key token=gateway-token";
        })
      }
    };
    const request = {
      apiKey: "sk-form-1234567890abcdef",
      authType: "bearer" as const,
      baseUrl: "https://api.openai.com/v1",
      encryptedApiKey: "encrypted-key",
      providerType: "openai" as const,
      timeoutMs: 15_000
    };
    const transport = createDesktopModelFetchTransport(deskApi);

    try {
      await transport?.fetchProviderModels(request);
      throw new Error("Expected model fetch to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Model list fetch failed.");
      expect((error as Error).message).not.toContain("sk-form-1234567890abcdef");
    }
    expect(deskApi.models.fetchProviderModels).toHaveBeenCalledWith(request);
  });
});
