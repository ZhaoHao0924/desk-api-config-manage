const routeProxyDiagnosticsSchemaVersion = 1;
const defaultRouteProxyDiagnosticsRetention = {
  maxAgeDays: 7,
  maxEntries: 10_000,
  maxTotalBytes: 10_485_760
};
const routeProxyDiagnosticsRetentionLimits = {
  maxAgeDays: {
    max: 30,
    min: 1
  },
  maxEntries: {
    max: 100_000,
    min: 100
  },
  maxTotalBytes: {
    max: 104_857_600,
    min: 1_048_576
  }
};
const maxRouteProxyDiagnosticPathLength = 512;
const maxRouteProxyDiagnosticErrorLength = 240;
const maxRouteProxyDiagnosticReadLimit = 500;
const routeProxyDiagnosticResultValues = new Set([
  "success",
  "upstream-http-error",
  "network-error",
  "proxy-error",
  "client-error",
  "target-health-change"
]);
const routeProxyDiagnosticEventTypeValues = new Set(["request", "target-health"]);
const routeProxyTargetHealthStateValues = new Set(["available", "cooling-down"]);
const forbiddenRouteProxyDiagnosticFields = [
  "apiKey",
  "encryptedApiKey",
  "apiKeyPreview",
  "authorization",
  "Authorization",
  "headers",
  "requestHeaders",
  "responseHeaders",
  "body",
  "requestBody",
  "responseBody",
  "query",
  "search",
  "url",
  "baseUrl",
  "targetBaseUrl",
  "cookie",
  "set-cookie",
  "proxyAuthorization",
  "x-api-key",
  "api-key"
];

function sanitizeSensitiveText(value, secrets = []) {
  let sanitizedValue = String(value ?? "");

  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    sanitizedValue = sanitizedValue.split(secret).join("[redacted]");
  }

  return sanitizedValue
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1")
    .replace(
      /(["']?\bauthorization\b["']?\s*[:=]\s*)(["']?)(?!\s*Bearer\s+\[redacted\])\s*[^"',\r\n;]+(["']?)/gi,
      "$1$2[redacted]$3"
    )
    .replace(
      /(["']?\b(?:x-api-key|xapikey|x-goog-api-key|x_goog_api_key|xgoogapikey|api-key|api_key|apikey|api-token|api_token|apitoken|apim-subscription-key|apim_subscription_key|apimsubscriptionkey|auth|auth-token|auth_token|authtoken|azure-subscription-key|azure_subscription_key|azuresubscriptionkey|bearer-token|bearer_token|bearertoken|goog-api-key|goog_api_key|googapikey|google-api-key|google_api_key|googleapikey|client-secret|client_secret|clientsecret|id-token|id_token|idtoken|ocp-apim-subscription-key|ocp_apim_subscription_key|ocpapimsubscriptionkey|password|refresh-token|refresh_token|refreshtoken|secret|secret-key|secret_key|secretkey|session|session-token|session_token|sessiontoken|subscription-key|subscription_key|subscriptionkey|access-token|access_token|accesstoken|token)\b["']?\s*[:=]\s*)(["']?)[^"',\s;&]+(["']?)/gi,
      "$1$2[redacted]$3"
    )
    .replace(
      /(["']?\b(?:cookie|set-cookie|set_cookie|proxy-authorization|proxy_authorization|proxyAuthorization)\b["']?\s*[:=]\s*)(["']?)[^"',\r\n;]+(["']?)/gi,
      "$1$2[redacted]$3"
    )
    .replace(/sk-[A-Za-z0-9._-]{8,}/gi, "sk-[redacted]");
}

function clampInteger(value, defaultValue, minValue, maxValue) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultValue;
  }

  return Math.min(Math.max(Math.trunc(numericValue), minValue), maxValue);
}

function normalizeRouteProxyDiagnosticsRetention(retention = {}) {
  return {
    maxAgeDays: clampInteger(
      retention.maxAgeDays,
      defaultRouteProxyDiagnosticsRetention.maxAgeDays,
      routeProxyDiagnosticsRetentionLimits.maxAgeDays.min,
      routeProxyDiagnosticsRetentionLimits.maxAgeDays.max
    ),
    maxEntries: clampInteger(
      retention.maxEntries,
      defaultRouteProxyDiagnosticsRetention.maxEntries,
      routeProxyDiagnosticsRetentionLimits.maxEntries.min,
      routeProxyDiagnosticsRetentionLimits.maxEntries.max
    ),
    maxTotalBytes: clampInteger(
      retention.maxTotalBytes,
      defaultRouteProxyDiagnosticsRetention.maxTotalBytes,
      routeProxyDiagnosticsRetentionLimits.maxTotalBytes.min,
      routeProxyDiagnosticsRetentionLimits.maxTotalBytes.max
    )
  };
}

