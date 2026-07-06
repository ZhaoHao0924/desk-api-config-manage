import { describe, expect, it } from "vitest";
import type { RouteProxyDiagnosticEntry } from "../../services/routeProxyTransport";
import { summarizeRouteProxyHealthHistory } from "./RouteProxyModule";

function createDiagnosticEntry(overrides: Partial<RouteProxyDiagnosticEntry>): RouteProxyDiagnosticEntry {
  return {
    attempt: 1,
    completedAt: "2026-07-05T10:00:00.000Z",
    errorCode: "",
    errorMessage: "",
    eventType: "target-health",
    id: "diagnostic-1",
    latencyMs: 0,
    method: "HEALTH",
    ok: true,
    path: "/_route-proxy/target-health",
    profileId: "profile-1",
    result: "target-health-change",
    schemaVersion: 1,
    startedAt: "2026-07-05T09:59:59.000Z",
    statusCode: 0,
    targetConfigId: "cfg-1",
    targetHealthState: "available",
    targetOrdinal: 0,
    ...overrides
  };
}

describe("route proxy health history summary", () => {
  it("summarizes only target-health diagnostic entries", () => {
    const summary = summarizeRouteProxyHealthHistory([
      createDiagnosticEntry({
        completedAt: "2026-07-05T10:00:00.000Z",
        id: "cooldown",
        ok: false,
        targetHealthState: "cooling-down"
      }),
      createDiagnosticEntry({
        completedAt: "2026-07-05T11:00:00.000Z",
        id: "request",
        eventType: "request",
        method: "GET",
        ok: true,
        path: "/v1/models",
        result: "success",
        statusCode: 200,
        targetHealthState: "available"
      }),
      createDiagnosticEntry({
        completedAt: "2026-07-05T12:00:00.000Z",
        id: "recovery",
        targetHealthState: "available"
      })
    ]);

    expect(summary).toEqual({
      cooldownCount: 1,
      latestAt: "2026-07-05T12:00:00.000Z",
      recoveryCount: 1,
      total: 2
    });
  });
});
