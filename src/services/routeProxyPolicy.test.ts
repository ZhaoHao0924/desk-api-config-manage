import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  defaultRouteProxyCooldownMs,
  defaultRouteProxyFailureThreshold,
  normalizeRouteProxyCooldownMs,
  normalizeRouteProxyFailureThreshold,
  shouldRetryRouteProxyResponse
} = require("../../electron/routeProxyPolicy.cjs") as {
  defaultRouteProxyCooldownMs: number;
  defaultRouteProxyFailureThreshold: number;
  normalizeRouteProxyCooldownMs: (value: number | undefined) => number;
  normalizeRouteProxyFailureThreshold: (value: number | undefined) => number;
  shouldRetryRouteProxyResponse: (statusCode: number) => boolean;
};

describe("routeProxyPolicy", () => {
  it("retries only HTTP 5xx upstream responses", () => {
    expect(shouldRetryRouteProxyResponse(200)).toBe(false);
    expect(shouldRetryRouteProxyResponse(400)).toBe(false);
    expect(shouldRetryRouteProxyResponse(401)).toBe(false);
    expect(shouldRetryRouteProxyResponse(429)).toBe(false);
    expect(shouldRetryRouteProxyResponse(500)).toBe(true);
    expect(shouldRetryRouteProxyResponse(502)).toBe(true);
  });

  it("normalizes default route proxy failover settings", () => {
    expect(normalizeRouteProxyFailureThreshold(undefined)).toBe(defaultRouteProxyFailureThreshold);
    expect(normalizeRouteProxyCooldownMs(undefined)).toBe(defaultRouteProxyCooldownMs);
    expect(normalizeRouteProxyFailureThreshold(3)).toBe(3);
    expect(normalizeRouteProxyCooldownMs(45_000)).toBe(45_000);
  });

  it("rejects out-of-range route proxy failover settings", () => {
    expect(() => normalizeRouteProxyFailureThreshold(0)).toThrow(/between 1 and 10/);
    expect(() => normalizeRouteProxyFailureThreshold(11)).toThrow(/between 1 and 10/);
    expect(() => normalizeRouteProxyCooldownMs(4_999)).toThrow(/between 5000 and 600000/);
    expect(() => normalizeRouteProxyCooldownMs(600_001)).toThrow(/between 5000 and 600000/);
  });
});
