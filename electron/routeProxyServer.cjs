const http = require("node:http");
const {
  defaultRouteProxyCooldownMs,
  defaultRouteProxyFailureThreshold,
  normalizeRouteProxyCooldownMs,
  normalizeRouteProxyFailureThreshold,
  shouldRetryRouteProxyResponse
} = require("./routeProxyPolicy.cjs");

const defaultRouteProxyListenAddress = "127.0.0.1";
const defaultRouteProxyListenPort = 15_721;
const defaultConnectionTimeoutMs = 15_000;
const minConnectionTimeoutMs = 1_000;
const maxConnectionTimeoutMs = 120_000;
const defaultRouteProxyRoutingMode = "ordered";
const supportedRouteProxyRoutingModes = new Set(["ordered", "weighted"]);
const defaultRouteProxyTargetWeight = 1;
const minRouteProxyTargetWeight = 1;
const maxRouteProxyTargetWeight = 10;
const maxRouteProxyBodyBytes = 25 * 1024 * 1024;
const maxRouteProxyRequestLogEntries = 100;
const maxRouteProxyRequestLogErrorLength = 240;

function normalizeRouteProxyMaxBodyBytes(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return maxRouteProxyBodyBytes;
  }

  return Math.min(Math.trunc(numericValue), maxRouteProxyBodyBytes);
}

function createRouteProxyHttpError(message, statusCode, errorCode = "proxy_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function getRouteProxyHttpErrorStatusCode(error) {
  const statusCode = Number(error?.statusCode);

  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
}

function getRouteProxyHttpErrorCode(error) {
  return typeof error?.errorCode === "string" && error.errorCode ? error.errorCode : "proxy_error";
}

function createRouteProxyTargetState(target, index) {
  return {
    failureCount: 0,
    index,
    lastError: "",
    target,
    unavailableUntil: 0
  };
}

function normalizeRouteProxyTargetWeight(weight) {
  const numericWeight = Number(weight);

  if (!Number.isFinite(numericWeight)) {
    return defaultRouteProxyTargetWeight;
  }

  return Math.min(
    Math.max(Math.trunc(numericWeight), minRouteProxyTargetWeight),
    maxRouteProxyTargetWeight
  );
}

function getRouteProxyTargetHealthState(targetState, nowMs = Date.now()) {
  return targetState?.unavailableUntil > nowMs ? "cooling-down" : "available";
}

function createRouteProxyTargetHealthSnapshot(runtime, nowMs = Date.now()) {
  return (runtime?.targetStates ?? []).map((state) => {
    const healthState = getRouteProxyTargetHealthState(state, nowMs);

    return {
      baseUrl: state.target.baseUrl,
      configId: state.target.configId,
      failureCount: state.failureCount,
      lastError: state.lastError,
      name: state.target.configName,
      state: healthState,
      unavailableUntil: healthState === "cooling-down" ? new Date(state.unavailableUntil).toISOString() : "",
      weight: normalizeRouteProxyTargetWeight(state.target.weight)
    };
  });
}

function defaultSanitizeSensitiveText(value, secrets = []) {
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

function defaultNormalizeConnectionTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs)) {
    return defaultConnectionTimeoutMs;
  }

  return Math.min(Math.max(Math.trunc(timeoutMs), minConnectionTimeoutMs), maxConnectionTimeoutMs);
}

function defaultNormalizeConnectionBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error("Base URL must not be empty.");
  }

  const trimmedBaseUrl = baseUrl.trim();
  new URL(trimmedBaseUrl);

  return trimmedBaseUrl.endsWith("/") ? trimmedBaseUrl : `${trimmedBaseUrl}/`;
}

function defaultAssertConnectionAuthType(authType) {
  if (!["bearer", "api-key-header", "none"].includes(authType)) {
    throw new Error("Unsupported auth type.");
  }
}

function defaultAssertConnectionProviderType(providerType) {
  if (typeof providerType !== "string" || !providerType.trim()) {
    throw new Error("Unsupported provider type.");
  }
}

function defaultDecryptConnectionApiKey(authType, encryptedApiKey) {
  if (authType === "none") {
    return undefined;
  }

  if (typeof encryptedApiKey !== "string") {
    throw new Error("encryptedApiKey must be a string.");
  }

  return encryptedApiKey;
}

