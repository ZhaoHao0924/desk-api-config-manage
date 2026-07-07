import {
  fallbackRouteProxyDefaultConfig,
  defaultRouteProxyRoutingMode,
  defaultRouteProxyTargetWeight,
  maxRouteProxyTargetWeight,
  minRouteProxyTargetWeight,
  normalizeRouteProxyCooldownMs,
  normalizeRouteProxyFailureThreshold,
  type RouteProxyRoutingMode
} from "./routeProxyTransport";

export interface RouteProxyProfile {
  configId: string;
  cooldownMs: number;
  createdAt: string;
  failoverConfigIds: string[];
  failureThreshold: number;
  id: string;
  listenAddress: string;
  listenPort: number;
  name: string;
  routingMode: RouteProxyRoutingMode;
  targetWeights: Record<string, number>;
  updatedAt: string;
}

export interface RouteProxyProfileSnapshot {
  activeProfileId: string;
  profiles: RouteProxyProfile[];
  schemaVersion: 2;
}

export interface RouteProxyProfileStore {
  deleteProfile(id: string): void;
  getActiveProfileId(): string;
  listProfiles(): RouteProxyProfile[];
  saveProfile(profile: RouteProxyProfile): RouteProxyProfile;
  setActiveProfileId(id: string): void;
}

export interface RouteProxyProfileStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const routeProxyProfileStorageKey = "desk-api-config-manager.route-proxy-profiles.v1";
export const routeProxyProfileSchemaVersion = 2;

const emptyRouteProxyProfileSnapshot: RouteProxyProfileSnapshot = {
  activeProfileId: "",
  profiles: [],
  schemaVersion: routeProxyProfileSchemaVersion
};

function cloneProfile(profile: RouteProxyProfile): RouteProxyProfile {
  return {
    ...profile,
    failoverConfigIds: [...profile.failoverConfigIds],
    targetWeights: { ...profile.targetWeights }
  };
}

function normalizePort(value: unknown): number {
  const port = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? port
    : fallbackRouteProxyDefaultConfig.listenPort;
}

function normalizeRoutingMode(value: unknown): RouteProxyRoutingMode {
  return value === "weighted" || value === "ordered" ? value : defaultRouteProxyRoutingMode;
}

function normalizeTargetWeight(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isFinite(numericValue)) {
    return defaultRouteProxyTargetWeight;
  }

  return Math.min(
    Math.max(Math.trunc(numericValue), minRouteProxyTargetWeight),
    maxRouteProxyTargetWeight
  );
}

function normalizeTargetWeights(value: unknown, targetIds: string[]): Record<string, number> {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const targetWeights: Record<string, number> = {};

  for (const targetId of targetIds) {
    const weight = normalizeTargetWeight(candidate[targetId]);

    if (weight !== defaultRouteProxyTargetWeight) {
      targetWeights[targetId] = weight;
    }
  }

  return targetWeights;
}

function normalizeProfile(value: unknown): RouteProxyProfile | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<RouteProxyProfile>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const configId = typeof candidate.configId === "string" ? candidate.configId.trim() : "";

  if (!id || !configId) {
    return undefined;
  }

  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const listenAddress =
    typeof candidate.listenAddress === "string" && candidate.listenAddress.trim()
      ? candidate.listenAddress.trim()
      : fallbackRouteProxyDefaultConfig.listenAddress;
  const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : "";
  const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : createdAt;
  const failoverConfigIds = Array.isArray(candidate.failoverConfigIds)
    ? [...new Set(candidate.failoverConfigIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))]
        .filter((id) => id !== configId)
    : [];
  const targetIds = [configId, ...failoverConfigIds];

  return {
    configId,
    cooldownMs: normalizeRouteProxyCooldownMs(candidate.cooldownMs),
    createdAt,
    failoverConfigIds,
    failureThreshold: normalizeRouteProxyFailureThreshold(candidate.failureThreshold),
    id,
    listenAddress,
    listenPort: normalizePort(candidate.listenPort),
    name: name || "路由代理方案",
    routingMode: normalizeRoutingMode(candidate.routingMode),
    targetWeights: normalizeTargetWeights(candidate.targetWeights, targetIds),
    updatedAt
  };
}

