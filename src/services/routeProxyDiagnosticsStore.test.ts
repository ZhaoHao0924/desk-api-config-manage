import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createRouteProxyDiagnosticsStore } = require("../../electron/routeProxyDiagnosticsStore.cjs") as {
  createRouteProxyDiagnosticsStore: (options: { now?: () => Date; userDataPath: string }) => RouteProxyDiagnosticsStore;
};

interface RouteProxyDiagnosticsStore {
  appendEntry(
    input: Record<string, unknown>,
    options?: { secrets?: string[] }
  ): Promise<{
    entry: RouteProxyDiagnosticEntry;
    fileName: string;
    written: boolean;
  }>;
  applyRetention(): Promise<{
    deleteFileNames: string[];
    retentionWarning: string;
  }>;
  clearAll(): Promise<void>;
  disable(): Promise<RouteProxyDiagnosticsManifest>;
  enable(retention?: Partial<RouteProxyDiagnosticsRetention>): Promise<RouteProxyDiagnosticsManifest>;
  getPaths(): {
    diagnosticsDir: string;
    manifestPath: string;
    userDataPath: string;
  };
  open(): Promise<RouteProxyDiagnosticsManifest>;
  readEntries(query?: Record<string, unknown>, options?: { secrets?: string[] }): Promise<RouteProxyDiagnosticEntry[]>;
  readManifest(): Promise<RouteProxyDiagnosticsManifest>;
}

interface RouteProxyDiagnosticsManifest {
  enabled: boolean;
  retention: RouteProxyDiagnosticsRetention;
}

interface RouteProxyDiagnosticsRetention {
  maxAgeDays: number;
  maxEntries: number;
  maxTotalBytes: number;
}

interface RouteProxyDiagnosticEntry {
  errorMessage: string;
  id: string;
  path: string;
  statusCode: number;
}