function defaultCreateProviderConnectionHeaders(_providerType, authType, apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (authType === "bearer" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (authType === "api-key-header" && apiKey) {
    headers["api-key"] = apiKey;
  }

  return headers;
}

function createRouteProxyController(options = {}) {
  const providerFetch = typeof options.providerFetch === "function" ? options.providerFetch : fetch;
  const normalizeConnectionBaseUrl =
    typeof options.normalizeConnectionBaseUrl === "function"
      ? options.normalizeConnectionBaseUrl
      : defaultNormalizeConnectionBaseUrl;
  const normalizeConnectionTimeout =
    typeof options.normalizeConnectionTimeout === "function"
      ? options.normalizeConnectionTimeout
      : defaultNormalizeConnectionTimeout;
  const assertConnectionAuthType =
    typeof options.assertConnectionAuthType === "function"
      ? options.assertConnectionAuthType
      : defaultAssertConnectionAuthType;
  const assertConnectionProviderType =
    typeof options.assertConnectionProviderType === "function"
      ? options.assertConnectionProviderType
      : defaultAssertConnectionProviderType;
  const decryptConnectionApiKey =
    typeof options.decryptConnectionApiKey === "function"
      ? options.decryptConnectionApiKey
      : defaultDecryptConnectionApiKey;
  const createProviderConnectionHeaders =
    typeof options.createProviderConnectionHeaders === "function"
      ? options.createProviderConnectionHeaders
      : defaultCreateProviderConnectionHeaders;
  const sanitizeSensitiveText =
    typeof options.sanitizeSensitiveText === "function" ? options.sanitizeSensitiveText : defaultSanitizeSensitiveText;
  const appendDiagnosticEntry =
    typeof options.appendDiagnosticEntry === "function" ? options.appendDiagnosticEntry : undefined;
  const maxRequestBodyBytes = normalizeRouteProxyMaxBodyBytes(options.maxRequestBodyBytes);
  const maxConvertedResponseBodyBytes = normalizeRouteProxyMaxBodyBytes(options.maxConvertedResponseBodyBytes);
  const maxConvertedStreamEventBytes = normalizeRouteProxyMaxBodyBytes(options.maxConvertedStreamEventBytes);
  const maxConvertedStreamOutputBytes = normalizeRouteProxyMaxBodyBytes(options.maxConvertedStreamOutputBytes);

  let routeProxyServer;
  let routeProxyRuntime;
  let routeProxyStatus = createRouteProxyStatus();
  let routeProxyRequestLogSequence = 0;
  let routeProxyRequestLogs = [];
  const pendingDiagnosticWrites = new Set();

  function createRouteProxyStatus(overrides = {}) {
    const totalRequests = overrides.totalRequests ?? 0;
    const successRequests = overrides.successRequests ?? 0;

    return {
      activeConnections: 0,
      address: defaultRouteProxyListenAddress,
      cooldownMs: defaultRouteProxyCooldownMs,
      failedRequests: 0,
      failureThreshold: defaultRouteProxyFailureThreshold,
      lastError: "",
      lastRequestAt: "",
      port: defaultRouteProxyListenPort,
      proxyUrl: "",
      routingMode: defaultRouteProxyRoutingMode,
      running: false,
      startedAt: "",
      successRate: totalRequests > 0 ? Math.round((successRequests / totalRequests) * 10_000) / 100 : 0,
      successRequests,
      targetBaseUrl: "",
      targetCount: 0,
      targetConfigId: "",
      targetHealth: [],
      targetName: "",
      totalRequests,
      uptimeSeconds: 0,
      ...overrides
    };
  }

  function getRouteProxyStatusSnapshot() {
    if (routeProxyRuntime) {
      refreshRouteProxyStatusTargetHealth(routeProxyRuntime);
    }

    const snapshot = {
      ...routeProxyStatus
    };

    if (snapshot.running && snapshot.startedAt) {
      const startedAtMs = Date.parse(snapshot.startedAt);
      snapshot.uptimeSeconds = Number.isFinite(startedAtMs)
        ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
        : 0;
    }

    snapshot.successRate =
      snapshot.totalRequests > 0
        ? Math.round((snapshot.successRequests / snapshot.totalRequests) * 10_000) / 100
        : 0;

    return snapshot;
  }

  function getRouteProxyRequestPath(incomingUrl) {
    try {
      return new URL(incomingUrl || "/", "http://desk-api-route-proxy.local").pathname || "/";
    } catch {
      return "/";
    }
  }

  function createRouteProxyRequestLogBase(nodeRequest, startedAt) {
    return {
      attempt: 1,
      completedAt: "",
      error: "",
      id: `route-proxy-request-${Date.now()}-${++routeProxyRequestLogSequence}`,
      latencyMs: 0,
      method: String(nodeRequest.method || "GET").toUpperCase().slice(0, 16),
      ok: false,
      path: getRouteProxyRequestPath(nodeRequest.url),
      startedAt,
      statusCode: 0,
      targetConfigId: "",
      targetName: ""
    };
  }

  function sanitizeRouteProxyRequestLogError(errorMessage, target) {
    return sanitizeSensitiveText(errorMessage || "", [target?.apiKey ?? ""]).slice(0, maxRouteProxyRequestLogErrorLength);
  }

  function addRouteProxyRequestLog(entry) {
    routeProxyRequestLogs = [{ ...entry }, ...routeProxyRequestLogs].slice(0, maxRouteProxyRequestLogEntries);
  }

  function getRouteProxyDiagnosticResult(logEntry, result) {
    if (typeof result.result === "string" && result.result) {
      return result.result;
    }

    if (logEntry.ok) {
      return "success";
    }

    if (!result.target) {
      return "proxy-error";
    }

    if (logEntry.statusCode === 0) {
      return "network-error";
    }

    if (logEntry.statusCode >= 400) {
      return "upstream-http-error";
    }

    return "proxy-error";
  }

  function getRouteProxyDiagnosticErrorCode(logEntry, result) {
    if (typeof result.errorCode === "string" && result.errorCode) {
      return result.errorCode;
    }

    if (logEntry.ok) {
      return "";
    }

    if (logEntry.statusCode >= 400) {
      return `http_${logEntry.statusCode}`;
    }

    if (logEntry.statusCode === 0) {
      return "network_error";
    }

    return "proxy_error";
  }

  function getRouteProxyDiagnosticTargetHealthState(targetState) {
    return getRouteProxyTargetHealthState(targetState);
  }

  function queueRouteProxyDiagnosticEntry(diagnosticEntry, secrets = []) {
    if (!appendDiagnosticEntry) {
      return;
    }

    const writePromise = Promise.resolve()
      .then(() =>
        appendDiagnosticEntry(diagnosticEntry, {
          secrets: secrets.filter(Boolean)
        })
      )
      .catch(() => undefined)
      .finally(() => {
        pendingDiagnosticWrites.delete(writePromise);
      });

    pendingDiagnosticWrites.add(writePromise);
  }

  function queueRouteProxyDiagnosticWrite(logEntry, result) {
    const target = result.target;
    const targetState = result.targetState;
    const diagnosticEntry = {
      attempt: logEntry.attempt,
      completedAt: logEntry.completedAt,
      errorCode: getRouteProxyDiagnosticErrorCode(logEntry, result),
      errorMessage: logEntry.error,
      id: logEntry.id,
      latencyMs: logEntry.latencyMs,
      method: logEntry.method,
      ok: logEntry.ok,
      path: logEntry.path,
      eventType: "request",
      profileId: routeProxyRuntime?.profileId ?? "",
      result: getRouteProxyDiagnosticResult(logEntry, result),
      startedAt: logEntry.startedAt,
      statusCode: logEntry.statusCode,
      targetConfigId: logEntry.targetConfigId,
      targetHealthState: getRouteProxyDiagnosticTargetHealthState(targetState),
      targetOrdinal: Number.isInteger(targetState?.index) ? targetState.index : 0
    };
    const secrets = [
      target?.apiKey ?? "",
      ...getRouteProxyRuntimeSecrets(routeProxyRuntime)
    ].filter(Boolean);

    queueRouteProxyDiagnosticEntry(diagnosticEntry, secrets);
  }

  function queueRouteProxyTargetHealthDiagnostic(runtime, state, healthState, errorCode, errorMessage = "") {
    if (!appendDiagnosticEntry) {
      return;
    }

    const now = new Date().toISOString();
    const target = state.target;
    const sanitizedError = sanitizeRouteProxyRequestLogError(errorMessage, target);

    queueRouteProxyDiagnosticEntry(
      {
        attempt: 1,
        completedAt: now,
        errorCode,
        errorMessage: sanitizedError,
        eventType: "target-health",
        id: `route-proxy-health-${Date.now()}-${++routeProxyRequestLogSequence}`,
        latencyMs: 0,
        method: "HEALTH",
        ok: healthState === "available",
        path: "/_route-proxy/target-health",
        profileId: runtime?.profileId ?? "",
        result: "target-health-change",
        startedAt: now,
        statusCode: 0,
        targetConfigId: target.configId,
        targetHealthState: healthState,
        targetOrdinal: Number.isInteger(state.index) ? state.index : 0
      },
      [target.apiKey ?? "", ...getRouteProxyRuntimeSecrets(runtime)]
    );
  }

  function completeRouteProxyRequestLog(baseEntry, startedAtMs, result) {
    const attempt = Number.isInteger(result.attempt) && result.attempt > 0 ? result.attempt : 1;
    const target = result.target;
    const logEntry = {
      ...baseEntry,
      attempt,
      completedAt: new Date().toISOString(),
      error: sanitizeRouteProxyRequestLogError(result.error, target),
      id: attempt > 1 ? `${baseEntry.id}-${attempt}` : baseEntry.id,
      latencyMs: Math.max(0, Date.now() - startedAtMs),
      ok: Boolean(result.ok),
      statusCode: Number.isInteger(result.statusCode) ? result.statusCode : 0,
      targetConfigId: target?.configId ?? baseEntry.targetConfigId,
      targetName: target?.configName ?? baseEntry.targetName
    };

    addRouteProxyRequestLog(logEntry);
    queueRouteProxyDiagnosticWrite(logEntry, result);
  }

  async function flushRouteProxyDiagnostics() {
    while (pendingDiagnosticWrites.size > 0) {
      await Promise.allSettled([...pendingDiagnosticWrites]);
    }
  }

  function getRouteProxyRequestLogsSnapshot() {
    return routeProxyRequestLogs.map((entry) => ({ ...entry }));
  }

  function clearRouteProxyRequestLogs() {
    routeProxyRequestLogs = [];
    return getRouteProxyRequestLogsSnapshot();
  }

  function getRouteProxyRuntimeTargets(runtime) {
    return runtime?.targetStates?.map((state) => state.target) ?? [];
  }

  function getRouteProxyRuntimeSecrets(runtime) {
    return getRouteProxyRuntimeTargets(runtime)
      .map((target) => target.apiKey)
      .filter(Boolean);
  }

  function updateRouteProxyStatusTarget(target) {
    if (!target) {
      return;
    }

    routeProxyStatus.targetBaseUrl = target.baseUrl;
    routeProxyStatus.targetConfigId = target.configId;
    routeProxyStatus.targetName = target.configName;
  }

  function getRouteProxyTargetHealthSnapshot(runtime = routeProxyRuntime) {
    return createRouteProxyTargetHealthSnapshot(runtime);
  }

  function refreshRouteProxyStatusTargetHealth(runtime = routeProxyRuntime) {
    routeProxyStatus.targetCount = runtime?.targetStates?.length ?? 0;
    routeProxyStatus.targetHealth = getRouteProxyTargetHealthSnapshot(runtime);
  }

  function createRouteProxyWeightedTargetIndexes(targetStates) {
    const indexes = [];

    for (const state of targetStates) {
      const weight = normalizeRouteProxyTargetWeight(state?.target?.weight);

      for (let count = 0; count < weight; count += 1) {
        indexes.push(state.index);
      }
    }

    return indexes.length > 0 ? indexes : targetStates.map((state) => state.index);
  }

  function selectOrderedRouteProxyTargetState(runtime, attemptedIndexes = new Set()) {
    const targetStates = runtime?.targetStates ?? [];
    const now = Date.now();

    for (let offset = 0; offset < targetStates.length; offset += 1) {
      const index = offset;
      const state = targetStates[index];

      if (!state || attemptedIndexes.has(index) || state.unavailableUntil > now) {
        continue;
      }

      runtime.activeTargetIndex = index;
      updateRouteProxyStatusTarget(state.target);
      refreshRouteProxyStatusTargetHealth(runtime);
      return state;
    }

    return undefined;
  }

  function selectWeightedRouteProxyTargetState(runtime, attemptedIndexes = new Set()) {
    const targetStates = runtime?.targetStates ?? [];
    const weightedTargetIndexes = runtime?.weightedTargetIndexes ?? [];
    const now = Date.now();

    if (weightedTargetIndexes.length === 0) {
      return selectOrderedRouteProxyTargetState(runtime, attemptedIndexes);
    }

    for (let offset = 0; offset < weightedTargetIndexes.length; offset += 1) {
      const weightedOffset = (runtime.nextWeightedTargetOffset + offset) % weightedTargetIndexes.length;
      const index = weightedTargetIndexes[weightedOffset];
      const state = targetStates[index];

      if (!state || attemptedIndexes.has(index) || state.unavailableUntil > now) {
        continue;
      }

      runtime.nextWeightedTargetOffset = (weightedOffset + 1) % weightedTargetIndexes.length;
      runtime.activeTargetIndex = index;
      updateRouteProxyStatusTarget(state.target);
      refreshRouteProxyStatusTargetHealth(runtime);
      return state;
    }

    return undefined;
  }

  function selectRouteProxyTargetState(runtime, attemptedIndexes = new Set()) {
    return runtime?.routingMode === "weighted"
      ? selectWeightedRouteProxyTargetState(runtime, attemptedIndexes)
      : selectOrderedRouteProxyTargetState(runtime, attemptedIndexes);
  }

  function markRouteProxyTargetSuccess(runtime, state) {
    const shouldWriteRecoveryEvent = state.failureCount > 0 || state.unavailableUntil > 0 || Boolean(state.lastError);

    state.failureCount = 0;
    state.lastError = "";
    state.unavailableUntil = 0;
    runtime.activeTargetIndex = state.index;
    updateRouteProxyStatusTarget(state.target);
    refreshRouteProxyStatusTargetHealth(runtime);

    if (shouldWriteRecoveryEvent) {
      queueRouteProxyTargetHealthDiagnostic(runtime, state, "available", "target_recovered");
    }
  }

  function markRouteProxyTargetFailure(runtime, state, errorMessage) {
    const sanitizedError = sanitizeSensitiveText(errorMessage || "", [state.target.apiKey ?? ""]);
    const previousHealthState = getRouteProxyTargetHealthState(state);

    state.failureCount += 1;
    state.lastError = sanitizedError.slice(0, maxRouteProxyRequestLogErrorLength);

    if (state.failureCount >= runtime.failureThreshold) {
      state.unavailableUntil = Date.now() + runtime.cooldownMs;
    }

    refreshRouteProxyStatusTargetHealth(runtime);

    if (previousHealthState !== getRouteProxyTargetHealthState(state)) {
      queueRouteProxyTargetHealthDiagnostic(
        runtime,
        state,
        "cooling-down",
        "target_cooling_down",
        state.lastError
      );
    }
  }

  function normalizeRouteProxyListenAddress(address) {
    if (typeof address !== "string" || !address.trim()) {
      return defaultRouteProxyListenAddress;
    }

    const trimmedAddress = address.trim();

    if (trimmedAddress.length > 128 || !/^[a-zA-Z0-9.:-]+$/.test(trimmedAddress)) {
      throw new Error("Invalid proxy listen address.");
    }

    return trimmedAddress;
  }

  function normalizeRouteProxyListenPort(port) {
    if (!Number.isFinite(port)) {
      return defaultRouteProxyListenPort;
    }

    const normalizedPort = Math.trunc(port);

    if (normalizedPort < 1 || normalizedPort > 65_535) {
      throw new Error("Proxy listen port must be between 1 and 65535.");
    }

    return normalizedPort;
  }

  function normalizeRouteProxyRoutingMode(routingMode) {
    const normalizedRoutingMode = typeof routingMode === "string" ? routingMode : defaultRouteProxyRoutingMode;

    return supportedRouteProxyRoutingModes.has(normalizedRoutingMode)
      ? normalizedRoutingMode
      : defaultRouteProxyRoutingMode;
  }

  function getRouteProxyUrlHost(address) {
    const normalizedAddress = address === "0.0.0.0" || address === "::" ? defaultRouteProxyListenAddress : address;

    return normalizedAddress.includes(":") && !normalizedAddress.startsWith("[") ? `[${normalizedAddress}]` : normalizedAddress;
  }

  function createRouteProxyUrl(address, port) {
    return `http://${getRouteProxyUrlHost(address)}:${port}/`;
  }

  function normalizeRouteProxyTarget(target) {
    if (!target || typeof target !== "object") {
      throw new Error("target must be an object.");
    }

    assertString(target.configId, "target.configId");
    assertString(target.configName, "target.configName");
    assertString(target.providerId, "target.providerId");
    assertString(target.providerType, "target.providerType");
    assertString(target.baseUrl, "target.baseUrl");
    assertConnectionAuthType(target.authType);
    assertConnectionProviderType(target.providerType);

    const normalizedBaseUrl = normalizeConnectionBaseUrl(target.baseUrl, target.providerType);
    const endpointMode = normalizeOpenAiEndpointMode(target.endpointMode);
    const apiKey = decryptConnectionApiKey(target.authType, target.encryptedApiKey);

    new URL(normalizedBaseUrl);

    return {
      apiKey,
      authType: target.authType,
      baseUrl: normalizedBaseUrl,
      configId: target.configId.trim(),
      configName: target.configName.trim(),
      endpointMode,
      providerId: target.providerId.trim(),
      providerType: target.providerType,
      weight: normalizeRouteProxyTargetWeight(target.weight)
    };
  }

  function normalizeRouteProxyTargets(request) {
    const rawTargets = Array.isArray(request.targets) && request.targets.length > 0 ? request.targets : [request.target];
    const targets = rawTargets.map((target) => normalizeRouteProxyTarget(target));

    if (targets.length === 0) {
      throw new Error("At least one route proxy target is required.");
    }

    return targets;
  }

  function normalizeRouteProxyStartRequest(request) {
    if (!request || typeof request !== "object") {
      throw new Error("request must be an object.");
    }

    const targets = normalizeRouteProxyTargets(request);
    const profileId = typeof request.profileId === "string" ? request.profileId.trim().slice(0, 128) : "";

    return {
      listenAddress: normalizeRouteProxyListenAddress(request.listenAddress),
      listenPort: normalizeRouteProxyListenPort(request.listenPort),
      cooldownMs: normalizeRouteProxyCooldownMs(request.cooldownMs),
      failureThreshold: normalizeRouteProxyFailureThreshold(request.failureThreshold),
      profileId,
      routingMode: normalizeRouteProxyRoutingMode(request.routingMode),
      target: targets[0],
      targets,
      timeoutMs: normalizeConnectionTimeout(request.timeoutMs)
    };
  }

  function getHeaderValue(value) {
    if (Array.isArray(value)) {
      return value.join(", ");
    }

    return typeof value === "string" ? value : undefined;
  }

  function getRouteProxyRequestContentLength(request) {
    const contentLength = getHeaderValue(request.headers["content-length"]);

    if (!contentLength) {
      return undefined;
    }

    const normalizedContentLength = Number(contentLength);

    return Number.isFinite(normalizedContentLength) && normalizedContentLength >= 0
      ? Math.trunc(normalizedContentLength)
      : undefined;
  }

  function assertRouteProxyRequestBodyWithinLimit(request) {
    const contentLength = getRouteProxyRequestContentLength(request);

    if (contentLength !== undefined && contentLength > maxRequestBodyBytes) {
      throw createRouteProxyHttpError("Request body is too large.", 413, "request_body_too_large");
    }
  }

  function getRouteProxyResponseContentLength(response) {
    const contentLength = response.headers.get("content-length");

    if (!contentLength) {
      return undefined;
    }

    const normalizedContentLength = Number(contentLength);

    return Number.isFinite(normalizedContentLength) && normalizedContentLength >= 0
      ? Math.trunc(normalizedContentLength)
      : undefined;
  }

  async function cancelRouteProxyResponseBody(response) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore cancellation failures while replacing the upstream response with a local proxy error.
    }
  }

  async function cancelRouteProxyResponseReader(reader) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures while replacing the upstream response with a local proxy error.
    }
  }

  async function readRouteProxyConvertedResponseText(response) {
    const contentLength = getRouteProxyResponseContentLength(response);

    if (contentLength !== undefined && contentLength > maxConvertedResponseBodyBytes) {
      await cancelRouteProxyResponseBody(response);
      throw createRouteProxyHttpError("Upstream response body is too large.", 502, "upstream_response_body_too_large");
    }

    if (!response.body) {
      return "";
    }

    const chunks = [];
    const reader = response.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxConvertedResponseBodyBytes) {
        await cancelRouteProxyResponseReader(reader);
        throw createRouteProxyHttpError("Upstream response body is too large.", 502, "upstream_response_body_too_large");
      }

      chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  async function readRouteProxyConvertedResponseJson(response) {
    const text = await readRouteProxyConvertedResponseText(response);

    try {
      return JSON.parse(text);
    } catch {
      throw createRouteProxyHttpError("Upstream response body is not valid JSON.", 502, "upstream_response_invalid_json");
    }
  }

  function isRouteProxyConvertedStreamFragmentTooLarge(fragment) {
    return Buffer.byteLength(String(fragment ?? ""), "utf8") > maxConvertedStreamEventBytes;
  }

  async function assertRouteProxyConvertedStreamFragmentsWithinLimit(reader, fragments) {
    for (const fragment of fragments) {
      if (isRouteProxyConvertedStreamFragmentTooLarge(fragment)) {
        await cancelRouteProxyResponseReader(reader);
        throw createRouteProxyHttpError("Upstream SSE event is too large.", 502, "upstream_sse_event_too_large");
      }
    }
  }

  function assertRouteProxyConvertedStreamOutputWithinLimit(outputText, delta) {
    if (Buffer.byteLength(`${outputText ?? ""}${delta ?? ""}`, "utf8") > maxConvertedStreamOutputBytes) {
      throw createRouteProxyHttpError("Converted stream output is too large.", 502, "converted_stream_output_too_large");
    }
  }

  function getHeaderKey(headers, headerName) {
    const normalizedHeaderName = headerName.toLowerCase();

    return Object.keys(headers).find((key) => key.toLowerCase() === normalizedHeaderName);
  }

  function hasHeader(headers, headerName) {
    return Boolean(getHeaderKey(headers, headerName));
  }

  function deleteHeader(headers, headerName) {
    const key = getHeaderKey(headers, headerName);

    if (key) {
      delete headers[key];
    }
  }

  function setHeader(headers, headerName, value) {
    deleteHeader(headers, headerName);
    headers[headerName] = value;
  }

  function createRouteProxyForwardHeaders(incomingHeaders, target) {
    const headers = {};
    let forwardedHeaderCount = 0;

    for (const [name, value] of Object.entries(incomingHeaders)) {
      const headerValue = getHeaderValue(value);

      if (shouldForwardRouteProxyRequestHeader(name, headerValue, forwardedHeaderCount)) {
        headers[name] = headerValue;
        forwardedHeaderCount += 1;
      }
    }

    const providerHeaders = createProviderConnectionHeaders(target.providerType, target.authType, target.apiKey);

    for (const [name, value] of Object.entries(providerHeaders)) {
      if (name.toLowerCase() === "content-type" && hasHeader(headers, "content-type")) {
        continue;
      }

      setHeader(headers, name, value);
    }

    return headers;
  }

  function createRouteProxyCorsHeaders(incomingHeaders = {}) {
    const requestedHeaders = getHeaderValue(incomingHeaders["access-control-request-headers"]);

    return {
      "access-control-allow-headers": normalizeRouteProxyCorsAllowedRequestHeaders(requestedHeaders),
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-type,request-id,x-request-id"
    };
  }

  function createRouteProxyResponseHeaders(responseHeaders, incomingHeaders) {
    const headers = {};
    let forwardedHeaderCount = 0;

    responseHeaders.forEach((value, name) => {
      if (shouldForwardRouteProxyResponseHeader(name, value, forwardedHeaderCount)) {
        headers[name] = value;
        forwardedHeaderCount += 1;
      }
    });

    return {
      ...headers,
      ...createRouteProxyCorsHeaders(incomingHeaders)
    };
  }

  function buildRouteProxyTargetUrl(baseUrl, providerType, incomingUrl) {
    const upstreamBase = new URL(normalizeConnectionBaseUrl(baseUrl, providerType));
    const incoming = new URL(incomingUrl || "/", "http://desk-api-route-proxy.local");
    const upstreamBasePath = upstreamBase.pathname.replace(/\/+$/, "");
    const incomingPath = incoming.pathname || "/";
    let relativePath = incomingPath.replace(/^\/+/, "");

    if (upstreamBasePath && upstreamBasePath !== "/") {
      if (incomingPath === upstreamBasePath) {
        relativePath = "";
      } else if (incomingPath.startsWith(`${upstreamBasePath}/`)) {
        relativePath = incomingPath.slice(upstreamBasePath.length + 1);
      }
    }

    const targetUrl = new URL(relativePath, upstreamBase);
    targetUrl.search = normalizeRouteProxyForwardRequestSearch(incoming.searchParams);
    targetUrl.hash = "";

    return targetUrl.toString();
  }

  function shouldUseRouteProxyResponsesApi(target) {
    if (target.providerType !== "openai") {
      return false;
    }

    if (target.endpointMode === "responses") {
      return true;
    }

    if (target.endpointMode === "chat-completions") {
      return false;
    }

    try {
      const parsedBaseUrl = new URL(normalizeConnectionBaseUrl(target.baseUrl, target.providerType));
      return parsedBaseUrl.protocol === "https:" && parsedBaseUrl.hostname.toLowerCase() === "api.openai.com";
    } catch {
      return false;
    }
  }

  function isRouteProxyResponsesRequestPath(incomingUrl) {
    return getRouteProxyRequestPath(incomingUrl).replace(/\/+$/, "").endsWith("/responses");
  }

  function isRouteProxyAnthropicMessagesRequestPath(incomingUrl) {
    return getRouteProxyRequestPath(incomingUrl).replace(/\/+$/, "").endsWith("/messages");
  }

  function replaceRouteProxyResponsesPathWithChatCompletions(incomingUrl) {
    const incoming = new URL(incomingUrl || "/", "http://desk-api-route-proxy.local");
    const normalizedPath = (incoming.pathname || "/").replace(/\/+$/, "");
    const pathPrefix = normalizedPath.slice(0, -"/responses".length);
    incoming.pathname = `${pathPrefix}/chat/completions`;
    return `${incoming.pathname}${incoming.search}`;
  }

  function replaceRouteProxyAnthropicMessagesPathWithChatCompletions(incomingUrl) {
    const incoming = new URL(incomingUrl || "/", "http://desk-api-route-proxy.local");
    const normalizedPath = (incoming.pathname || "/").replace(/\/+$/, "");
    const pathPrefix = normalizedPath.slice(0, -"/messages".length);
    incoming.pathname = `${pathPrefix}/chat/completions`;
    return `${incoming.pathname}${incoming.search}`;
  }

  function parseRouteProxyJsonBody(body) {
    try {
      return JSON.parse(Buffer.from(body || Buffer.alloc(0)).toString("utf8"));
    } catch {
      return undefined;
    }
  }

  function convertRouteProxyResponsesContentToChatContent(content) {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const convertedParts = content
      .map((part) => {
        if (typeof part === "string") {
          return {
            text: part,
            type: "text"
          };
        }

        if (!part || typeof part !== "object") {
          return undefined;
        }

        if (typeof part.text === "string" && ["input_text", "output_text", "text"].includes(part.type)) {
          return {
            text: part.text,
            type: "text"
          };
        }

        if (part.type === "input_image" && typeof part.image_url === "string") {
          return {
            image_url: {
              url: part.image_url
            },
            type: "image_url"
          };
        }

        return undefined;
      })
      .filter(Boolean);

    return convertedParts.length > 0 ? convertedParts : "";
  }

  function convertRouteProxyResponsesFunctionCallInputToChatToolCall(item, index) {
    if (!item || typeof item !== "object" || item.type !== "function_call") {
      return undefined;
    }

    const functionName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "";

    if (!functionName) {
      return undefined;
    }

    const callId =
      typeof item.call_id === "string" && item.call_id.trim()
        ? item.call_id.trim()
        : typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `call_${index}`;

    return {
      id: callId,
      type: "function",
      function: {
        arguments: normalizeRouteProxyFunctionCallArguments(item.arguments),
        name: functionName
      }
    };
  }

  function stringifyRouteProxyResponsesFunctionCallOutput(output) {
    if (typeof output === "string") {
      return output;
    }

    const extractedText = extractRouteProxyTextFromContentParts(output).trim();

    if (extractedText) {
      return extractedText;
    }

    if (output && typeof output === "object") {
      try {
        return JSON.stringify(output);
      } catch {
        return "";
      }
    }

    return "";
  }

  function convertRouteProxyResponsesFunctionCallOutputToChatToolMessage(item) {
    if (!item || typeof item !== "object" || item.type !== "function_call_output") {
      return undefined;
    }

    if (typeof item.call_id !== "string" || !item.call_id.trim()) {
      return undefined;
    }

    return {
      content: stringifyRouteProxyResponsesFunctionCallOutput(item.output),
      role: "tool",
      tool_call_id: item.call_id.trim()
    };
  }

  function convertRouteProxyResponsesInputToChatMessages(input, instructions) {
    const messages = [];

    if (typeof instructions === "string" && instructions.trim()) {
      messages.push({
        content: instructions.trim(),
        role: "system"
      });
    }

    if (typeof input === "string") {
      messages.push({
        content: input,
        role: "user"
      });
      return messages;
    }

    if (Array.isArray(input)) {
      const looksLikeMessages = input.some(
        (item) =>
          item &&
          typeof item === "object" &&
          (typeof item.role === "string" || item.type === "message" || item.type === "function_call" || item.type === "function_call_output")
      );

      if (looksLikeMessages) {
        let pendingToolCalls = [];
        const flushPendingToolCalls = () => {
          if (pendingToolCalls.length === 0) {
            return;
          }

          messages.push({
            content: "",
            role: "assistant",
            tool_calls: pendingToolCalls
          });
          pendingToolCalls = [];
        };

        for (const item of input) {
          if (!item || typeof item !== "object") {
            continue;
          }

          if (item.type === "function_call") {
            const toolCall = convertRouteProxyResponsesFunctionCallInputToChatToolCall(item, pendingToolCalls.length);

            if (toolCall) {
              pendingToolCalls.push(toolCall);
            }

            continue;
          }

          flushPendingToolCalls();

          if (item.type === "function_call_output") {
            const toolMessage = convertRouteProxyResponsesFunctionCallOutputToChatToolMessage(item);

            if (toolMessage) {
              messages.push(toolMessage);
            }

            continue;
          }

          const role = ["assistant", "system", "user"].includes(item.role) ? item.role : "user";
          messages.push({
            content: convertRouteProxyResponsesContentToChatContent(item.content),
            role
          });
        }

        flushPendingToolCalls();

        return messages;
      }

      messages.push({
        content: convertRouteProxyResponsesContentToChatContent(input),
        role: "user"
      });
      return messages;
    }

    messages.push({
      content: "",
      role: "user"
    });
    return messages;
  }

  function convertRouteProxyResponsesFunctionToolToChatTool(tool) {
    if (!tool || typeof tool !== "object" || tool.type !== "function" || typeof tool.name !== "string" || !tool.name.trim()) {
      return undefined;
    }

    const convertedTool = {
      type: "function",
      function: {
        name: tool.name.trim()
      }
    };

    if (typeof tool.description === "string" && tool.description.trim()) {
      convertedTool.function.description = tool.description;
    }

    if (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)) {
      convertedTool.function.parameters = tool.parameters;
    }

    if (typeof tool.strict === "boolean") {
      convertedTool.function.strict = tool.strict;
    }

    return convertedTool;
  }

  function convertRouteProxyResponsesToolsToChatTools(tools) {
    if (!Array.isArray(tools)) {
      return [];
    }

    return tools.map(convertRouteProxyResponsesFunctionToolToChatTool).filter(Boolean);
  }

  function convertRouteProxyResponsesToolChoiceToChatToolChoice(toolChoice) {
    if (["auto", "none", "required"].includes(toolChoice)) {
      return toolChoice;
    }

    if (!toolChoice || typeof toolChoice !== "object" || toolChoice.type !== "function") {
      return undefined;
    }

    const functionName =
      typeof toolChoice.name === "string" && toolChoice.name.trim()
        ? toolChoice.name.trim()
        : typeof toolChoice.function?.name === "string" && toolChoice.function.name.trim()
          ? toolChoice.function.name.trim()
          : "";

    if (!functionName) {
      return undefined;
    }

    return {
      type: "function",
      function: {
        name: functionName
      }
    };
  }

  function createRouteProxyChatCompletionsBodyFromResponses(responsesBody) {
    const chatBody = {
      messages: convertRouteProxyResponsesInputToChatMessages(responsesBody.input, responsesBody.instructions),
      stream: responsesBody.stream === true
    };
    const copiedFields = ["frequency_penalty", "model", "presence_penalty", "stop", "temperature", "top_p", "user"];

    for (const field of copiedFields) {
      if (responsesBody[field] !== undefined) {
        chatBody[field] = responsesBody[field];
      }
    }

    if (Number.isFinite(responsesBody.max_output_tokens)) {
      chatBody.max_tokens = Math.trunc(responsesBody.max_output_tokens);
    }

    const convertedTools = convertRouteProxyResponsesToolsToChatTools(responsesBody.tools);

    if (convertedTools.length > 0) {
      chatBody.tools = convertedTools;

      const convertedToolChoice = convertRouteProxyResponsesToolChoiceToChatToolChoice(responsesBody.tool_choice);

      if (convertedToolChoice !== undefined) {
        chatBody.tool_choice = convertedToolChoice;
      }

      if (typeof responsesBody.parallel_tool_calls === "boolean") {
        chatBody.parallel_tool_calls = responsesBody.parallel_tool_calls;
      }
    }

    return chatBody;
  }

  function convertRouteProxyAnthropicImageSourceToChatImageUrl(source) {
    if (!source || typeof source !== "object") {
      return undefined;
    }

    if (
      source.type === "base64" &&
      typeof source.media_type === "string" &&
      source.media_type &&
      typeof source.data === "string" &&
      source.data
    ) {
      return `data:${source.media_type};base64,${source.data}`;
    }

    if (source.type === "url" && typeof source.url === "string" && source.url) {
      return source.url;
    }

    return undefined;
  }

  function convertRouteProxyAnthropicContentToChatContent(content) {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const convertedParts = content
      .map((part) => {
        if (typeof part === "string") {
          return {
            text: part,
            type: "text"
          };
        }

        if (!part || typeof part !== "object") {
          return undefined;
        }

        if (part.type === "text" && typeof part.text === "string") {
          return {
            text: part.text,
            type: "text"
          };
        }

        if (part.type === "image") {
          const imageUrl = convertRouteProxyAnthropicImageSourceToChatImageUrl(part.source);

          if (imageUrl) {
            return {
              image_url: {
                url: imageUrl
              },
              type: "image_url"
            };
          }
        }

        return undefined;
      })
      .filter(Boolean);

    return convertedParts.length > 0 ? convertedParts : "";
  }

  function convertRouteProxyAnthropicSystemToChatContent(system) {
    if (typeof system === "string") {
      return system.trim();
    }

    return extractRouteProxyTextFromContentParts(system).trim();
  }

  function stringifyRouteProxyAnthropicToolUseInput(input) {
    if (typeof input === "string") {
      return input;
    }

    if (input && typeof input === "object" && !Array.isArray(input)) {
      try {
        return JSON.stringify(input);
      } catch {
        return "{}";
      }
    }

    return "{}";
  }

  function convertRouteProxyAnthropicToolUseToChatToolCall(part, index) {
    if (!part || typeof part !== "object" || part.type !== "tool_use") {
      return undefined;
    }

    const functionName = typeof part.name === "string" && part.name.trim() ? part.name.trim() : "";

    if (!functionName) {
      return undefined;
    }

    return {
      id: typeof part.id === "string" && part.id.trim() ? part.id.trim() : `toolu_${index}`,
      type: "function",
      function: {
        arguments: stringifyRouteProxyAnthropicToolUseInput(part.input),
        name: functionName
      }
    };
  }

  function convertRouteProxyAnthropicToolResultToChatToolMessage(part) {
    if (!part || typeof part !== "object" || part.type !== "tool_result") {
      return undefined;
    }

    if (typeof part.tool_use_id !== "string" || !part.tool_use_id.trim()) {
      return undefined;
    }

    return {
      content: extractRouteProxyTextFromContentParts(part.content),
      role: "tool",
      tool_call_id: part.tool_use_id.trim()
    };
  }

  function convertRouteProxyAnthropicAssistantMessageToChatMessages(message) {
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls = [];

    for (const part of content) {
      const toolCall = convertRouteProxyAnthropicToolUseToChatToolCall(part, toolCalls.length);

      if (toolCall) {
        toolCalls.push(toolCall);
      }
    }

    const chatMessage = {
      content: convertRouteProxyAnthropicContentToChatContent(message.content),
      role: "assistant"
    };

    if (toolCalls.length > 0) {
      chatMessage.tool_calls = toolCalls;
    }

    return [chatMessage];
  }

  function convertRouteProxyAnthropicUserMessageToChatMessages(message) {
    if (!Array.isArray(message.content)) {
      return [
        {
          content: convertRouteProxyAnthropicContentToChatContent(message.content),
          role: "user"
        }
      ];
    }

    const messages = [];
    let userContentParts = [];
    const flushUserContentParts = () => {
      if (userContentParts.length === 0) {
        return;
      }

      messages.push({
        content: convertRouteProxyAnthropicContentToChatContent(userContentParts),
        role: "user"
      });
      userContentParts = [];
    };

    for (const part of message.content) {
      const toolMessage = convertRouteProxyAnthropicToolResultToChatToolMessage(part);

      if (toolMessage) {
        flushUserContentParts();
        messages.push(toolMessage);
        continue;
      }

      userContentParts.push(part);
    }

    flushUserContentParts();

    return messages;
  }

  function convertRouteProxyAnthropicMessageToChatMessages(message) {
    if (!message || typeof message !== "object") {
      return [];
    }

    const role = ["assistant", "system", "user"].includes(message.role) ? message.role : "user";

    if (role === "assistant") {
      return convertRouteProxyAnthropicAssistantMessageToChatMessages(message);
    }

    if (role === "user") {
      return convertRouteProxyAnthropicUserMessageToChatMessages(message);
    }

    return [
      {
        content: convertRouteProxyAnthropicContentToChatContent(message.content),
        role
      }
    ];
  }

  function convertRouteProxyAnthropicMessagesToChatMessages(anthropicBody) {
    const messages = [];
    const systemContent = convertRouteProxyAnthropicSystemToChatContent(anthropicBody.system);

    if (systemContent) {
      messages.push({
        content: systemContent,
        role: "system"
      });
    }

    if (Array.isArray(anthropicBody.messages)) {
      for (const message of anthropicBody.messages) {
        messages.push(...convertRouteProxyAnthropicMessageToChatMessages(message));
      }
    }

    if (messages.length === 0) {
      messages.push({
        content: "",
        role: "user"
      });
    }

    return messages;
  }

  function convertRouteProxyAnthropicToolToChatTool(tool) {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name.trim()) {
      return undefined;
    }

    if (!tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema)) {
      return undefined;
    }

    const convertedTool = {
      type: "function",
      function: {
        name: tool.name.trim(),
        parameters: tool.input_schema
      }
    };

    if (typeof tool.description === "string" && tool.description.trim()) {
      convertedTool.function.description = tool.description;
    }

    if (typeof tool.strict === "boolean") {
      convertedTool.function.strict = tool.strict;
    }

    return convertedTool;
  }

  function convertRouteProxyAnthropicToolsToChatTools(tools) {
    if (!Array.isArray(tools)) {
      return [];
    }

    return tools.map(convertRouteProxyAnthropicToolToChatTool).filter(Boolean);
  }

  function convertRouteProxyAnthropicToolChoiceToChatToolChoice(toolChoice) {
    if (!toolChoice || typeof toolChoice !== "object") {
      return undefined;
    }

    if (toolChoice.type === "auto") {
      return "auto";
    }

    if (toolChoice.type === "none") {
      return "none";
    }

    if (toolChoice.type === "any") {
      return "required";
    }

    if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string" || !toolChoice.name.trim()) {
      return undefined;
    }

    return {
      type: "function",
      function: {
        name: toolChoice.name.trim()
      }
    };
  }

  function shouldDisableRouteProxyAnthropicParallelToolCalls(toolChoice) {
    return Boolean(toolChoice && typeof toolChoice === "object" && toolChoice.disable_parallel_tool_use === true);
  }

  function createRouteProxyChatCompletionsBodyFromAnthropicMessages(anthropicBody) {
    const chatBody = {
      messages: convertRouteProxyAnthropicMessagesToChatMessages(anthropicBody),
      stream: anthropicBody.stream === true
    };
    const copiedFields = ["model", "temperature", "top_p"];

    for (const field of copiedFields) {
      if (anthropicBody[field] !== undefined) {
        chatBody[field] = anthropicBody[field];
      }
    }

    if (Number.isFinite(anthropicBody.max_tokens)) {
      chatBody.max_tokens = Math.trunc(anthropicBody.max_tokens);
    }

    if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length > 0) {
      chatBody.stop = anthropicBody.stop_sequences;
    }

    if (anthropicBody.metadata && typeof anthropicBody.metadata === "object") {
      const userId = anthropicBody.metadata.user_id;

      if (typeof userId === "string" && userId) {
        chatBody.user = userId;
      }
    }

    const convertedTools = convertRouteProxyAnthropicToolsToChatTools(anthropicBody.tools);

    if (convertedTools.length > 0) {
      chatBody.tools = convertedTools;

      const convertedToolChoice = convertRouteProxyAnthropicToolChoiceToChatToolChoice(anthropicBody.tool_choice);

      if (convertedToolChoice !== undefined) {
        chatBody.tool_choice = convertedToolChoice;
      }

      if (shouldDisableRouteProxyAnthropicParallelToolCalls(anthropicBody.tool_choice)) {
        chatBody.parallel_tool_calls = false;
      }
    }

    return chatBody;
  }

  function createRouteProxyProtocolRequest(target, incomingUrl, method, body) {
    if (method !== "POST" || target.providerType !== "openai") {
      return {
        body,
        incomingUrl,
        responseTransform: ""
      };
    }

    if (isRouteProxyResponsesRequestPath(incomingUrl)) {
      if (shouldUseRouteProxyResponsesApi(target)) {
        return {
          body,
          incomingUrl,
          responseTransform: ""
        };
      }

      const responsesBody = parseRouteProxyJsonBody(body);

      if (!responsesBody || typeof responsesBody !== "object") {
        return {
          clientError: "Responses conversion requires a JSON request body."
        };
      }

      return {
        body: Buffer.from(JSON.stringify(createRouteProxyChatCompletionsBodyFromResponses(responsesBody)), "utf8"),
        incomingUrl: replaceRouteProxyResponsesPathWithChatCompletions(incomingUrl),
        requestModel: typeof responsesBody.model === "string" ? responsesBody.model : "",
        responseTransform:
          responsesBody.stream === true
            ? "chat-completions-stream-to-responses-stream"
            : "chat-completions-to-responses"
      };
    }

    if (isRouteProxyAnthropicMessagesRequestPath(incomingUrl)) {
      const anthropicBody = parseRouteProxyJsonBody(body);

      if (!anthropicBody || typeof anthropicBody !== "object") {
        return {
          clientError: "Anthropic Messages conversion requires a JSON request body."
        };
      }

      return {
        body: Buffer.from(JSON.stringify(createRouteProxyChatCompletionsBodyFromAnthropicMessages(anthropicBody)), "utf8"),
        incomingUrl: replaceRouteProxyAnthropicMessagesPathWithChatCompletions(incomingUrl),
        requestModel: typeof anthropicBody.model === "string" ? anthropicBody.model : "",
        responseTransform:
          anthropicBody.stream === true
            ? "chat-completions-stream-to-anthropic-messages-stream"
            : "chat-completions-to-anthropic-messages"
      };
    }

    return {
      body,
      incomingUrl,
      responseTransform: ""
    };
  }

  function extractRouteProxyTextFromContentParts(content) {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (!part || typeof part !== "object") {
          return "";
        }

        if (typeof part.text === "string") {
          return part.text;
        }

        if (typeof part.content === "string") {
          return part.content;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  function normalizeRouteProxyConvertedMetadataText(value, fallback = "") {
    const normalizedValue = typeof value === "string" && value.trim() ? value.trim() : fallback;

    return String(normalizedValue || "").slice(0, maxRouteProxyConvertedMetadataLength);
  }

  function normalizeRouteProxyConvertedRole(value) {
    const normalizedRole = normalizeRouteProxyConvertedMetadataText(value, "assistant").toLowerCase();

    return ["assistant", "system", "tool", "user"].includes(normalizedRole) ? normalizedRole : "assistant";
  }

  function normalizeRouteProxyConvertedTokenCount(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue) || numericValue < 0) {
      return undefined;
    }

    return Math.min(Math.trunc(numericValue), maxRouteProxyConvertedUsageTokenCount);
  }

  function normalizeRouteProxyConvertedResponsesUsage(usage) {
    if (!usage || typeof usage !== "object") {
      return undefined;
    }

    const convertedUsage = {};
    const inputTokens = normalizeRouteProxyConvertedTokenCount(usage.input_tokens ?? usage.prompt_tokens);
    const outputTokens = normalizeRouteProxyConvertedTokenCount(usage.output_tokens ?? usage.completion_tokens);
    const totalTokens = normalizeRouteProxyConvertedTokenCount(
      usage.total_tokens ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
    );

    if (inputTokens !== undefined) {
      convertedUsage.input_tokens = inputTokens;
    }

    if (outputTokens !== undefined) {
      convertedUsage.output_tokens = outputTokens;
    }

    if (totalTokens !== undefined) {
      convertedUsage.total_tokens = totalTokens;
    }

    return Object.keys(convertedUsage).length > 0 ? convertedUsage : undefined;
  }

  function normalizeRouteProxyFunctionCallArguments(value) {
    if (typeof value === "string") {
      return value;
    }

    if (value && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return "";
      }
    }

    return "";
  }

  function createRouteProxyResponsesFunctionCallItem(toolCall, index) {
    if (!toolCall || typeof toolCall !== "object") {
      return undefined;
    }

    const functionCall = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : {};
    const functionName = typeof functionCall.name === "string" && functionCall.name.trim() ? functionCall.name.trim() : "";

    if (!functionName) {
      return undefined;
    }

    const callId = typeof toolCall.id === "string" && toolCall.id.trim() ? toolCall.id.trim() : `call_${index}`;

    return {
      arguments: normalizeRouteProxyFunctionCallArguments(functionCall.arguments),
      call_id: callId,
      name: functionName,
      status: "completed",
      type: "function_call"
    };
  }

  function createRouteProxyResponsesFunctionCallOutputItems(message) {
    const outputItems = [];

    if (Array.isArray(message?.tool_calls)) {
      for (let index = 0; index < message.tool_calls.length; index += 1) {
        const toolCall = message.tool_calls[index];

        if (toolCall?.type && toolCall.type !== "function") {
          continue;
        }

        const outputItem = createRouteProxyResponsesFunctionCallItem(toolCall, outputItems.length);

        if (outputItem) {
          outputItems.push(outputItem);
        }
      }
    }

    if (
      outputItems.length === 0 &&
      message?.function_call &&
      typeof message.function_call === "object" &&
      typeof message.function_call.name === "string"
    ) {
      const outputItem = createRouteProxyResponsesFunctionCallItem(
        {
          function: message.function_call,
          id: "call_0",
          type: "function"
        },
        0
      );

      if (outputItem) {
        outputItems.push(outputItem);
      }
    }

    return outputItems;
  }

  function createRouteProxyResponsesMessageOutputItem(outputText, role) {
    return {
      content: [
        {
          annotations: [],
          text: outputText,
          type: "output_text"
        }
      ],
      id: "msg_0",
      role: normalizeRouteProxyConvertedRole(role),
      status: "completed",
      type: "message"
    };
  }

  function createRouteProxyResponsesResponsePayload({
    createdAt,
    functionCalls = [],
    id,
    includeOutput = true,
    model,
    orderedOutputItems,
    outputText,
    role = "assistant",
    status = "completed",
    usage
  }) {
    const response = {
      created_at: Number.isFinite(createdAt) ? createdAt : Math.floor(Date.now() / 1000),
      id: normalizeRouteProxyConvertedMetadataText(id, `resp_${Date.now()}`),
      model: normalizeRouteProxyConvertedMetadataText(model),
      object: "response",
      output: [],
      output_text: outputText,
      status
    };

    if (includeOutput) {
      if (Array.isArray(orderedOutputItems)) {
        response.output.push(...orderedOutputItems);
      } else {
        if (outputText || functionCalls.length === 0) {
          response.output.push(createRouteProxyResponsesMessageOutputItem(outputText, role));
        }

        response.output.push(...functionCalls);
      }
    }

    const normalizedUsage = normalizeRouteProxyConvertedResponsesUsage(usage);

    if (normalizedUsage) {
      response.usage = normalizedUsage;
    }

    return response;
  }

  function convertRouteProxyChatCompletionsResponseToResponses(upstreamJson, requestModel) {
    const choices = Array.isArray(upstreamJson?.choices) ? upstreamJson.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === "object" ? choices[0] : {};
    const message = firstChoice.message && typeof firstChoice.message === "object" ? firstChoice.message : {};
    const outputText = extractRouteProxyTextFromContentParts(message.content).trim();
    const model = typeof upstreamJson?.model === "string" && upstreamJson.model ? upstreamJson.model : requestModel;

    return createRouteProxyResponsesResponsePayload({
      createdAt: upstreamJson?.created,
      id: upstreamJson?.id,
      functionCalls: createRouteProxyResponsesFunctionCallOutputItems(message),
      model,
      outputText,
      role: message.role,
      usage: upstreamJson?.usage
    });
  }

  function mapRouteProxyChatCompletionsFinishReasonToAnthropicStopReason(finishReason) {
    if (finishReason === "length") {
      return "max_tokens";
    }

    if (finishReason === "tool_calls") {
      return "tool_use";
    }

    if (finishReason === "stop") {
      return "end_turn";
    }

    return "end_turn";
  }

  function convertRouteProxyChatCompletionsUsageToAnthropicUsage(usage) {
    if (!usage || typeof usage !== "object") {
      return undefined;
    }

    const convertedUsage = {};

    const inputTokens = normalizeRouteProxyConvertedTokenCount(usage.prompt_tokens ?? usage.input_tokens);
    const outputTokens = normalizeRouteProxyConvertedTokenCount(usage.completion_tokens ?? usage.output_tokens);

    if (inputTokens !== undefined) {
      convertedUsage.input_tokens = inputTokens;
    }

    if (outputTokens !== undefined) {
      convertedUsage.output_tokens = outputTokens;
    }

    return Object.keys(convertedUsage).length > 0 ? convertedUsage : undefined;
  }

  function parseRouteProxyAnthropicToolUseInput(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      try {
        const parsedValue = JSON.parse(value);

        if (parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)) {
          return parsedValue;
        }
      } catch {
        return {};
      }
    }

    return {};
  }

  function createRouteProxyAnthropicToolUseContentBlock(toolCall, index) {
    if (!toolCall || typeof toolCall !== "object") {
      return undefined;
    }

    const functionCall = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : {};
    const functionName = typeof functionCall.name === "string" && functionCall.name.trim() ? functionCall.name.trim() : "";

    if (!functionName) {
      return undefined;
    }

    return {
      id: typeof toolCall.id === "string" && toolCall.id.trim() ? toolCall.id.trim() : `toolu_${index}`,
      input: parseRouteProxyAnthropicToolUseInput(functionCall.arguments),
      name: functionName,
      type: "tool_use"
    };
  }

  function createRouteProxyAnthropicToolUseContentBlocks(message) {
    const contentBlocks = [];

    if (Array.isArray(message?.tool_calls)) {
      for (let index = 0; index < message.tool_calls.length; index += 1) {
        const toolCall = message.tool_calls[index];

        if (toolCall?.type && toolCall.type !== "function") {
          continue;
        }

        const contentBlock = createRouteProxyAnthropicToolUseContentBlock(toolCall, contentBlocks.length);

        if (contentBlock) {
          contentBlocks.push(contentBlock);
        }
      }
    }

    if (
      contentBlocks.length === 0 &&
      message?.function_call &&
      typeof message.function_call === "object" &&
      typeof message.function_call.name === "string"
    ) {
      const contentBlock = createRouteProxyAnthropicToolUseContentBlock(
        {
          function: message.function_call,
          id: "toolu_0",
          type: "function"
        },
        0
      );

      if (contentBlock) {
        contentBlocks.push(contentBlock);
      }
    }

    return contentBlocks;
  }

  function convertRouteProxyChatCompletionsResponseToAnthropicMessages(upstreamJson, requestModel) {
    const choices = Array.isArray(upstreamJson?.choices) ? upstreamJson.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === "object" ? choices[0] : {};
    const message = firstChoice.message && typeof firstChoice.message === "object" ? firstChoice.message : {};
    const outputText = extractRouteProxyTextFromContentParts(message.content).trim();
    const toolUseContentBlocks = createRouteProxyAnthropicToolUseContentBlocks(message);
    const content = [];

    if (outputText || toolUseContentBlocks.length === 0) {
      content.push({
        text: outputText,
        type: "text"
      });
    }

    content.push(...toolUseContentBlocks);

    const response = {
      content,
      id: normalizeRouteProxyConvertedMetadataText(upstreamJson?.id, `msg_${Date.now()}`),
      model: normalizeRouteProxyConvertedMetadataText(upstreamJson?.model, requestModel),
      role: "assistant",
      stop_reason: mapRouteProxyChatCompletionsFinishReasonToAnthropicStopReason(firstChoice.finish_reason),
      stop_sequence: null,
      type: "message"
    };
    const usage = convertRouteProxyChatCompletionsUsageToAnthropicUsage(upstreamJson?.usage);

    if (usage) {
      response.usage = usage;
    }

    return response;
  }

  function parseRouteProxySseBlock(block) {
    const lines = String(block ?? "").split("\n");
    const dataLines = [];
    let eventType = "";

    for (const line of lines) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    return {
      data: dataLines.join("\n"),
      eventType
    };
  }

  function extractRouteProxySseBlocks(buffer) {
    const normalizedBuffer = String(buffer ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalizedBuffer.split("\n\n");

    return {
      blocks: parts.slice(0, -1),
      pending: parts[parts.length - 1] ?? ""
    };
  }

  function isRouteProxySseDone(data, eventType) {
    return data.trim() === "[DONE]" || eventType === "done";
  }

  function extractRouteProxyChatCompletionsStreamChoice(value) {
    const choices = Array.isArray(value?.choices) ? value.choices : [];
    return choices[0] && typeof choices[0] === "object" ? choices[0] : {};
  }

  function extractRouteProxyChatCompletionsStreamDelta(value) {
    const choice = extractRouteProxyChatCompletionsStreamChoice(value);
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
    const content = extractRouteProxyTextFromContentParts(delta.content);

    if (content) {
      return content;
    }

    if (typeof delta.text === "string") {
      return delta.text;
    }

    if (typeof choice.text === "string") {
      return choice.text;
    }

    return "";
  }

  function extractRouteProxyChatCompletionsStreamRole(value) {
    const choice = extractRouteProxyChatCompletionsStreamChoice(value);
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};

    if (typeof delta.role === "string" && delta.role) {
      return delta.role;
    }

    if (choice.message && typeof choice.message === "object" && typeof choice.message.role === "string") {
      return choice.message.role;
    }

    return "";
  }

  function extractRouteProxyChatCompletionsStreamToolCallDeltas(value) {
    const choice = extractRouteProxyChatCompletionsStreamChoice(value);
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};

    if (!Array.isArray(delta.tool_calls)) {
      return [];
    }

    return delta.tool_calls.filter((toolCallDelta) => toolCallDelta && typeof toolCallDelta === "object");
  }

  function getRouteProxyToolCallDeltaIndex(toolCallDelta, fallbackIndex) {
    return Number.isInteger(toolCallDelta?.index) && toolCallDelta.index >= 0 ? toolCallDelta.index : fallbackIndex;
  }

  function getRouteProxyToolCallDeltaFunction(toolCallDelta) {
    return toolCallDelta?.function && typeof toolCallDelta.function === "object" ? toolCallDelta.function : {};
  }

  function updateRouteProxyStreamToolCallState(state, toolCallDelta) {
    const functionDelta = getRouteProxyToolCallDeltaFunction(toolCallDelta);

    if (typeof toolCallDelta.id === "string" && toolCallDelta.id.trim()) {
      state.callId = toolCallDelta.id.trim();
      state.itemId = toolCallDelta.id.trim();
    }

    if (typeof functionDelta.name === "string" && functionDelta.name.trim()) {
      state.name = functionDelta.name.trim();
    }

    return typeof functionDelta.arguments === "string" ? functionDelta.arguments : "";
  }

  function normalizeRouteProxyStreamToolCallState(state, idPrefix) {
    if (!state.callId) {
      state.callId = `${idPrefix}_${state.index}`;
    }

    if (!state.itemId) {
      state.itemId = state.callId;
    }

    if (!state.name) {
      state.name = `function_${state.index}`;
    }

    return state;
  }

  function writeRouteProxyResponsesSseEvent(nodeResponse, eventName, payload) {
    nodeResponse.write(`event: ${eventName}\n`);
    nodeResponse.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function writeRouteProxyAnthropicSseEvent(nodeResponse, eventName, payload) {
    nodeResponse.write(`event: ${eventName}\n`);
    nodeResponse.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  async function pipeRouteProxyConvertedResponse(upstreamResponse, nodeResponse, incomingHeaders, transform) {
    const upstreamJson = await readRouteProxyConvertedResponseJson(upstreamResponse);

    nodeResponse.writeHead(upstreamResponse.status, upstreamResponse.statusText, {
      "content-type": "application/json; charset=utf-8",
      ...createRouteProxyCorsHeaders(incomingHeaders)
    });
    nodeResponse.end(JSON.stringify(convertRouteProxyChatCompletionsResponseToResponses(upstreamJson, transform.requestModel)));
  }

  async function pipeRouteProxyConvertedAnthropicMessagesResponse(upstreamResponse, nodeResponse, incomingHeaders, transform) {
    const upstreamJson = await readRouteProxyConvertedResponseJson(upstreamResponse);

    nodeResponse.writeHead(upstreamResponse.status, upstreamResponse.statusText, {
      "content-type": "application/json; charset=utf-8",
      ...createRouteProxyCorsHeaders(incomingHeaders)
    });
    nodeResponse.end(
      JSON.stringify(convertRouteProxyChatCompletionsResponseToAnthropicMessages(upstreamJson, transform.requestModel))
    );
  }

  async function pipeRouteProxyConvertedAnthropicMessagesStreamResponse(
    upstreamResponse,
    nodeResponse,
    incomingHeaders,
    transform
  ) {
    let messageId = `msg_${Date.now()}`;
    let model = transform.requestModel || "";
    let stopReason = "end_turn";
    let usage;
    let messageStarted = false;
    const toolUseStates = new Map();
    let nextContentIndex = 0;
    let textContentIndex;
    let textContentStarted = false;
    let textContentStopped = false;
    let completed = false;

    const getTextContentIndex = () => {
      if (textContentIndex === undefined) {
        textContentIndex = nextContentIndex;
        nextContentIndex += 1;
      }

      return textContentIndex;
    };

    const getOrderedToolUseStates = () =>
      Array.from(toolUseStates.values()).sort((left, right) => left.contentIndex - right.contentIndex);

    const getToolUseState = (toolCallDelta, fallbackIndex) => {
      const index = getRouteProxyToolCallDeltaIndex(toolCallDelta, fallbackIndex);
      let state = toolUseStates.get(index);

      if (!state) {
        state = {
          arguments: "",
          callId: "",
          contentIndex: nextContentIndex,
          index,
          itemId: "",
          name: "",
          started: false,
          stopped: false
        };
        nextContentIndex += 1;
        toolUseStates.set(index, state);
      }

      return state;
    };

    const createToolUseContentBlock = (state) => {
      normalizeRouteProxyStreamToolCallState(state, "toolu");

      return {
        id: state.itemId,
        input: {},
        name: state.name,
        type: "tool_use"
      };
    };

    const emitMessageStart = () => {
      if (messageStarted) {
        return;
      }

      messageStarted = true;
      writeRouteProxyAnthropicSseEvent(nodeResponse, "message_start", {
        message: {
          content: [],
          id: messageId,
          model,
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: {
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: 0
          }
        },
        type: "message_start"
      });
    };

    const emitStartedToolUseStops = () => {
      for (const state of getOrderedToolUseStates()) {
        if (!state.started || state.stopped) {
          continue;
        }

        state.stopped = true;
        writeRouteProxyAnthropicSseEvent(nodeResponse, "content_block_stop", {
          index: state.contentIndex,
          type: "content_block_stop"
        });
      }
    };

    const emitTextContentStart = () => {
      if (textContentStarted) {
        return;
      }

      emitMessageStart();
      emitStartedToolUseStops();
      textContentStarted = true;
      writeRouteProxyAnthropicSseEvent(nodeResponse, "content_block_start", {
        content_block: {
          text: "",
          type: "text"
        },
        index: getTextContentIndex(),
        type: "content_block_start"
      });
    };

    const emitTextContentStop = () => {
      if (!textContentStarted || textContentStopped) {
        return;
      }

      textContentStopped = true;
      writeRouteProxyAnthropicSseEvent(nodeResponse, "content_block_stop", {
        index: getTextContentIndex(),
        type: "content_block_stop"
      });
    };

    const emitToolUseStart = (state) => {
      if (state.started) {
        return;
      }

      emitMessageStart();
      emitTextContentStop();
      state.started = true;
      writeRouteProxyAnthropicSseEvent(nodeResponse, "content_block_start", {
        content_block: createToolUseContentBlock(state),
        index: state.contentIndex,
        type: "content_block_start"
      });
    };

    const emitToolUseArgumentDelta = (state, delta) => {
      if (!delta) {
        return;
      }

      emitToolUseStart(state);
      assertRouteProxyConvertedStreamOutputWithinLimit(state.arguments, delta);
      state.arguments += delta;
      writeRouteProxyAnthropicSseEvent(nodeResponse, "content_block_delta", {
        delta: {
          partial_json: delta,
          type: "input_json_delta"
        },
        index: state.contentIndex,
        type: "content_block_delta"
      });
    };

    const emitToolUseStop = (state) => {
      emitToolUseStart(state);

      if (state.stopped) {
        return;
      }

      state.stopped = true;
      writeRouteProxyAnthropicSseEvent(nodeResponse, "content_block_stop", {
        index: state.contentIndex,
        type: "content_block_stop"
      });
    };

    const emitCompleted = () => {
      if (completed) {
        return;
      }

      completed = true;
      const toolUseStatesForCompletion = getOrderedToolUseStates();

      if (!textContentStarted && toolUseStatesForCompletion.length === 0) {
        emitTextContentStart();
      }

      emitTextContentStop();

      for (const state of toolUseStatesForCompletion) {
        emitToolUseStop(state);
      }

      writeRouteProxyAnthropicSseEvent(nodeResponse, "message_delta", {
        delta: {
          stop_reason: stopReason,
          stop_sequence: null
        },
        type: "message_delta",
        usage: {
          output_tokens: usage?.output_tokens ?? 0
        }
      });
      writeRouteProxyAnthropicSseEvent(nodeResponse, "message_stop", {
        type: "message_stop"
      });
    };

    const processSseBlock = (block) => {
      if (completed) {
        return;
      }

      const { data, eventType } = parseRouteProxySseBlock(block);

      if (!data) {
        return;
      }

      if (isRouteProxySseDone(data, eventType)) {
        emitCompleted();
        return;
      }

      let value;

      try {
        value = JSON.parse(data);
      } catch {
        return;
      }

      if (typeof value?.id === "string" && value.id) {
        messageId = normalizeRouteProxyConvertedMetadataText(value.id, messageId);
      }

      if (typeof value?.model === "string" && value.model) {
        model = normalizeRouteProxyConvertedMetadataText(value.model, model);
      }

      const convertedUsage = convertRouteProxyChatCompletionsUsageToAnthropicUsage(value?.usage);

      if (convertedUsage) {
        usage = {
          ...usage,
          ...convertedUsage
        };
      }

      const choice = extractRouteProxyChatCompletionsStreamChoice(value);

      if (choice.finish_reason) {
        stopReason = mapRouteProxyChatCompletionsFinishReasonToAnthropicStopReason(choice.finish_reason);
      }

      const delta = extractRouteProxyChatCompletionsStreamDelta(value);

      if (delta) {
        emitTextContentStart();
        writeRouteProxyAnthropicSseEvent(nodeResponse, "content_block_delta", {
          delta: {
            text: delta,
            type: "text_delta"
          },
          index: getTextContentIndex(),
          type: "content_block_delta"
        });
      }

      const toolCallDeltas = extractRouteProxyChatCompletionsStreamToolCallDeltas(value);

      for (let index = 0; index < toolCallDeltas.length; index += 1) {
        const toolCallDelta = toolCallDeltas[index];
        const state = getToolUseState(toolCallDelta, index);
        const argumentsDelta = updateRouteProxyStreamToolCallState(state, toolCallDelta);

        if (argumentsDelta) {
          emitToolUseArgumentDelta(state, argumentsDelta);
        } else if (state.callId || state.name) {
          emitToolUseStart(state);
        }
      }
    };

    nodeResponse.writeHead(upstreamResponse.status, upstreamResponse.statusText, {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      ...createRouteProxyCorsHeaders(incomingHeaders)
    });

    if (!upstreamResponse.body) {
      emitCompleted();
      nodeResponse.end();
      return;
    }

    const decoder = new TextDecoder();
    const reader = upstreamResponse.body.getReader();
    let pending = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      pending += decoder.decode(value, { stream: true });

      const extracted = extractRouteProxySseBlocks(pending);
      pending = extracted.pending;
      await assertRouteProxyConvertedStreamFragmentsWithinLimit(reader, [...extracted.blocks, pending]);

      for (const block of extracted.blocks) {
        processSseBlock(block);
      }
    }

    pending += decoder.decode();
    await assertRouteProxyConvertedStreamFragmentsWithinLimit(reader, [pending]);

    if (pending.trim()) {
      processSseBlock(pending);
    }

    emitCompleted();
    nodeResponse.end();
  }

  async function pipeRouteProxyConvertedStreamResponse(upstreamResponse, nodeResponse, incomingHeaders, transform) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    let responseId = `resp_${Date.now()}`;
    let createdAt = nowSeconds;
    let model = transform.requestModel || "";
    let outputText = "";
    let role = "assistant";
    let usage;
    const functionCallStates = new Map();
    let nextOutputIndex = 0;
    let textOutputIndex;
    let created = false;
    let completed = false;

    const getTextOutputIndex = () => {
      if (textOutputIndex === undefined) {
        textOutputIndex = nextOutputIndex;
        nextOutputIndex += 1;
      }

      return textOutputIndex;
    };

    const getOrderedFunctionCallStates = () =>
      Array.from(functionCallStates.values()).sort((left, right) => left.outputIndex - right.outputIndex);

    const getFunctionCallState = (toolCallDelta, fallbackIndex) => {
      const index = getRouteProxyToolCallDeltaIndex(toolCallDelta, fallbackIndex);
      let state = functionCallStates.get(index);

      if (!state) {
        state = {
          arguments: "",
          argumentsDone: false,
          callId: "",
          index,
          itemDone: false,
          itemId: "",
          name: "",
          outputIndex: nextOutputIndex,
          started: false
        };
        nextOutputIndex += 1;
        functionCallStates.set(index, state);
      }

      return state;
    };

    const createFunctionCallItem = (state, status = "completed") => {
      normalizeRouteProxyStreamToolCallState(state, "call");

      return {
        arguments: state.arguments,
        call_id: state.callId,
        id: state.itemId,
        name: state.name,
        status,
        type: "function_call"
      };
    };

    const emitFunctionCallAdded = (state) => {
      if (state.started) {
        return;
      }

      emitCreated();
      state.started = true;
      writeRouteProxyResponsesSseEvent(nodeResponse, "response.output_item.added", {
        item: createFunctionCallItem(state, "in_progress"),
        output_index: state.outputIndex,
        type: "response.output_item.added"
      });
    };

    const emitFunctionCallArgumentDelta = (state, delta) => {
      if (!delta) {
        return;
      }

      emitFunctionCallAdded(state);
      assertRouteProxyConvertedStreamOutputWithinLimit(state.arguments, delta);
      state.arguments += delta;
      writeRouteProxyResponsesSseEvent(nodeResponse, "response.function_call_arguments.delta", {
        delta,
        item_id: state.itemId,
        output_index: state.outputIndex,
        type: "response.function_call_arguments.delta"
      });
    };

    const emitFunctionCallDone = (state) => {
      emitFunctionCallAdded(state);

      if (!state.argumentsDone) {
        state.argumentsDone = true;
        writeRouteProxyResponsesSseEvent(nodeResponse, "response.function_call_arguments.done", {
          arguments: state.arguments,
          item_id: state.itemId,
          output_index: state.outputIndex,
          type: "response.function_call_arguments.done"
        });
      }

      if (!state.itemDone) {
        state.itemDone = true;
        writeRouteProxyResponsesSseEvent(nodeResponse, "response.output_item.done", {
          item: createFunctionCallItem(state, "completed"),
          output_index: state.outputIndex,
          type: "response.output_item.done"
        });
      }
    };

    const emitStartedFunctionCallDones = () => {
      for (const state of getOrderedFunctionCallStates()) {
        if (!state.started || state.itemDone) {
          continue;
        }

        emitFunctionCallDone(state);
      }
    };

    const emitCreated = () => {
      if (created) {
        return;
      }

      created = true;
      writeRouteProxyResponsesSseEvent(nodeResponse, "response.created", {
        response: createRouteProxyResponsesResponsePayload({
          createdAt,
          id: responseId,
          includeOutput: false,
          model,
          outputText,
          role,
          status: "in_progress"
        }),
        type: "response.created"
      });
    };

    const emitCompleted = () => {
      if (completed) {
        return;
      }

      emitCreated();
      completed = true;
      const functionCallStatesForCompletion = getOrderedFunctionCallStates();
      const orderedOutputItems = [];

      if (outputText || functionCallStatesForCompletion.length === 0) {
        orderedOutputItems.push({
          item: createRouteProxyResponsesMessageOutputItem(outputText, role),
          outputIndex: getTextOutputIndex()
        });
      }

      for (const state of functionCallStatesForCompletion) {
        orderedOutputItems.push({
          item: createFunctionCallItem(state, "completed"),
          outputIndex: state.outputIndex
        });
      }

      if (outputText || functionCallStatesForCompletion.length === 0) {
        writeRouteProxyResponsesSseEvent(nodeResponse, "response.output_text.done", {
          content_index: 0,
          output_index: getTextOutputIndex(),
          text: outputText,
          type: "response.output_text.done"
        });
      }

      for (const state of functionCallStatesForCompletion) {
        emitFunctionCallDone(state);
      }

      writeRouteProxyResponsesSseEvent(nodeResponse, "response.completed", {
        response: createRouteProxyResponsesResponsePayload({
          createdAt,
          functionCalls: functionCallStatesForCompletion.map((state) => createFunctionCallItem(state, "completed")),
          id: responseId,
          model,
          orderedOutputItems: orderedOutputItems
            .sort((left, right) => left.outputIndex - right.outputIndex)
            .map(({ item }) => item),
          outputText,
          role,
          usage
        }),
        type: "response.completed"
      });
    };

    const processSseBlock = (block) => {
      if (completed) {
        return;
      }

      const { data, eventType } = parseRouteProxySseBlock(block);

      if (!data) {
        return;
      }

      if (isRouteProxySseDone(data, eventType)) {
        emitCompleted();
        return;
      }

      let value;

      try {
        value = JSON.parse(data);
      } catch {
        return;
      }

      if (typeof value?.id === "string" && value.id) {
        responseId = normalizeRouteProxyConvertedMetadataText(value.id, responseId);
      }

      if (Number.isFinite(value?.created)) {
        createdAt = value.created;
      }

      if (typeof value?.model === "string" && value.model) {
        model = normalizeRouteProxyConvertedMetadataText(value.model, model);
      }

      if (value?.usage && typeof value.usage === "object") {
        usage = value.usage;
      }

      const streamedRole = extractRouteProxyChatCompletionsStreamRole(value);

      if (streamedRole) {
        role = normalizeRouteProxyConvertedRole(streamedRole);
      }

      emitCreated();

      const delta = extractRouteProxyChatCompletionsStreamDelta(value);

      if (delta) {
        emitStartedFunctionCallDones();
        assertRouteProxyConvertedStreamOutputWithinLimit(outputText, delta);
        outputText += delta;
        writeRouteProxyResponsesSseEvent(nodeResponse, "response.output_text.delta", {
          content_index: 0,
          delta,
          output_index: getTextOutputIndex(),
          type: "response.output_text.delta"
        });
      }

      const toolCallDeltas = extractRouteProxyChatCompletionsStreamToolCallDeltas(value);

      for (let index = 0; index < toolCallDeltas.length; index += 1) {
        const toolCallDelta = toolCallDeltas[index];
        const state = getFunctionCallState(toolCallDelta, index);
        const argumentsDelta = updateRouteProxyStreamToolCallState(state, toolCallDelta);

        if (argumentsDelta) {
          emitFunctionCallArgumentDelta(state, argumentsDelta);
        } else if (state.callId || state.name) {
          emitFunctionCallAdded(state);
        }
      }
    };

    nodeResponse.writeHead(upstreamResponse.status, upstreamResponse.statusText, {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      ...createRouteProxyCorsHeaders(incomingHeaders)
    });

    if (!upstreamResponse.body) {
      emitCompleted();
      nodeResponse.end();
      return;
    }

    const decoder = new TextDecoder();
    const reader = upstreamResponse.body.getReader();
    let pending = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      pending += decoder.decode(value, { stream: true });

      const extracted = extractRouteProxySseBlocks(pending);
      pending = extracted.pending;
      await assertRouteProxyConvertedStreamFragmentsWithinLimit(reader, [...extracted.blocks, pending]);

      for (const block of extracted.blocks) {
        processSseBlock(block);
      }
    }

    pending += decoder.decode();
    await assertRouteProxyConvertedStreamFragmentsWithinLimit(reader, [pending]);

    if (pending.trim()) {
      processSseBlock(pending);
    }

    emitCompleted();
    nodeResponse.end();
  }

  function readRouteProxyRequestBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalBytes = 0;

      request.on("data", (chunk) => {
        totalBytes += chunk.length;

        if (totalBytes > maxRequestBodyBytes) {
          reject(createRouteProxyHttpError("Request body is too large.", 413, "request_body_too_large"));
          request.destroy();
          return;
        }

        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
      request.on("aborted", () => reject(new Error("Client request aborted.")));
    });
  }

  function writeRouteProxyJsonResponse(response, statusCode, payload, incomingHeaders) {
    if (response.headersSent) {
      response.end();
      return;
    }

    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      ...createRouteProxyCorsHeaders(incomingHeaders)
    });
    response.end(JSON.stringify(payload));
  }

  async function pipeRouteProxyResponse(upstreamResponse, nodeResponse, incomingHeaders, requestMethod) {
    nodeResponse.writeHead(
      upstreamResponse.status,
      upstreamResponse.statusText,
      createRouteProxyResponseHeaders(upstreamResponse.headers, incomingHeaders)
    );

    if (requestMethod === "HEAD" || !upstreamResponse.body) {
      nodeResponse.end();
      return;
    }

    const reader = upstreamResponse.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        nodeResponse.write(Buffer.from(value));
      }
    }

    nodeResponse.end();
  }

  function markRouteProxyRequestResult(ok, errorMessage = "") {
    if (ok) {
      routeProxyStatus.successRequests += 1;
      routeProxyStatus.lastError = "";
    } else {
      routeProxyStatus.failedRequests += 1;
      routeProxyStatus.lastError = errorMessage;
    }
  }

  function getRouteProxyPipeErrorStatusCode(error, upstreamResponse, nodeResponse) {
    if (nodeResponse.headersSent) {
      return nodeResponse.statusCode || upstreamResponse.status || 502;
    }

    const statusCode = getRouteProxyHttpErrorStatusCode(error);

    return statusCode === 500 ? 502 : statusCode;
  }

  async function forwardRouteProxyRequest(runtime, nodeRequest, nodeResponse, method, body, requestLogBase, startedAtMs) {
    const hasBody = method !== "GET" && method !== "HEAD";
    const attemptedIndexes = new Set();
    let attempt = 0;
    let lastError = "No route proxy targets are currently healthy.";
    let lastStatusCode = 503;

    while (attemptedIndexes.size < runtime.targetStates.length) {
      const targetState = selectRouteProxyTargetState(runtime, attemptedIndexes);

      if (!targetState) {
        break;
      }

      attemptedIndexes.add(targetState.index);
      attempt += 1;

      const target = targetState.target;
      const protocolRequest = createRouteProxyProtocolRequest(target, nodeRequest.url || "/", method, body);

      if (protocolRequest.clientError) {
        completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
          attempt,
          error: protocolRequest.clientError,
          errorCode: "protocol_conversion_error",
          ok: false,
          result: "client-error",
          statusCode: 400,
          target,
          targetState
        });
        return {
          error: protocolRequest.clientError,
          ok: false,
          responded: false,
          statusCode: 400
        };
      }

      const targetUrl = buildRouteProxyTargetUrl(
        target.baseUrl,
        target.providerType,
        protocolRequest.incomingUrl || nodeRequest.url || "/"
      );
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), runtime.timeoutMs);
      let upstreamResponse;

      try {
        upstreamResponse = await providerFetch(targetUrl, {
          body: hasBody && protocolRequest.body && protocolRequest.body.length > 0 ? protocolRequest.body : undefined,
          headers: createRouteProxyForwardHeaders(nodeRequest.headers, target),
          method,
          signal: controller.signal
        });
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : "Route proxy request failed.", [
          target.apiKey ?? ""
        ]);

        clearTimeout(timeoutHandle);
        markRouteProxyTargetFailure(runtime, targetState, message);
        completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
          attempt,
          error: message,
          errorCode: "fetch_failed",
          ok: false,
          result: "network-error",
          statusCode: 0,
          target,
          targetState
        });
        lastError = message;
        lastStatusCode = 502;
        continue;
      } finally {
        clearTimeout(timeoutHandle);
      }

      const ok = upstreamResponse.ok;
      const errorMessage = ok ? "" : `HTTP ${upstreamResponse.status}`;
      const canRetry =
        shouldRetryRouteProxyResponse(upstreamResponse.status) && attemptedIndexes.size < runtime.targetStates.length;

      if (canRetry) {
        try {
          await upstreamResponse.body?.cancel();
        } catch {
          // Ignore upstream body cancellation failures while moving to the next target.
        }

        markRouteProxyTargetFailure(runtime, targetState, errorMessage);
        completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
          attempt,
          error: errorMessage,
          ok: false,
          statusCode: upstreamResponse.status,
          target,
          targetState
        });
        lastError = errorMessage;
        lastStatusCode = upstreamResponse.status;
        continue;
      }

      if (ok) {
        markRouteProxyTargetSuccess(runtime, targetState);
      } else if (shouldRetryRouteProxyResponse(upstreamResponse.status)) {
        markRouteProxyTargetFailure(runtime, targetState, errorMessage);
      } else {
        runtime.activeTargetIndex = targetState.index;
        updateRouteProxyStatusTarget(target);
        refreshRouteProxyStatusTargetHealth(runtime);
      }

      try {
        if (protocolRequest.responseTransform === "chat-completions-to-responses" && ok) {
          await pipeRouteProxyConvertedResponse(upstreamResponse, nodeResponse, nodeRequest.headers, protocolRequest);
        } else if (protocolRequest.responseTransform === "chat-completions-stream-to-responses-stream" && ok) {
          await pipeRouteProxyConvertedStreamResponse(upstreamResponse, nodeResponse, nodeRequest.headers, protocolRequest);
        } else if (protocolRequest.responseTransform === "chat-completions-to-anthropic-messages" && ok) {
          await pipeRouteProxyConvertedAnthropicMessagesResponse(
            upstreamResponse,
            nodeResponse,
            nodeRequest.headers,
            protocolRequest
          );
        } else if (protocolRequest.responseTransform === "chat-completions-stream-to-anthropic-messages-stream" && ok) {
          await pipeRouteProxyConvertedAnthropicMessagesStreamResponse(
            upstreamResponse,
            nodeResponse,
            nodeRequest.headers,
            protocolRequest
          );
        } else {
          await pipeRouteProxyResponse(upstreamResponse, nodeResponse, nodeRequest.headers, method);
        }
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : "Route proxy stream failed.", [
          target.apiKey ?? ""
        ]);
        const statusCode = getRouteProxyPipeErrorStatusCode(error, upstreamResponse, nodeResponse);

        if (shouldRetryRouteProxyResponse(upstreamResponse.status)) {
          markRouteProxyTargetFailure(runtime, targetState, message);
        }

        completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
          attempt,
          error: message,
          errorCode: "stream_failed",
          ok: false,
          result: "proxy-error",
          statusCode,
          target,
          targetState
        });

        if (nodeResponse.headersSent && !nodeResponse.writableEnded) {
          nodeResponse.end();
        }

        return {
          error: message,
          ok: false,
          responded: nodeResponse.headersSent,
          statusCode
        };
      }

      completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
        attempt,
        error: errorMessage,
        ok,
        statusCode: upstreamResponse.status,
        target,
        targetState
      });

      return {
        error: errorMessage,
        ok,
        responded: true,
        statusCode: upstreamResponse.status
      };
    }

    return {
      error: lastError,
      ok: false,
      responded: false,
      statusCode: lastStatusCode
    };
  }

  async function handleRouteProxyRequest(nodeRequest, nodeResponse) {
    const runtime = routeProxyRuntime;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const requestLogBase = createRouteProxyRequestLogBase(nodeRequest, startedAt);

    routeProxyStatus.activeConnections += 1;
    routeProxyStatus.totalRequests += 1;
    routeProxyStatus.lastRequestAt = startedAt;

    try {
      if (!runtime) {
        markRouteProxyRequestResult(false, "Proxy is not running.");
        completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
          error: "Proxy is not running.",
          errorCode: "proxy_not_running",
          ok: false,
          result: "proxy-error",
          statusCode: 503
        });
        writeRouteProxyJsonResponse(
          nodeResponse,
          503,
          {
            error: "Route proxy is not running."
          },
          nodeRequest.headers
        );
        return;
      }

      const method = String(nodeRequest.method || "GET").toUpperCase();

      if (method === "OPTIONS") {
        markRouteProxyRequestResult(true);
        completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
          error: "",
          ok: true,
          result: "success",
          statusCode: 204
        });
        nodeResponse.writeHead(204, createRouteProxyCorsHeaders(nodeRequest.headers));
        nodeResponse.end();
        return;
      }

      const hasBody = method !== "GET" && method !== "HEAD";
      if (hasBody) {
        assertRouteProxyRequestBodyWithinLimit(nodeRequest);
      }
      const body = hasBody ? await readRouteProxyRequestBody(nodeRequest) : undefined;
      const forwardResult = await forwardRouteProxyRequest(
        runtime,
        nodeRequest,
        nodeResponse,
        method,
        body,
        requestLogBase,
        startedAtMs
      );

      markRouteProxyRequestResult(forwardResult.ok, forwardResult.ok ? "" : forwardResult.error);

      if (!forwardResult.responded) {
        writeRouteProxyJsonResponse(
          nodeResponse,
          forwardResult.statusCode || 502,
          {
            error: forwardResult.error || "Route proxy request failed."
          },
          nodeRequest.headers
        );
      }
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : "Route proxy request failed.", [
        ...getRouteProxyRuntimeSecrets(runtime)
      ]);
      const statusCode = getRouteProxyHttpErrorStatusCode(error);
      markRouteProxyRequestResult(false, message);
      completeRouteProxyRequestLog(requestLogBase, startedAtMs, {
        error: message,
        errorCode: getRouteProxyHttpErrorCode(error),
        ok: false,
        result: "proxy-error",
        statusCode
      });
      writeRouteProxyJsonResponse(
        nodeResponse,
        statusCode,
        {
          error: message
        },
        nodeRequest.headers
      );
    } finally {
      routeProxyStatus.activeConnections = Math.max(0, routeProxyStatus.activeConnections - 1);
    }
  }

  async function startRouteProxy(request) {
    const normalizedRequest = normalizeRouteProxyStartRequest(request);

    if (routeProxyServer) {
      await stopRouteProxy();
    }

    const server = http.createServer((nodeRequest, nodeResponse) => {
      void handleRouteProxyRequest(nodeRequest, nodeResponse);
    });

    await new Promise((resolve, reject) => {
      const rejectStart = (error) => {
        server.off("listening", resolveStart);
        reject(error);
      };
      const resolveStart = () => {
        server.off("error", rejectStart);
        resolve();
      };

      server.once("error", rejectStart);
      server.once("listening", resolveStart);
      server.listen(normalizedRequest.listenPort, normalizedRequest.listenAddress);
    }).catch((error) => {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : "Route proxy start failed.", [
        ...normalizedRequest.targets.map((target) => target.apiKey).filter(Boolean)
      ]);
      throw new Error(message);
    });

    const addressInfo = server.address();
    const actualAddress =
      addressInfo && typeof addressInfo === "object" ? addressInfo.address : normalizedRequest.listenAddress;
    const actualPort = addressInfo && typeof addressInfo === "object" ? addressInfo.port : normalizedRequest.listenPort;

    routeProxyServer = server;
    routeProxyRuntime = {
      activeTargetIndex: 0,
      cooldownMs: normalizedRequest.cooldownMs,
      failureThreshold: normalizedRequest.failureThreshold,
      nextWeightedTargetOffset: 0,
      profileId: normalizedRequest.profileId,
      routingMode: normalizedRequest.routingMode,
      targetStates: normalizedRequest.targets.map((target, index) => createRouteProxyTargetState(target, index)),
      targets: normalizedRequest.targets,
      timeoutMs: normalizedRequest.timeoutMs,
      weightedTargetIndexes: []
    };
    routeProxyRuntime.weightedTargetIndexes = createRouteProxyWeightedTargetIndexes(routeProxyRuntime.targetStates);
    routeProxyStatus = createRouteProxyStatus({
      address: actualAddress,
      cooldownMs: normalizedRequest.cooldownMs,
      failureThreshold: normalizedRequest.failureThreshold,
      port: actualPort,
      proxyUrl: createRouteProxyUrl(actualAddress, actualPort),
      routingMode: normalizedRequest.routingMode,
      running: true,
      startedAt: new Date().toISOString(),
      targetBaseUrl: normalizedRequest.target.baseUrl,
      targetCount: normalizedRequest.targets.length,
      targetConfigId: normalizedRequest.target.configId,
      targetHealth: getRouteProxyTargetHealthSnapshot(routeProxyRuntime),
      targetName: normalizedRequest.target.configName
    });

    server.on("error", (error) => {
      routeProxyStatus.lastError = sanitizeSensitiveText(error instanceof Error ? error.message : String(error), [
        ...getRouteProxyRuntimeSecrets(routeProxyRuntime)
      ]);
    });

    return getRouteProxyStatusSnapshot();
  }

  async function stopRouteProxy() {
    const server = routeProxyServer;

    if (!server) {
      routeProxyStatus = createRouteProxyStatus({
        ...routeProxyStatus,
        activeConnections: 0,
        running: false
      });
      routeProxyRuntime = undefined;

      return getRouteProxyStatusSnapshot();
    }

    routeProxyServer = undefined;
    routeProxyRuntime = undefined;

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Route proxy stop failed.";
      throw new Error(message);
    });

    routeProxyStatus = createRouteProxyStatus({
      ...routeProxyStatus,
      activeConnections: 0,
      running: false
    });

    return getRouteProxyStatusSnapshot();
  }

  function closeRouteProxy() {
    if (routeProxyServer) {
      routeProxyServer.close();
      routeProxyServer = undefined;
      routeProxyRuntime = undefined;
      routeProxyStatus = createRouteProxyStatus({
        ...routeProxyStatus,
        activeConnections: 0,
        running: false
      });
    }
  }

  return {
    clearRequestLogs: clearRouteProxyRequestLogs,
    close: closeRouteProxy,
    getDefaultConfig: () => ({
      listenAddress: defaultRouteProxyListenAddress,
      listenPort: defaultRouteProxyListenPort
    }),
    flushDiagnostics: flushRouteProxyDiagnostics,
    getRequestLogs: getRouteProxyRequestLogsSnapshot,
    getStatus: getRouteProxyStatusSnapshot,
    start: startRouteProxy,
    stop: stopRouteProxy
  };
}

