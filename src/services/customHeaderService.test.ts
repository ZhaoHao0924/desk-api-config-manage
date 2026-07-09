import { describe, expect, it, vi } from "vitest";
import type { CustomHeader } from "../types";
import {
  CustomHeaderService,
  isProtectedHeaderKey,
  maskHeaderValue,
  normalizeHeaderKey,
  validateHeaderKey,
  validateHeaderValue
} from "./customHeaderService";

function makeRepo(initial: CustomHeader[] = []) {
  const store = [...initial];

  return {
    listCustomHeaders: vi.fn(async (configId: string) => store.filter((h) => h.configId === configId)),
    saveCustomHeader: vi.fn(async (h: CustomHeader) => {
      const idx = store.findIndex((x) => x.id === h.id);

      if (idx === -1) {
        store.push(h);
      } else {
        store[idx] = h;
      }

      return h;
    }),
    deleteCustomHeader: vi.fn(async (id: string) => {
      const idx = store.findIndex((x) => x.id === id);

      if (idx !== -1) {
        store.splice(idx, 1);
      }
    }),
    deleteCustomHeadersByConfigId: vi.fn(async (configId: string) => {
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].configId === configId) {
          store.splice(i, 1);
        }
      }
    })
  };
}

const noEncrypt = vi.fn(async (_: string) => undefined as string | undefined);
const fakeEncrypt = vi.fn(async (v: string) => `enc:${v}`);
const fakeDecrypt = vi.fn(async (v: string) => (v.startsWith("enc:") ? v.slice(4) : undefined));

describe("normalizeHeaderKey", () => {
  it("trims and lowercases", () => {
    expect(normalizeHeaderKey("  X-Custom-Header  ")).toBe("x-custom-header");
  });
});

describe("maskHeaderValue", () => {
  it("masks short values", () => {
    expect(maskHeaderValue("short")).toBe("****");
  });

  it("masks long values keeping prefix and suffix", () => {
    const masked = maskHeaderValue("sk-abcdefgh1234");
    expect(masked).toMatch(/^sk-a\*{4}/);
    expect(masked).toContain("1234");
  });
});

describe("validateHeaderKey", () => {
  it("rejects empty", () => {
    expect(validateHeaderKey("")).toBeTruthy();
    expect(validateHeaderKey("   ")).toBeTruthy();
  });

  it("rejects spaces in name", () => {
    expect(validateHeaderKey("my header")).toBeTruthy();
  });

  it("accepts valid token characters", () => {
    expect(validateHeaderKey("x-my-header")).toBeUndefined();
    expect(validateHeaderKey("X-Api-Token")).toBeUndefined();
  });
});

describe("validateHeaderValue", () => {
  it("rejects empty", () => {
    expect(validateHeaderValue("")).toBeTruthy();
    expect(validateHeaderValue("  ")).toBeTruthy();
  });

  it("accepts non-empty value", () => {
    expect(validateHeaderValue("any-value")).toBeUndefined();
  });
});

describe("isProtectedHeaderKey", () => {
  it("blocks authorization", () => {
    expect(isProtectedHeaderKey("Authorization")).toBe(true);
    expect(isProtectedHeaderKey("authorization")).toBe(true);
  });

  it("blocks x-api-key", () => {
    expect(isProtectedHeaderKey("x-api-key")).toBe(true);
  });

  it("allows custom keys", () => {
    expect(isProtectedHeaderKey("x-custom-trace-id")).toBe(false);
  });
});

