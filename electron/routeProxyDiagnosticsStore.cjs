const fs = require("node:fs/promises");
const path = require("node:path");
const {
  createRouteProxyDiagnosticsManifest,
  planRouteProxyDiagnosticsRetention,
  readRouteProxyDiagnosticEntries,
  sanitizeRouteProxyDiagnosticEntry
} = require("./routeProxyDiagnostics.cjs");

const routeProxyDiagnosticsDirectoryName = "route-proxy-diagnostics";
const routeProxyDiagnosticsManifestFileName = "manifest.v1.json";
const routeProxyDiagnosticsEntryFilePattern = /^entries-\d{4}-\d{2}-\d{2}\.v1\.ndjson$/;

function resolveUserDataPath(userDataPath) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    throw new Error("userDataPath must be a non-empty string.");
  }

  return path.resolve(userDataPath);
}

function getRouteProxyDiagnosticsPaths(userDataPath) {
  const resolvedUserDataPath = resolveUserDataPath(userDataPath);
  const diagnosticsDir = path.join(resolvedUserDataPath, routeProxyDiagnosticsDirectoryName);

  return {
    diagnosticsDir,
    manifestPath: path.join(diagnosticsDir, routeProxyDiagnosticsManifestFileName),
    userDataPath: resolvedUserDataPath
  };
}

function assertInsideUserData(userDataPath, targetPath) {
  const relativePath = path.relative(userDataPath, targetPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Route proxy diagnostics path must stay inside userData.");
  }
}

function getActiveEntryFileName(now = new Date()) {
  const day = now.toISOString().slice(0, 10);

  return `entries-${day}.v1.ndjson`;
}

function getEntryFilePath(paths, fileName) {
  if (!routeProxyDiagnosticsEntryFilePattern.test(fileName)) {
    throw new Error("Invalid route proxy diagnostics entry file name.");
  }

  const filePath = path.join(paths.diagnosticsDir, fileName);
  assertInsideUserData(paths.userDataPath, filePath);

  return filePath;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  const rawValue = await fs.readFile(filePath, "utf8");

  return JSON.parse(rawValue);
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function countNdjsonEntries(filePath) {
  const rawValue = await fs.readFile(filePath, "utf8");

  return rawValue.split(/\r?\n/).filter((line) => line.trim()).length;
}

async function listEntryFiles(paths) {
  if (!(await pathExists(paths.diagnosticsDir))) {
    return [];
  }

  const names = await fs.readdir(paths.diagnosticsDir);
  const files = [];

  for (const name of names) {
    if (!routeProxyDiagnosticsEntryFilePattern.test(name)) {
      continue;
    }

    const filePath = getEntryFilePath(paths, name);

    try {
      const stats = await fs.stat(filePath);

      files.push({
        bytes: stats.size,
        entryCount: await countNdjsonEntries(filePath),
        name
      });
    } catch {
      // Ignore files removed by an explicit clear while retention is listing.
    }
  }

  return files;
}

async function readEntryFiles(paths) {
  if (!(await pathExists(paths.diagnosticsDir))) {
    return [];
  }

  const names = (await fs.readdir(paths.diagnosticsDir))
    .filter((name) => routeProxyDiagnosticsEntryFilePattern.test(name))
    .sort();
  const entries = [];

  for (const name of names) {
    const filePath = getEntryFilePath(paths, name);
    let rawValue = "";

    try {
      rawValue = await fs.readFile(filePath, "utf8");
    } catch {
      // Ignore files removed by an explicit clear while renderer reads are in flight.
      continue;
    }

    const lines = rawValue.split(/\r?\n/).filter((line) => line.trim());

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Ignore unreadable diagnostic lines instead of exposing file contents.
      }
    }
  }

  return entries;
}