function assertString(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
}

function normalizeOpenAiEndpointMode(endpointMode) {
  const normalizedEndpointMode = typeof endpointMode === "string" ? endpointMode : "auto";

  if (!["auto", "chat-completions", "responses"].includes(normalizedEndpointMode)) {
    throw new Error("Unsupported OpenAI endpoint mode.");
  }

  return normalizedEndpointMode;
}

const ignoredRouteProxyRequestHeaders = new Set([
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "authorization",
  "cookie",
  "cookie2",
  "connection",
  "content-length",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "referrer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "x-goog-api-key",
  "goog-api-key",
  "google-api-key",
  "ocp-apim-subscription-key",
  "subscription-key",
  "x-api-key",
  "api-key",
  "anthropic-version"
]);

function shouldIgnoreRouteProxyRequestHeader(headerName) {
  const normalizedHeaderName = String(headerName || "").toLowerCase();

  return (
    ignoredRouteProxyRequestHeaders.has(normalizedHeaderName) ||
    normalizedHeaderName.startsWith("proxy-") ||
    normalizedHeaderName.startsWith("sec-")
  );
}

function shouldForwardRouteProxyRequestHeader(headerName, headerValue, forwardedHeaderCount) {
  const normalizedHeaderName = String(headerName || "").toLowerCase();
  const normalizedHeaderValue = String(headerValue || "");

  return (
    forwardedHeaderCount < maxRouteProxyForwardRequestHeaderCount &&
    normalizedHeaderName.length <= maxRouteProxyForwardRequestHeaderNameLength &&
    normalizedHeaderValue.length <= maxRouteProxyForwardRequestHeaderValueLength &&
    routeProxyHeaderNamePattern.test(normalizedHeaderName) &&
    !shouldIgnoreRouteProxyRequestHeader(normalizedHeaderName) &&
    normalizedHeaderValue.length > 0
  );
}