describe("CustomHeaderService.addHeader", () => {
  it("adds a non-secret header", async () => {
    const repo = makeRepo();
    const svc = new CustomHeaderService(repo);
    const result = await svc.addHeader("cfg1", { key: "x-trace", value: "123", isSecret: false }, fakeEncrypt);
    expect(result.error).toBeUndefined();
    expect(result.header?.key).toBe("x-trace");
    expect(result.header?.value).toBe("123");
    expect(result.header?.isSecret).toBe(false);
    expect(result.header?.valuePreview).toBe("");
  });

  it("adds a secret header with encryption and preview", async () => {
    const repo = makeRepo();
    const svc = new CustomHeaderService(repo);
    const result = await svc.addHeader("cfg1", { key: "x-secret", value: "sk-abcdefgh1234", isSecret: true }, fakeEncrypt);
    expect(result.error).toBeUndefined();
    expect(result.header?.value).toBe("enc:sk-abcdefgh1234");
    expect(result.header?.valuePreview).not.toBe("");
    expect(result.header?.isSecret).toBe(true);
  });

  it("returns error when encrypt fails for secret header", async () => {
    const repo = makeRepo();
    const svc = new CustomHeaderService(repo);
    const result = await svc.addHeader("cfg1", { key: "x-secret", value: "val", isSecret: true }, noEncrypt);
    expect(result.error).toBeTruthy();
  });

  it("rejects duplicate key", async () => {
    const repo = makeRepo();
    const svc = new CustomHeaderService(repo);
    await svc.addHeader("cfg1", { key: "x-dup", value: "1", isSecret: false }, fakeEncrypt);
    const second = await svc.addHeader("cfg1", { key: "X-Dup", value: "2", isSecret: false }, fakeEncrypt);
    expect(second.error).toBeTruthy();
  });

  it("rejects protected header key", async () => {
    const repo = makeRepo();
    const svc = new CustomHeaderService(repo);
    const result = await svc.addHeader("cfg1", { key: "authorization", value: "Bearer tok", isSecret: false }, fakeEncrypt);
    expect(result.error).toBeTruthy();
  });

  it("rejects invalid key", async () => {
    const repo = makeRepo();
    const svc = new CustomHeaderService(repo);
    const result = await svc.addHeader("cfg1", { key: "bad key!", value: "val", isSecret: false }, fakeEncrypt);
    expect(result.error).toBeTruthy();
  });
});

describe("CustomHeaderService.resolvePublicHeaders", () => {
  it("returns only non-secret headers as key-value", async () => {
    const existing: CustomHeader[] = [
      {
        id: "h1",
        configId: "cfg1",
        key: "x-trace",
        value: "123",
        isSecret: false,
        valuePreview: "",
        createdAt: "",
        updatedAt: ""
      },
      {
        id: "h2",
        configId: "cfg1",
        key: "x-secret",
        value: "enc:abc",
        isSecret: true,
        valuePreview: "****",
        createdAt: "",
        updatedAt: ""
      }
    ];
    const repo = makeRepo(existing);
    const svc = new CustomHeaderService(repo);
    const headers = await svc.resolvePublicHeaders("cfg1");
    expect(headers).toEqual({ "x-trace": "123" });
  });
});

describe("CustomHeaderService.resolveAllHeaders", () => {
  it("decrypts secret headers and includes public headers", async () => {
    const existing: CustomHeader[] = [
      {
        id: "h1",
        configId: "cfg1",
        key: "x-public",
        value: "pub",
        isSecret: false,
        valuePreview: "",
        createdAt: "",
        updatedAt: ""
      },
      {
        id: "h2",
        configId: "cfg1",
        key: "x-private",
        value: "enc:secret123",
        isSecret: true,
        valuePreview: "secr****3",
        createdAt: "",
        updatedAt: ""
      }
    ];
    const repo = makeRepo(existing);
    const svc = new CustomHeaderService(repo);
    const headers = await svc.resolveAllHeaders("cfg1", fakeDecrypt);
    expect(headers["x-public"]).toBe("pub");
    expect(headers["x-private"]).toBe("secret123");
  });

  it("skips secret header when decryption returns undefined", async () => {
    const existing: CustomHeader[] = [
      {
        id: "h1",
        configId: "cfg1",
        key: "x-private",
        value: "corrupted",
        isSecret: true,
        valuePreview: "****",
        createdAt: "",
        updatedAt: ""
      }
    ];
    const repo = makeRepo(existing);
    const svc = new CustomHeaderService(repo);
    const headers = await svc.resolveAllHeaders("cfg1", async () => undefined);
    expect(Object.keys(headers)).toHaveLength(0);
  });
});