function normalizeSnapshot(value: unknown): RouteProxyProfileSnapshot {
  if (!value || typeof value !== "object") {
    return { ...emptyRouteProxyProfileSnapshot };
  }

  const candidate = value as Partial<RouteProxyProfileSnapshot>;
  const profiles = Array.isArray(candidate.profiles)
    ? candidate.profiles
        .map((profile) => normalizeProfile(profile))
        .filter((profile): profile is RouteProxyProfile => Boolean(profile))
    : [];
  const activeProfileId =
    typeof candidate.activeProfileId === "string" &&
    profiles.some((profile) => profile.id === candidate.activeProfileId)
      ? candidate.activeProfileId
      : "";

  return {
    activeProfileId,
    profiles,
    schemaVersion: routeProxyProfileSchemaVersion
  };
}

export function createRouteProxyProfileId(now = new Date()): string {
  return `route-proxy-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LocalStorageRouteProxyProfileStore implements RouteProxyProfileStore {
  private readonly key: string;
  private readonly storage: RouteProxyProfileStorageLike;

  constructor(storage?: RouteProxyProfileStorageLike, key = routeProxyProfileStorageKey) {
    if (!storage && typeof window === "undefined") {
      throw new Error("LocalStorageRouteProxyProfileStore requires a storage adapter outside the browser.");
    }

    this.key = key;
    this.storage = storage ?? window.localStorage;
    this.ensureSnapshot();
  }

  listProfiles(): RouteProxyProfile[] {
    return this.read().profiles.map((profile) => cloneProfile(profile));
  }

  getActiveProfileId(): string {
    return this.read().activeProfileId;
  }

  setActiveProfileId(id: string): void {
    const snapshot = this.read();
    snapshot.activeProfileId = snapshot.profiles.some((profile) => profile.id === id) ? id : "";
    this.write(snapshot);
  }

  saveProfile(profile: RouteProxyProfile): RouteProxyProfile {
    const snapshot = this.read();
    const normalizedProfile = normalizeProfile(profile);

    if (!normalizedProfile) {
      throw new Error("Invalid route proxy profile.");
    }

    const existingIndex = snapshot.profiles.findIndex((item) => item.id === normalizedProfile.id);

    if (existingIndex >= 0) {
      snapshot.profiles[existingIndex] = normalizedProfile;
    } else {
      snapshot.profiles = [normalizedProfile, ...snapshot.profiles];
    }

    snapshot.activeProfileId = normalizedProfile.id;
    this.write(snapshot);

    return cloneProfile(normalizedProfile);
  }

  deleteProfile(id: string): void {
    const snapshot = this.read();
    snapshot.profiles = snapshot.profiles.filter((profile) => profile.id !== id);

    if (snapshot.activeProfileId === id) {
      snapshot.activeProfileId = "";
    }

    this.write(snapshot);
  }

  private ensureSnapshot(): void {
    const existingValue = this.storage.getItem(this.key);

    if (!existingValue) {
      this.write({ ...emptyRouteProxyProfileSnapshot });
      return;
    }

    try {
      this.write(normalizeSnapshot(JSON.parse(existingValue)));
    } catch {
      this.write({ ...emptyRouteProxyProfileSnapshot });
    }
  }

  private read(): RouteProxyProfileSnapshot {
    const rawValue = this.storage.getItem(this.key);

    if (!rawValue) {
      return { ...emptyRouteProxyProfileSnapshot };
    }

    return normalizeSnapshot(JSON.parse(rawValue));
  }

  private write(snapshot: RouteProxyProfileSnapshot): void {
    this.storage.setItem(this.key, JSON.stringify(normalizeSnapshot(snapshot)));
  }
}

export function createLocalStorageRouteProxyProfileStore(): RouteProxyProfileStore | undefined {
  if (typeof window === "undefined" || !window.localStorage) {
    return undefined;
  }

  return new LocalStorageRouteProxyProfileStore();
}