const defaultRouteProxyCorsAllowedRequestHeaders = [
  "authorization",
  "content-type",
  "x-api-key",
  "api-key",
  "anthropic-version"
];

const defaultRouteProxyCorsAllowedRequestHeadersText = defaultRouteProxyCorsAllowedRequestHeaders.join(",");

const defaultRouteProxyCorsAllowedRequestHeaderSet = new Set(defaultRouteProxyCorsAllowedRequestHeaders);

const maxRouteProxyCorsAllowedRequestHeaderCount = 32;
const maxRouteProxyCorsAllowedRequestHeaderNameLength = 128;
const maxRouteProxyCorsAllowedRequestHeadersLength = 2048;
const maxRouteProxyForwardRequestHeaderCount = 64;
const maxRouteProxyForwardRequestHeaderNameLength = 128;
const maxRouteProxyForwardRequestHeaderValueLength = 8192;
const maxRouteProxyForwardRequestQueryParameterCount = 128;
const maxRouteProxyForwardRequestQueryParameterNameLength = 128;
const maxRouteProxyForwardRequestQueryParameterValueLength = 4096;
const maxRouteProxyForwardRequestQueryStringLength = 8192;
const maxRouteProxyForwardResponseHeaderCount = 64;
const maxRouteProxyForwardResponseHeaderNameLength = 128;
const maxRouteProxyForwardResponseHeaderValueLength = 8192;
const maxRouteProxyConvertedMetadataLength = 512;
const maxRouteProxyConvertedUsageTokenCount = 1_000_000_000;

