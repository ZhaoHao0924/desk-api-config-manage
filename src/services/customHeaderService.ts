import type { CustomHeaderRepository } from "../domain/repositories";
import type { CustomHeader } from "../types";

// Header name validation: token chars per RFC 7230, no leading/trailing whitespace.
const HEADER_KEY_PATTERN = /^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/;
const MAX_HEADER_KEY_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADERS_PER_CONFIG = 32;

export interface CustomHeaderInput {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface CustomHeaderServiceResult {
  header?: CustomHeader;
  error?: string;
}

export function normalizeHeaderKey(raw: string): string {
  return raw.trim().toLowerCase();
}

export function maskHeaderValue(value: string): string {
  if (value.length <= 8) {
    return "****";
  }

  return value.slice(0, 4) + "****" + value.slice(-4);
}

export function validateHeaderKey(key: string): string | undefined {
  const normalized = normalizeHeaderKey(key);

  if (!normalized) {
    return "Header 名称不能为空";
  }

  if (normalized.length > MAX_HEADER_KEY_LENGTH) {
    return `Header 名称不能超过 ${MAX_HEADER_KEY_LENGTH} 个字符`;
  }

  if (!HEADER_KEY_PATTERN.test(normalized)) {
    return "Header 名称只能包含字母、数字和 !#$%&'*+-.^_`|~ 字符";
  }

  return undefined;
}

export function validateHeaderValue(value: string): string | undefined {
  if (!value.trim()) {
    return "Header 值不能为空";
  }

  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    return `Header 值不能超过 ${MAX_HEADER_VALUE_LENGTH} 个字符`;
  }

  return undefined;
}

// Protected header names that must not be overridden by custom headers.
const PROTECTED_HEADER_KEYS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-version",
  "content-type",
  "content-length",
  "transfer-encoding",
  "host",
  "connection",
  "x-goog-api-key",
  "api-key",
  "ocp-apim-subscription-key"
]);

export function isProtectedHeaderKey(key: string): boolean {
  return PROTECTED_HEADER_KEYS.has(normalizeHeaderKey(key));
}

export class CustomHeaderService {
  constructor(private readonly repo: CustomHeaderRepository) {}

  async listHeaders(configId: string): Promise<CustomHeader[]> {
    return this.repo.listCustomHeaders(configId);
  }

  async addHeader(
    configId: string,
    input: CustomHeaderInput,
    encryptValue: (plaintext: string) => Promise<string | undefined>
  ): Promise<CustomHeaderServiceResult> {
    const keyError = validateHeaderKey(input.key);

    if (keyError) {
      return { error: keyError };
    }

    const valueError = validateHeaderValue(input.value);

    if (valueError) {
      return { error: valueError };
    }

    const normalizedKey = normalizeHeaderKey(input.key);

    if (isProtectedHeaderKey(normalizedKey)) {
      return { error: `"${normalizedKey}" 是受保护的 Header，不允许覆盖` };
    }

    const existing = await this.repo.listCustomHeaders(configId);

    if (existing.length >= MAX_HEADERS_PER_CONFIG) {
      return { error: `每个配置最多允许 ${MAX_HEADERS_PER_CONFIG} 个自定义 Header` };
    }

    if (existing.some((h) => normalizeHeaderKey(h.key) === normalizedKey)) {
      return { error: `Header "${normalizedKey}" 已存在` };
    }

    let storedValue = input.value;
    let valuePreview = "";

    if (input.isSecret) {
      const encrypted = await encryptValue(input.value);

      if (!encrypted) {
        return { error: "无法加密 Header 值，请检查 Electron 安全存储是否可用" };
      }

      storedValue = encrypted;
      valuePreview = maskHeaderValue(input.value);
    }

    const now = new Date().toISOString();
    const header: CustomHeader = {
      id: crypto.randomUUID(),
      configId,
      key: normalizedKey,
      value: storedValue,
      isSecret: input.isSecret,
      valuePreview,
      createdAt: now,
      updatedAt: now
    };

    const saved = await this.repo.saveCustomHeader(header);
    return { header: saved };
  }

  async updateHeader(
    id: string,
    configId: string,
    input: CustomHeaderInput,
    encryptValue: (plaintext: string) => Promise<string | undefined>
  ): Promise<CustomHeaderServiceResult> {
    const keyError = validateHeaderKey(input.key);

    if (keyError) {
      return { error: keyError };
    }

    const valueError = validateHeaderValue(input.value);

    if (valueError) {
      return { error: valueError };
    }

    const normalizedKey = normalizeHeaderKey(input.key);

    if (isProtectedHeaderKey(normalizedKey)) {
      return { error: `"${normalizedKey}" 是受保护的 Header，不允许覆盖` };
    }

    const existing = await this.repo.listCustomHeaders(configId);
    const current = existing.find((h) => h.id === id);

    if (!current) {
      return { error: "Header 不存在" };
    }

    if (existing.some((h) => h.id !== id && normalizeHeaderKey(h.key) === normalizedKey)) {
      return { error: `Header "${normalizedKey}" 已存在` };
    }

    let storedValue = input.value;
    let valuePreview = "";

    if (input.isSecret) {
      const encrypted = await encryptValue(input.value);

      if (!encrypted) {
        return { error: "无法加密 Header 值" };
      }

      storedValue = encrypted;
      valuePreview = maskHeaderValue(input.value);
    }

    const updated: CustomHeader = {
      ...current,
      key: normalizedKey,
      value: storedValue,
      isSecret: input.isSecret,
      valuePreview,
      updatedAt: new Date().toISOString()
    };

    const saved = await this.repo.saveCustomHeader(updated);
    return { header: saved };
  }

  async deleteHeader(id: string): Promise<void> {
    return this.repo.deleteCustomHeader(id);
  }

  /** Returns only non-secret headers as key-value pairs for injection into requests. */
  async resolvePublicHeaders(configId: string): Promise<Record<string, string>> {
    const headers = await this.repo.listCustomHeaders(configId);
    const result: Record<string, string> = {};

    for (const h of headers) {
      if (!h.isSecret) {
        result[h.key] = h.value;
      }
    }

    return result;
  }

  /**
   * Returns all headers (public plaintext + decrypted secrets) for injection into
   * main-process requests. Must never be called from the renderer.
   */
  async resolveAllHeaders(
    configId: string,
    decryptValue: (ciphertext: string) => Promise<string | undefined>
  ): Promise<Record<string, string>> {
    const headers = await this.repo.listCustomHeaders(configId);
    const result: Record<string, string> = {};

    for (const h of headers) {
      if (!h.isSecret) {
        result[h.key] = h.value;
        continue;
      }

      const plaintext = await decryptValue(h.value);

      if (plaintext) {
        result[h.key] = plaintext;
      }
    }

    return result;
  }
}
