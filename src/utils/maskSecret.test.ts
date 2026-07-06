import { describe, expect, it } from "vitest";
import { maskSecret } from "./maskSecret";

describe("maskSecret", () => {
  it("keeps empty values empty", () => {
    expect(maskSecret("")).toBe("");
  });

  it("fully masks short secrets", () => {
    expect(maskSecret("abc123")).toBe("****");
  });

  it("shows only a short prefix and suffix for long secrets", () => {
    expect(maskSecret("sk-proj-1234567890abcdef")).toBe("sk-proj...cdef");
  });

  it("trims surrounding whitespace before masking", () => {
    expect(maskSecret("  sk-test-abcdef123456  ")).toBe("sk-test...3456");
  });
});