const deniedRouteProxyCorsRequestHeaders = new Set([
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "dnt",
  "expect",
  "goog-api-key",
  "google-api-key",
  "host",
  "keep-alive",
  "ocp-apim-subscription-key",
  "origin",
  "referer",
  "referrer",
  "set-cookie",
  "set-cookie2",
  "subscription-key",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "x-goog-api-key"
]);

const routeProxyHeaderNamePattern = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

function shouldIgnoreRouteProxyCorsRequestHeader(headerName) {
  if (defaultRouteProxyCorsAllowedRequestHeaderSet.has(headerName)) {
    return false;
  }

  return (
    deniedRouteProxyCorsRequestHeaders.has(headerName) ||
    headerName.startsWith("proxy-") ||
    headerName.startsWith("sec-")
  );
}

function normalizeRouteProxyCorsAllowedRequestHeaders(requestedHeaders) {
  if (!requestedHeaders) {
    return defaultRouteProxyCorsAllowedRequestHeadersText;
  }

  const allowedHeaders = [];
  const seenHeaders = new Set();
  let allowedHeadersLength = 0;

  for (const rawHeaderName of String(requestedHeaders).split(",")) {
    const headerName = rawHeaderName.trim().toLowerCase();

    if (
      !headerName ||
      headerName.length > maxRouteProxyCorsAllowedRequestHeaderNameLength ||
      !routeProxyHeaderNamePattern.test(headerName) ||
      shouldIgnoreRouteProxyCorsRequestHeader(headerName) ||
      seenHeaders.has(headerName)
    ) {
      continue;
    }

    const nextAllowedHeadersLength = allowedHeadersLength + (allowedHeaders.length > 0 ? 1 : 0) + headerName.length;

    if (
      allowedHeaders.length >= maxRouteProxyCorsAllowedRequestHeaderCount ||
      nextAllowedHeadersLength > maxRouteProxyCorsAllowedRequestHeadersLength
    ) {
      break;
    }

    allowedHeaders.push(headerName);
    seenHeaders.add(headerName);
    allowedHeadersLength = nextAllowedHeadersLength;
  }

  return allowedHeaders.length > 0 ? allowedHeaders.join(",") : defaultRouteProxyCorsAllowedRequestHeadersText;
}

