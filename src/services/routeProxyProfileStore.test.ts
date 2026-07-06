import { describe, expect, it } from "vitest";
import {
  LocalStorageRouteProxyProfileStore,
  routeProxyProfileStorageKey,
  type RouteProxyProfileStorageLike
} from "./routeProxyProfileStore";

class MemoryStorage implements RouteProxyProfileStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const profile = {
  configId: "cfg-openai",
  cooldownMs: 30_000,
  createdAt: "2026-07-05T00:00:00.000Z",
  failoverConfigIds: ["cfg-backup"],
  failureThreshold: 1,
  id: "proxy-profile-1",
  listenAddress: "127.0.0.1",
  listenPort: 15_721,
  name: "OpenAI local proxy",
  routingMode: "weighted" as const,
  targetWeights: {
    "cfg-backup": 3,
    "cfg-openai": 2
  },
  updatedAt: "2026-07-05T00:00:00.000Z"
};

describe("routeProxyProfileStore", () => {
  it("starts with an empty profile snapshot", () => {
    const storage = new MemoryStorage();
    const store = new LocalStorageRouteProxyProfileStore(storage);

    expect(store.listProfiles()).toEqual([]);
    expect(store.getActiveProfileId()).toBe("");
    expect(JSON.parse(storage.getItem(routeProxyProfileStorageKey) ?? "{}")).toEqual({
      activeProfileId: "",
      profiles: [],
      schemaVersion: 2
    });
  });

  it("saves and updates a route proxy profile", () => {
    const store = new LocalStorageRouteProxyProfileStore(new MemoryStorage());

    expect(store.saveProfile(profile)).toEqual(profile);
    expect(store.getActiveProfileId()).toBe(profile.id);
    expect(store.listProfiles()).toEqual([profile]);

    const updatedProfile = {
      ...profile,
      listenPort: 16_000,
      name: "Updated proxy",
      updatedAt: "2026-07-05T00:05:00.000Z"
    };

    expect(store.saveProfile(updatedProfile)).toEqual(updatedProfile);
    expect(store.listProfiles()).toEqual([updatedProfile]);
  });

  it("normalizes invalid persisted snapshots", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      routeProxyProfileStorageKey,
      JSON.stringify({
        activeProfileId: "invalid-profile",
        profiles: [
          {
            configId: "cfg-openai",
            id: "proxy-profile-1",
            listenAddress: "",
            listenPort: 999_999,
            name: "",
            createdAt: "2026-07-05T00:00:00.000Z"
          },
          {
            id: "missing-config-id",
            listenPort: 15_721
          }
        ],
        schemaVersion: 1
      })
    );

    const store = new LocalStorageRouteProxyProfileStore(storage);

    expect(store.getActiveProfileId()).toBe("");
    expect(store.listProfiles()).toEqual([
      {
        configId: "cfg-openai",
        cooldownMs: 30_000,
        createdAt: "2026-07-05T00:00:00.000Z",
        failoverConfigIds: [],
        failureThreshold: 1,
        id: "proxy-profile-1",
        listenAddress: "127.0.0.1",
        listenPort: 15_721,
        name: "路由代理方案",
        routingMode: "ordered",
        targetWeights: {},
        updatedAt: "2026-07-05T00:00:00.000Z"
      }
    ]);
  });

  it("normalizes target weights to known profile targets only", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      routeProxyProfileStorageKey,
      JSON.stringify({
        activeProfileId: "proxy-profile-1",
        profiles: [
          {
            configId: "cfg-openai",
            failoverConfigIds: ["cfg-backup"],
            id: "proxy-profile-1",
            listenAddress: "127.0.0.1",
            listenPort: 15_721,
            name: "Weighted proxy",
            routingMode: "weighted",
            targetWeights: {
              "cfg-backup": 99,
              "cfg-openai": "3",
              "cfg-unknown": 5
            }
          }
        ],
        schemaVersion: 2
      })
    );

    const store = new LocalStorageRouteProxyProfileStore(storage);

    expect(store.listProfiles()[0]).toMatchObject({
      routingMode: "weighted",
      targetWeights: {
        "cfg-backup": 10,
        "cfg-openai": 3
      }
    });
  });

  it("deletes profiles and clears the active profile", () => {
    const store = new LocalStorageRouteProxyProfileStore(new MemoryStorage());
    store.saveProfile(profile);

    store.deleteProfile(profile.id);

    expect(store.listProfiles()).toEqual([]);
    expect(store.getActiveProfileId()).toBe("");
  });
});
