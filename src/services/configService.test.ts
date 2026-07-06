import { describe, expect, it } from "vitest";
import type { ApiConfigRepository } from "../domain/repositories";
import { openAiCompatibleProviderId } from "../types";
import type { ApiConfig } from "../types";
import { createApiConfig, deleteApiConfig, normalizeTags, updateApiConfig } from "./configService";
import type { SecretCopyOptions, SecretCopyResult, SecretService } from "./secretService";

class MemoryConfigRepository implements ApiConfigRepository {
  private configs: ApiConfig[];

  constructor(configs: ApiConfig[] = []) {
    this.configs = configs.map((config) => ({ ...config, tags: [...config.tags] }));
  }

  async listConfigs(): Promise<ApiConfig[]> {
    return this.configs.map((config) => ({ ...config, tags: [...config.tags] }));
  }

  async getConfig(id: string): Promise<ApiConfig | undefined> {
    const config = this.configs.find((item) => item.id === id);
    return config ? { ...config, tags: [...config.tags] } : undefined;
  }

  async saveConfig(config: ApiConfig): Promise<ApiConfig> {
    this.configs = [{ ...config, tags: [...config.tags] }, ...this.configs];
    return { ...config, tags: [...config.tags] };
  }

  async replaceConfig(config: ApiConfig): Promise<ApiConfig> {
    this.configs = this.configs.map((item) => (item.id === config.id ? { ...config, tags: [...config.tags] } : item));
    return { ...config, tags: [...config.tags] };
  }

  async deleteConfig(id: string): Promise<void> {
    this.configs = this.configs.filter((config) => config.id !== id);
  }
}

class FakeSecretService implements SecretService {
  async isEncryptionAvailable(): Promise<boolean> {
    return true;
  }

  async encryptSecret(plaintext: string): Promise<string> {
    return `encrypted:${[...plaintext].reverse().join("")}`;
  }

  async decryptSecret(encryptedValue: string): Promise<string> {
    return [...encryptedValue.replace(/^encrypted:/, "")].reverse().join("");
  }

  async copySecretToClipboard(_plaintext: string, options?: SecretCopyOptions): Promise<SecretCopyResult> {
    return {
      clearAfterMs: options?.clearAfterMs ?? 30_000
    };
  }
}

const existingConfig: ApiConfig = {
  id: "cfg-existing",
  name: "Existing",
  providerId: openAiCompatibleProviderId,
  baseUrl: "https://api.openai.com/v1",
  encryptedApiKey: "encrypted:terces-dlo-ks",
  apiKeyPreview: "sk-old...1234",
  hasApiKey: true,
  defaultModel: "gpt-4.1-mini",
  endpointMode: "auto",
  environment: "development",
  tags: ["dev"],
  notes: "",
  isEnabled: true,
  lastTestStatus: "success",
  lastTestAt: "2026-07-01 10:00",
  latencyMs: 100,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z"
};

describe("configService", () => {
  const secretService = new FakeSecretService();

  it("normalizes tag input", () => {
    expect(normalizeTags([" dev ", "", "Dev", "prod"])).toEqual(["dev", "prod"]);
  });

  it("creates configs with encrypted API keys and masked previews", async () => {
    const repository = new MemoryConfigRepository();
    const rawApiKey = "sk-proj-1234567890abcdef";

    const config = await createApiConfig(
      repository,
      {
        name: " OpenAI Dev ",
        providerId: "openai",
        baseUrl: " https://api.openai.com/v1 ",
        apiKey: rawApiKey,
        defaultModel: " gpt-4.1-mini ",
        environment: "development",
        tags: ["dev", " dev "],
        notes: " note ",
        isEnabled: true
      },
      {
        createId: () => "cfg-new",
        now: () => "2026-07-01T01:00:00.000Z",
        secretService
      }
    );

    expect(config).toMatchObject({
      id: "cfg-new",
      name: "OpenAI Dev",
      apiKeyPreview: "sk-proj...cdef",
      endpointMode: "auto",
      hasApiKey: true,
      lastTestStatus: "untested",
      providerId: openAiCompatibleProviderId,
      tags: ["dev"]
    });
    expect(config.encryptedApiKey).toBe("encrypted:fedcba0987654321-jorp-ks");
    expect(JSON.stringify(config)).not.toContain(rawApiKey);
  });

  it("rejects API key persistence when no secret service is available", async () => {
    const repository = new MemoryConfigRepository();

    await expect(
      createApiConfig(repository, {
        name: "OpenAI Dev",
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-proj-1234567890abcdef",
        defaultModel: "gpt-4.1-mini",
        environment: "development",
        tags: [],
        notes: "",
        isEnabled: true
      })
    ).rejects.toThrow("安全存储");
  });

  it("updates configs while keeping an existing key preview by default", async () => {
    const repository = new MemoryConfigRepository([existingConfig]);

    const config = await updateApiConfig(
      repository,
      "cfg-existing",
      {
        name: "Existing Renamed",
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
        environment: "testing",
        tags: ["renamed"],
        notes: "Updated",
        isEnabled: false
      },
      {
        now: () => "2026-07-01T02:00:00.000Z"
      }
    );

    expect(config.apiKeyPreview).toBe("sk-old...1234");
    expect(config.encryptedApiKey).toBe(existingConfig.encryptedApiKey);
    expect(config.lastTestStatus).toBe("success");
    expect(config.lastTestAt).toBe("2026-07-01 10:00");
  });

  it("resets test status when model or key changes", async () => {
    const repository = new MemoryConfigRepository([existingConfig]);

    const config = await updateApiConfig(
      repository,
      "cfg-existing",
      {
        name: "Existing",
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-new-1234567890abcdef",
        defaultModel: "gpt-4.1",
        environment: "development",
        tags: ["dev"],
        notes: "",
        isEnabled: true
      },
      {
        replaceApiKey: true,
        now: () => "2026-07-01T03:00:00.000Z",
        secretService
      }
    );

    expect(config.apiKeyPreview).toBe("sk-new-...cdef");
    expect(config.encryptedApiKey).toBe("encrypted:fedcba0987654321-wen-ks");
    expect(config.lastTestStatus).toBe("untested");
    expect(config.lastTestAt).toBeUndefined();
    expect(config.latencyMs).toBeUndefined();
  });

  it("resets test status when endpoint mode changes", async () => {
    const repository = new MemoryConfigRepository([existingConfig]);

    const config = await updateApiConfig(
      repository,
      "cfg-existing",
      {
        name: "Existing",
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
        endpointMode: "responses",
        environment: "development",
        tags: ["dev"],
        notes: "",
        isEnabled: true
      },
      {
        now: () => "2026-07-01T03:30:00.000Z"
      }
    );

    expect(config.endpointMode).toBe("responses");
    expect(config.lastTestStatus).toBe("untested");
    expect(config.lastTestAt).toBeUndefined();
    expect(config.latencyMs).toBeUndefined();
  });

  it("deletes configs", async () => {
    const repository = new MemoryConfigRepository([existingConfig]);

    await deleteApiConfig(repository, "cfg-existing");

    await expect(repository.listConfigs()).resolves.toHaveLength(0);
  });
});