const ignoredRouteProxyRequestQueryParameters = new Set([
  "access-token",
  "access_token",
  "accesstoken",
  "api-key",
  "api_key",
  "apikey",
  "api-token",
  "api_token",
  "apitoken",
  "apim-subscription-key",
  "apim_subscription_key",
  "apimsubscriptionkey",
  "auth",
  "auth-token",
  "auth_token",
  "authtoken",
  "authorization",
  "azure-subscription-key",
  "azure_subscription_key",
  "azuresubscriptionkey",
  "bearer-token",
  "bearer_token",
  "bearertoken",
  "goog-api-key",
  "goog_api_key",
  "googapikey",
  "google-api-key",
  "google_api_key",
  "googleapikey",
  "client-secret",
  "client_secret",
  "clientsecret",
  "id-token",
  "id_token",
  "idtoken",
  "key",
  "ocp-apim-subscription-key",
  "ocp_apim_subscription_key",
  "ocpapimsubscriptionkey",
  "password",
  "refresh-token",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secret-key",
  "secret_key",
  "secretkey",
  "session",
  "session-token",
  "session_token",
  "sessiontoken",
  "subscription-key",
  "subscription_key",
  "subscriptionkey",
  "token",
  "x-goog-api-key",
  "x_goog_api_key",
  "xgoogapikey",
  "xapikey",
  "x-api-key"
]);