function toIsoString(value, fallbackDate = new Date()) {
  if (typeof value === "string") {
    const parsedMs = Date.parse(value);

    if (Number.isFinite(parsedMs)) {
      return new Date(parsedMs).toISOString();
    }
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  return fallbackDate.toISOString();
}

function createRouteProxyDiagnosticsManifest(overrides = {}, now = new Date()) {
  const nowIso = toIsoString(now);

  return {
    schemaVersion: routeProxyDiagnosticsSchemaVersion,
    enabled: overrides.enabled === true,
    createdAt: toIsoString(overrides.createdAt, now),
    updatedAt: toIsoString(overrides.updatedAt, now),
    retention: normalizeRouteProxyDiagnosticsRetention(overrides.retention)
  };
}

function sanitizePlainString(value, maxLength = 256) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function sanitizeMethod(value) {
  const method = sanitizePlainString(value || "GET", 16).toUpperCase();

  return method || "GET";
}

function sanitizePath(value) {
  const rawPath = typeof value === "string" && value.trim() ? value.trim() : "/";

  try {
    return new URL(rawPath, "http://desk-api-route-proxy.local").pathname.slice(0, maxRouteProxyDiagnosticPathLength) || "/";
  } catch {
    return "/";
  }
}

function normalizeStatusCode(value) {
  return clampInteger(value, 0, 0, 999);
}

function normalizeLatencyMs(value) {
  return clampInteger(value, 0, 0, Number.MAX_SAFE_INTEGER);
}

function normalizePositiveInteger(value, defaultValue = 1) {
  return clampInteger(value, defaultValue, 1, Number.MAX_SAFE_INTEGER);
}

function normalizeNonNegativeInteger(value, defaultValue = 0) {
  return clampInteger(value, defaultValue, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeRouteProxyDiagnosticResult(value, ok, statusCode) {
  if (routeProxyDiagnosticResultValues.has(value)) {
    return value;
  }

  if (ok) {
    return "success";
  }

  if (statusCode >= 400) {
    return "upstream-http-error";
  }

  if (statusCode === 0) {
    return "network-error";
  }

  return "proxy-error";
}

function normalizeRouteProxyTargetHealthState(value) {
  return routeProxyTargetHealthStateValues.has(value) ? value : "available";
}

function normalizeRouteProxyDiagnosticEventType(value) {
  return routeProxyDiagnosticEventTypeValues.has(value) ? value : "request";
}

function normalizeRouteProxyDiagnosticErrorCode(value) {
  return sanitizePlainString(value, 64)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizeRouteProxyDiagnosticEntry(input = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const statusCode = normalizeStatusCode(input.statusCode);
  const ok = input.ok === true;
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];

  return {
    schemaVersion: routeProxyDiagnosticsSchemaVersion,
    eventType: normalizeRouteProxyDiagnosticEventType(input.eventType),
    id: sanitizePlainString(input.id, 128) || `route-proxy-diagnostic-${now.getTime()}`,
    startedAt: toIsoString(input.startedAt, now),
    completedAt: toIsoString(input.completedAt, now),
    method: sanitizeMethod(input.method),
    path: sanitizePath(input.path),
    statusCode,
    latencyMs: normalizeLatencyMs(input.latencyMs),
    ok,
    result: normalizeRouteProxyDiagnosticResult(input.result, ok, statusCode),
    attempt: normalizePositiveInteger(input.attempt),
    profileId: sanitizePlainString(input.profileId, 128),
    targetConfigId: sanitizePlainString(input.targetConfigId, 128),
    targetOrdinal: normalizeNonNegativeInteger(input.targetOrdinal),
    targetHealthState: normalizeRouteProxyTargetHealthState(input.targetHealthState),
    errorCode: normalizeRouteProxyDiagnosticErrorCode(input.errorCode),
    errorMessage: sanitizeSensitiveText(input.errorMessage || "", secrets).slice(0, maxRouteProxyDiagnosticErrorLength)
  };
}

function normalizeRouteProxyDiagnosticsQuery(query = {}) {
  return {
    eventType: routeProxyDiagnosticEventTypeValues.has(query.eventType) ? query.eventType : undefined,
    limit: clampInteger(query.limit, 100, 1, maxRouteProxyDiagnosticReadLimit),
    ok: typeof query.ok === "boolean" ? query.ok : undefined,
    profileId: typeof query.profileId === "string" ? query.profileId : undefined,
    since: typeof query.since === "string" && Number.isFinite(Date.parse(query.since)) ? query.since : undefined,
    targetConfigId: typeof query.targetConfigId === "string" ? query.targetConfigId : undefined
  };
}

function readRouteProxyDiagnosticEntries(entries = [], query = {}, options = {}) {
  const normalizedQuery = normalizeRouteProxyDiagnosticsQuery(query);
  const sinceMs = normalizedQuery.since ? Date.parse(normalizedQuery.since) : undefined;

  return entries
    .map((entry) => sanitizeRouteProxyDiagnosticEntry(entry, options))
    .filter((entry) => {
      if (normalizedQuery.profileId && entry.profileId !== normalizedQuery.profileId) {
        return false;
      }

      if (normalizedQuery.targetConfigId && entry.targetConfigId !== normalizedQuery.targetConfigId) {
        return false;
      }

      if (typeof normalizedQuery.ok === "boolean" && entry.ok !== normalizedQuery.ok) {
        return false;
      }

      if (normalizedQuery.eventType && entry.eventType !== normalizedQuery.eventType) {
        return false;
      }

      if (Number.isFinite(sinceMs) && Date.parse(entry.completedAt) < sinceMs) {
        return false;
      }

      return true;
    })
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
    .slice(0, normalizedQuery.limit);
}

function parseDiagnosticFileDate(file) {
  if (typeof file.date === "string" && Number.isFinite(Date.parse(file.date))) {
    return new Date(file.date);
  }

  const name = String(file.name ?? "");
  const match = name.match(/entries-(\d{4}-\d{2}-\d{2})\.v1\.ndjson$/);

  if (match) {
    return new Date(`${match[1]}T00:00:00.000Z`);
  }

  return new Date(0);
}

function normalizeDiagnosticFile(file) {
  const name = sanitizePlainString(file.name, 260);

  return {
    bytes: normalizeNonNegativeInteger(file.bytes),
    date: parseDiagnosticFileDate(file),
    entryCount: normalizeNonNegativeInteger(file.entryCount),
    name
  };
}

function sumFiles(files, fieldName) {
  return files.reduce((total, file) => total + file[fieldName], 0);
}

function planRouteProxyDiagnosticsRetention(files = [], retention = {}, options = {}) {
  const normalizedRetention = normalizeRouteProxyDiagnosticsRetention(retention);
  const now = options.now instanceof Date ? options.now : new Date();
  const activeFileName = typeof options.activeFileName === "string" ? options.activeFileName : "";
  const normalizedFiles = files
    .map((file) => normalizeDiagnosticFile(file))
    .filter((file) => file.name)
    .sort((left, right) => left.date.getTime() - right.date.getTime() || left.name.localeCompare(right.name));
  const deleteFileNames = new Set();
  const cutoffMs = now.getTime() - normalizedRetention.maxAgeDays * 24 * 60 * 60 * 1000;

  for (const file of normalizedFiles) {
    if (file.name !== activeFileName && file.date.getTime() < cutoffMs) {
      deleteFileNames.add(file.name);
    }
  }

  let remainingFiles = normalizedFiles.filter((file) => !deleteFileNames.has(file.name));

  while (sumFiles(remainingFiles, "entryCount") > normalizedRetention.maxEntries) {
    const oldest = remainingFiles.find((file) => file.name !== activeFileName);

    if (!oldest) {
      break;
    }

    deleteFileNames.add(oldest.name);
    remainingFiles = remainingFiles.filter((file) => file.name !== oldest.name);
  }

  while (sumFiles(remainingFiles, "bytes") > normalizedRetention.maxTotalBytes) {
    const oldest = remainingFiles.find((file) => file.name !== activeFileName);

    if (!oldest) {
      break;
    }

    deleteFileNames.add(oldest.name);
    remainingFiles = remainingFiles.filter((file) => file.name !== oldest.name);
  }

  const retentionWarning =
    sumFiles(remainingFiles, "bytes") > normalizedRetention.maxTotalBytes
      ? "Active diagnostics file exceeds retention byte limit."
      : "";

  return {
    deleteFileNames: normalizedFiles
      .filter((file) => deleteFileNames.has(file.name))
      .map((file) => file.name),
    retention: normalizedRetention,
    retentionWarning
  };
}

module.exports = {
  createRouteProxyDiagnosticsManifest,
  defaultRouteProxyDiagnosticsRetention,
  forbiddenRouteProxyDiagnosticFields,
  maxRouteProxyDiagnosticReadLimit,
  normalizeRouteProxyDiagnosticsQuery,
  normalizeRouteProxyDiagnosticsRetention,
  planRouteProxyDiagnosticsRetention,
  readRouteProxyDiagnosticEntries,
  routeProxyDiagnosticsRetentionLimits,
  routeProxyDiagnosticsSchemaVersion,
  sanitizeRouteProxyDiagnosticEntry,
  sanitizeSensitiveText
};