function createRouteProxyDiagnosticsStore(options = {}) {
  const paths = getRouteProxyDiagnosticsPaths(options.userDataPath);
  const nowProvider = typeof options.now === "function" ? options.now : () => new Date();
  let appendedSinceRetention = 0;
  let lastEntryFileName = "";
  let mutationQueue = Promise.resolve();

  function enqueueMutation(operation) {
    const nextOperation = mutationQueue.catch(() => undefined).then(operation);

    mutationQueue = nextOperation.catch(() => undefined);

    return nextOperation;
  }

  async function readManifest() {
    if (!(await pathExists(paths.manifestPath))) {
      return createRouteProxyDiagnosticsManifest(undefined, nowProvider());
    }

    try {
      return createRouteProxyDiagnosticsManifest(await readJsonFile(paths.manifestPath), nowProvider());
    } catch {
      return createRouteProxyDiagnosticsManifest(undefined, nowProvider());
    }
  }

  async function writeManifest(manifest) {
    assertInsideUserData(paths.userDataPath, paths.manifestPath);
    await writeJsonFile(paths.manifestPath, manifest);
  }

  async function applyRetentionUnlocked(options = {}) {
    const manifest = await readManifest();
    const activeFileName =
      typeof options.activeFileName === "string" ? options.activeFileName : getActiveEntryFileName(nowProvider());
    const plan = planRouteProxyDiagnosticsRetention(await listEntryFiles(paths), manifest.retention, {
      activeFileName,
      now: nowProvider()
    });

    for (const fileName of plan.deleteFileNames) {
      await fs.rm(getEntryFilePath(paths, fileName), { force: true });
    }

    appendedSinceRetention = 0;

    return plan;
  }

  async function applyRetention(options = {}) {
    return enqueueMutation(() => applyRetentionUnlocked(options));
  }

  async function openUnlocked() {
    const manifest = await readManifest();

    if (manifest.enabled) {
      await applyRetentionUnlocked();
    }

    return manifest;
  }

  async function open() {
    return enqueueMutation(() => openUnlocked());
  }

  async function enableUnlocked(retention) {
    const currentManifest = await readManifest();
    const now = nowProvider();
    const manifest = createRouteProxyDiagnosticsManifest(
      {
        createdAt: currentManifest.createdAt,
        enabled: true,
        retention: retention ?? currentManifest.retention,
        updatedAt: now
      },
      now
    );

    await writeManifest(manifest);
    await applyRetentionUnlocked();

    return manifest;
  }

  async function enable(retention) {
    return enqueueMutation(() => enableUnlocked(retention));
  }

  async function disableUnlocked() {
    if (!(await pathExists(paths.manifestPath))) {
      return createRouteProxyDiagnosticsManifest(undefined, nowProvider());
    }

    const currentManifest = await readManifest();
    const manifest = createRouteProxyDiagnosticsManifest(
      {
        ...currentManifest,
        enabled: false,
        updatedAt: nowProvider()
      },
      nowProvider()
    );

    await writeManifest(manifest);

    return manifest;
  }

  async function disable() {
    return enqueueMutation(() => disableUnlocked());
  }

  async function appendEntryUnlocked(input, options = {}) {
    const manifest = await readManifest();
    const entry = sanitizeRouteProxyDiagnosticEntry(input, {
      now: nowProvider(),
      secrets: Array.isArray(options.secrets) ? options.secrets : []
    });

    if (!manifest.enabled) {
      return {
        entry,
        fileName: "",
        written: false
      };
    }

    const fileName = getActiveEntryFileName(nowProvider());
    const filePath = getEntryFilePath(paths, fileName);

    await fs.mkdir(paths.diagnosticsDir, { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");

    appendedSinceRetention += 1;

    if (lastEntryFileName && lastEntryFileName !== fileName) {
      await applyRetentionUnlocked({ activeFileName: fileName });
    } else if (appendedSinceRetention >= 100) {
      await applyRetentionUnlocked({ activeFileName: fileName });
    }

    lastEntryFileName = fileName;

    return {
      entry,
      fileName,
      written: true
    };
  }

  async function appendEntry(input, options = {}) {
    return enqueueMutation(() => appendEntryUnlocked(input, options));
  }

  async function readEntries(query = {}, options = {}) {
    return readRouteProxyDiagnosticEntries(await readEntryFiles(paths), query, {
      now: nowProvider(),
      secrets: Array.isArray(options.secrets) ? options.secrets : []
    });
  }

  async function clearAllUnlocked() {
    const manifest = await readManifest();

    await fs.rm(paths.diagnosticsDir, { force: true, recursive: true });
    appendedSinceRetention = 0;
    lastEntryFileName = "";

    if (manifest.enabled) {
      const now = nowProvider();

      await writeManifest(
        createRouteProxyDiagnosticsManifest(
          {
            ...manifest,
            updatedAt: now
          },
          now
        )
      );
    }
  }

  async function clearAll() {
    return enqueueMutation(() => clearAllUnlocked());
  }

  return {
    appendEntry,
    applyRetention,
    clearAll,
    disable,
    enable,
    getPaths: () => ({ ...paths }),
    open,
    readEntries,
    readManifest
  };
}

module.exports = {
  createRouteProxyDiagnosticsStore,
  getRouteProxyDiagnosticsPaths,
  routeProxyDiagnosticsDirectoryName,
  routeProxyDiagnosticsEntryFilePattern,
  routeProxyDiagnosticsManifestFileName
};