function shouldIgnoreRouteProxyRequestQueryParameter(parameterName) {
  return ignoredRouteProxyRequestQueryParameters.has(String(parameterName || "").toLowerCase());
}

function shouldForwardRouteProxyRequestQueryParameter(parameterName, parameterValue, forwardedParameterCount) {
  const normalizedParameterName = String(parameterName || "");
  const normalizedParameterValue = String(parameterValue || "");

  return (
    forwardedParameterCount < maxRouteProxyForwardRequestQueryParameterCount &&
    normalizedParameterName.length > 0 &&
    normalizedParameterName.length <= maxRouteProxyForwardRequestQueryParameterNameLength &&
    normalizedParameterValue.length <= maxRouteProxyForwardRequestQueryParameterValueLength &&
    !shouldIgnoreRouteProxyRequestQueryParameter(normalizedParameterName)
  );
}

function normalizeRouteProxyForwardRequestSearch(searchParams) {
  const forwardedSearchParams = new URLSearchParams();
  let forwardedParameterCount = 0;

  for (const [name, value] of searchParams.entries()) {
    if (!shouldForwardRouteProxyRequestQueryParameter(name, value, forwardedParameterCount)) {
      continue;
    }

    const candidateSearchParams = new URLSearchParams(forwardedSearchParams);
    candidateSearchParams.append(name, value);

    if (candidateSearchParams.toString().length > maxRouteProxyForwardRequestQueryStringLength) {
      break;
    }

    forwardedSearchParams.append(name, value);
    forwardedParameterCount += 1;
  }

  return forwardedSearchParams.toString();
}

