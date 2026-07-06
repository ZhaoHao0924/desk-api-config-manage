import { describe, expect, it, vi } from "vitest";
import { createDesktopSecretService } from "./secretService";

describe("secretService", () => {
  it("returns undefined when the preload secret API is unavailable", () => {
    expect(createDesktopSecretService(undefined)).toBeUndefined();
  });

  it("delegates secret operations to the preload API", async () => {
    const deskApi: NonNullable<Window["deskApi"]> = {
      getAppVersion: async () => "0.1.0",
      secrets: {
        isEncryptionAvailable: vi.fn(async () => true),
        encrypt: vi.fn(async () => "encrypted-value"),
        decrypt: vi.fn(async () => "sk-test-secret"),
        copyToClipboard: vi.fn(async () => ({ clearAfterMs: 30_000 }))
      },
      clipboard: {
        writeText: vi.fn(async () => ({ ok: true }))
      },
      connection: {
        testOpenAiCompatible: vi.fn(async () => ({
          ok: true,
          status: 200,
          latencyMs: 1
        }))
      },
      models: {
        fetchProviderModels: vi.fn(async () => ({
          models: [],
          requestEndpoint: "https://api.example.com/v1/models"
        }))
      }
    };

    const service = createDesktopSecretService(deskApi);

    await expect(service?.isEncryptionAvailable()).resolves.toBe(true);
    await expect(service?.encryptSecret("sk-test-secret")).resolves.toBe("encrypted-value");
    await expect(service?.decryptSecret("encrypted-value")).resolves.toBe("sk-test-secret");
    await expect(service?.copySecretToClipboard("sk-test-secret", { clearAfterMs: 30_000 })).resolves.toEqual({
      clearAfterMs: 30_000
    });

    expect(deskApi?.secrets.encrypt).toHaveBeenCalledWith("sk-test-secret");
    expect(deskApi?.secrets.decrypt).toHaveBeenCalledWith("encrypted-value");
    expect(deskApi?.secrets.copyToClipboard).toHaveBeenCalledWith("sk-test-secret", { clearAfterMs: 30_000 });
  });
});