const fixedNow = new Date("2026-07-05T12:00:00.000Z");
const tempRoots: string[] = [];

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function createTempUserDataPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-route-proxy-diagnostics-"));
  tempRoots.push(root);

  return root;
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const rawValue = await fs.readFile(filePath, "utf8");

  return rawValue
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeEntryFile(filePath: string, entries: Array<Record<string, unknown>>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

describe("routeProxyDiagnosticsStore", () => {
  let userDataPath = "";

  beforeEach(async () => {
    userDataPath = await createTempUserDataPath();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
  });

  it("does not create diagnostics files before explicit opt-in", async () => {
    const store = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = store.getPaths();

    await expect(store.open()).resolves.toMatchObject({
      enabled: false
    });
    await expect(
      store.appendEntry({
        id: "not-written",
        path: "/v1/models?secret=1",
        statusCode: 200
      })
    ).resolves.toMatchObject({
      fileName: "",
      written: false
    });

    expect(paths.diagnosticsDir.startsWith(path.resolve(userDataPath))).toBe(true);
    expect(await pathExists(paths.diagnosticsDir)).toBe(false);
    expect(await pathExists(paths.manifestPath)).toBe(false);
  });

  it("writes only sanitized entries under userData after explicit enable", async () => {
    const store = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = store.getPaths();

    await expect(store.enable()).resolves.toMatchObject({
      enabled: true
    });

    const result = await store.appendEntry(
      {
        apiKey: "secret-token",
        baseUrl: "https://api.example.test/v1",
        body: "prompt",
        encryptedApiKey: "encrypted",
        errorMessage: "Authorization: Bearer sk-test-1234567890abcdef and secret-token",
        headers: {
          authorization: "Bearer secret-token"
        },
        id: "diagnostic-1",
        path: "/v1/models?token=secret-token",
        requestBody: "request",
        responseBody: "response",
        statusCode: 401,
        targetBaseUrl: "https://api.example.test/v1",
        "x-api-key": "secret-token"
      },
      {
        secrets: ["secret-token"]
      }
    );

    expect(result).toMatchObject({
      fileName: "entries-2026-07-05.v1.ndjson",
      written: true
    });

    const entryPath = path.join(paths.diagnosticsDir, result.fileName);
    const rawEntryFile = await fs.readFile(entryPath, "utf8");
    const [entry] = await readJsonLines(entryPath);

    expect(entry).toMatchObject({
      errorMessage: "Authorization: Bearer [redacted] and [redacted]",
      id: "diagnostic-1",
      path: "/v1/models",
      statusCode: 401
    });
    expect(rawEntryFile).not.toContain("secret-token");
    expect(rawEntryFile).not.toContain("sk-test-1234567890abcdef");
    expect(rawEntryFile).not.toContain("api.example.test");
    expect(rawEntryFile).not.toContain("headers");
    expect(rawEntryFile).not.toContain("requestBody");
    expect(rawEntryFile).not.toContain("responseBody");
    expect(await store.readEntries({ limit: 10 }, { secrets: ["secret-token"] })).toMatchObject([
      {
        errorMessage: "Authorization: Bearer [redacted] and [redacted]",
        path: "/v1/models"
      }
    ]);
  });

  it("applies retention to old entry files without deleting the active file", async () => {
    const store = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = store.getPaths();

    await store.enable({
      maxAgeDays: 1,
      maxEntries: 100,
      maxTotalBytes: 1_048_576
    });
    await writeEntryFile(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"), [
      {
        id: "old",
        path: "/v1/old"
      }
    ]);
    await writeEntryFile(path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson"), [
      {
        id: "active",
        path: "/v1/active"
      }
    ]);

    await expect(store.applyRetention()).resolves.toMatchObject({
      deleteFileNames: ["entries-2026-06-01.v1.ndjson"]
    });
    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"))).toBe(false);
    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson"))).toBe(true);
  });

  it("applies retention on startup open when diagnostics were already enabled", async () => {
    const firstStore = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = firstStore.getPaths();

    await firstStore.enable({
      maxAgeDays: 1,
      maxEntries: 100,
      maxTotalBytes: 1_048_576
    });
    await writeEntryFile(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"), [
      {
        id: "old-startup",
        path: "/v1/old"
      }
    ]);
    await writeEntryFile(path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson"), [
      {
        id: "active-startup",
        path: "/v1/active"
      }
    ]);

    const secondStore = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });

    await expect(secondStore.open()).resolves.toMatchObject({
      enabled: true
    });
    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"))).toBe(false);
    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson"))).toBe(true);
  });

  it("applies retention after daily file rollover", async () => {
    let now = new Date("2026-07-04T12:00:00.000Z");
    const store = createRouteProxyDiagnosticsStore({
      now: () => now,
      userDataPath
    });
    const paths = store.getPaths();

    await store.enable({
      maxAgeDays: 2,
      maxEntries: 100,
      maxTotalBytes: 1_048_576
    });
    await store.appendEntry({
      id: "first-day",
      path: "/v1/day-one",
      statusCode: 200
    });
    await writeEntryFile(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"), [
      {
        id: "old-rollover",
        path: "/v1/old"
      }
    ]);

    now = new Date("2026-07-05T12:00:00.000Z");
    await expect(
      store.appendEntry({
        id: "second-day",
        path: "/v1/day-two",
        statusCode: 200
      })
    ).resolves.toMatchObject({
      fileName: "entries-2026-07-05.v1.ndjson",
      written: true
    });

    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"))).toBe(false);
    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-07-04.v1.ndjson"))).toBe(true);
    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson"))).toBe(true);
  });

  it("applies retention after every 100 appended entries", async () => {
    const store = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = store.getPaths();

    await store.enable({
      maxAgeDays: 1,
      maxEntries: 10_000,
      maxTotalBytes: 1_048_576
    });
    await writeEntryFile(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"), [
      {
        id: "old-hundred",
        path: "/v1/old"
      }
    ]);

    for (let index = 0; index < 99; index += 1) {
      await store.appendEntry({
        id: `entry-${index}`,
        path: "/v1/models",
        statusCode: 200
      });
    }

    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"))).toBe(true);

    await store.appendEntry({
      id: "entry-99",
      path: "/v1/models",
      statusCode: 200
    });

    expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-06-01.v1.ndjson"))).toBe(false);
    expect(await readJsonLines(path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson"))).toHaveLength(100);
  }, 15_000);

  it("clearAll removes entry files, preserves enabled manifest, and leaves the userData root intact", async () => {
    const siblingPath = path.join(userDataPath, "unrelated.json");
    const store = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = store.getPaths();
    const entryPath = path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson");

    await fs.writeFile(siblingPath, "{\"ok\":true}\n", "utf8");
    await store.enable();
    await store.appendEntry({
      id: "clear-me",
      path: "/v1/models",
      statusCode: 200
    });

    expect(await pathExists(paths.diagnosticsDir)).toBe(true);
    expect(await pathExists(entryPath)).toBe(true);
    await store.clearAll();

    expect(await pathExists(entryPath)).toBe(false);
    expect(await pathExists(paths.diagnosticsDir)).toBe(true);
    expect(await pathExists(paths.manifestPath)).toBe(true);
    await expect(store.readManifest()).resolves.toMatchObject({
      enabled: true
    });
    await expect(store.readEntries({ limit: 10 })).resolves.toEqual([]);
    expect(await pathExists(userDataPath)).toBe(true);
    expect(await fs.readFile(siblingPath, "utf8")).toBe("{\"ok\":true}\n");

    await expect(store.disable()).resolves.toMatchObject({
      enabled: false
    });
  });

  it("serializes clearAll after an in-flight append so cleared diagnostics do not reappear", async () => {
    const store = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = store.getPaths();
    const entryPath = path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson");
    type MutableAppendFile = (
      filePath: Parameters<typeof fs.appendFile>[0],
      data: Parameters<typeof fs.appendFile>[1],
      options?: Parameters<typeof fs.appendFile>[2]
    ) => ReturnType<typeof fs.appendFile>;
    const mutableFs = fs as unknown as {
      appendFile: MutableAppendFile;
    };
    const originalAppendFile = mutableFs.appendFile;
    let interceptedAppend = false;
    let markAppendStarted: () => void = () => undefined;
    let releaseAppend: () => void = () => undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });

    await store.enable();

    try {
      mutableFs.appendFile = async (filePath, data, options) => {
        if (!interceptedAppend && String(filePath).endsWith("entries-2026-07-05.v1.ndjson")) {
          interceptedAppend = true;
          markAppendStarted();
          await appendRelease;
        }

        return originalAppendFile(filePath, data, options);
      };

      const appendPromise = store.appendEntry(
        {
          errorMessage: "network failed secret-token",
          id: "pending-clear",
          path: "/v1/models?api_key=secret-token",
          statusCode: 502
        },
        {
          secrets: ["secret-token"]
        }
      );

      await appendStarted;
      const clearPromise = store.clearAll();

      releaseAppend();
      await expect(appendPromise).resolves.toMatchObject({
        fileName: "entries-2026-07-05.v1.ndjson",
        written: true
      });
      await expect(clearPromise).resolves.toBeUndefined();

      expect(interceptedAppend).toBe(true);
      expect(await store.readEntries({ limit: 10 }, { secrets: ["secret-token"] })).toEqual([]);
      expect(await pathExists(entryPath)).toBe(false);
      expect(await pathExists(paths.diagnosticsDir)).toBe(true);
      expect(await pathExists(paths.manifestPath)).toBe(true);
      await expect(store.readManifest()).resolves.toMatchObject({
        enabled: true
      });
      expect(await pathExists(userDataPath)).toBe(true);
    } finally {
      releaseAppend();
      mutableFs.appendFile = originalAppendFile;
    }
  });

  it("ignores entry files removed while renderer reads are in flight", async () => {
    const store = createRouteProxyDiagnosticsStore({
      now: () => fixedNow,
      userDataPath
    });
    const paths = store.getPaths();
    type MutableReadFile = (filePath: Parameters<typeof fs.readFile>[0], options?: unknown) => Promise<string | Buffer>;
    const mutableFs = fs as unknown as {
      readFile: MutableReadFile;
    };
    const originalReadFile = mutableFs.readFile;
    let removedEntryFile = false;

    await store.enable();
    await store.appendEntry({
      id: "remove-during-read",
      path: "/v1/models",
      statusCode: 200
    });

    try {
      mutableFs.readFile = async (filePath, options) => {
        const normalizedPath = String(filePath);

        if (!removedEntryFile && normalizedPath.endsWith("entries-2026-07-05.v1.ndjson")) {
          removedEntryFile = true;
          await fs.rm(normalizedPath, { force: true });
          throw Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT"
          });
        }

        return originalReadFile(filePath, options);
      };

      await expect(store.readEntries({ limit: 10 })).resolves.toEqual([]);
      expect(removedEntryFile).toBe(true);
      expect(await pathExists(path.join(paths.diagnosticsDir, "entries-2026-07-05.v1.ndjson"))).toBe(false);
    } finally {
      mutableFs.readFile = originalReadFile;
    }
  });
});