const ignoredRouteProxyResponseHeaders = new Set([
  "api-key",
  "authorization",
  "authentication-info",
  "connection",
  "content-encoding",
  "content-location",
  "content-length",
  "goog-api-key",
  "google-api-key",
  "keep-alive",
  "link",
  "location",
  "ocp-apim-subscription-key",
  "proxy-authenticate",
  "proxy-authentication-info",
  "proxy-authorization",
  "refresh",
  "set-cookie",
  "set-cookie2",
  "subscription-key",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "www-authenticate",
  "x-api-key",
  "x-goog-api-key"
]);

function shouldIgnoreRouteProxyResponseHeader(headerName) {
  const normalizedHeaderName = String(headerName || "").toLowerCase();

  return (
    normalizedHeaderName.startsWith("access-control-") || ignoredRouteProxyResponseHeaders.has(normalizedHeaderName)
  );
}

function shouldForwardRouteProxyResponseHeader(headerName, headerValue, forwardedHeaderCount) {
  const normalizedHeaderName = String(headerName || "").toLowerCase();
  const normalizedHeaderValue = String(headerValue || "");

  return (
    forwardedHeaderCount < maxRouteProxyForwardResponseHeaderCount &&
    normalizedHeaderName.length <= maxRouteProxyForwardResponseHeaderNameLength &&
    normalizedHeaderValue.length <= maxRouteProxyForwardResponseHeaderValueLength &&
    routeProxyHeaderNamePattern.test(normalizedHeaderName) &&
    !shouldIgnoreRouteProxyResponseHeader(normalizedHeaderName)
  );
}

module.exports = {
  createRouteProxyController,
  createRouteProxyTargetHealthSnapshot,
  createRouteProxyTargetState,
  defaultRouteProxyRoutingMode,
  defaultRouteProxyTargetWeight,
  defaultRouteProxyListenAddress,
  defaultRouteProxyListenPort,
  getRouteProxyTargetHealthState,
  maxRouteProxyTargetWeight,
  minRouteProxyTargetWeight
};
