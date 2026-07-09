const { contextBridge, ipcRenderer } = require("electron");

const maxChatContentParts = 12;
const maxChatImageUrlLength = 7_500_000;
const maxChatMessageLength = 12_000;

function assertString(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
}

function sanitizeCopyOptions(options) {
  if (!options || typeof options !== "object") {
    return {};
  }

  return {
    clearAfterMs: Number.isFinite(options.clearAfterMs) ? options.clearAfterMs : undefined
  };
}

function sanitizeTransportCustomHeader(header) {
  if (!header || typeof header !== "object") {
    return null;
  }

  const key = String(header.key ?? "").trim().toLowerCase();

  if (!key) {
    return null;
  }

  const isSecret = header.isSecret === true;

  if (isSecret) {
    const encryptedValue = typeof header.encryptedValue === "string" ? header.encryptedValue : undefined;
    return encryptedValue ? { key, isSecret: true, encryptedValue } : null;
  }

  const plaintextValue = typeof header.plaintextValue === "string" ? header.plaintextValue : undefined;
  return plaintextValue !== undefined ? { key, isSecret: false, plaintextValue } : null;
}

function sanitizeTransportCustomHeaders(customHeaders) {
  if (!Array.isArray(customHeaders)) {
    return undefined;
  }

  const sanitized = customHeaders
    .slice(0, 32)
    .map(sanitizeTransportCustomHeader)
    .filter((h) => h !== null);

  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeConnectionRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object.");
  }

  return {
    authType: request.authType,
    baseUrl: String(request.baseUrl ?? ""),
    endpointMode: String(request.endpointMode ?? "auto"),
    encryptedApiKey: typeof request.encryptedApiKey === "string" ? request.encryptedApiKey : undefined,
    model: String(request.model ?? ""),
    providerId: String(request.providerId ?? ""),
    providerType: String(request.providerType ?? ""),
    thinkingEnabled: request.thinkingEnabled === true,
    timeoutMs: Number.isFinite(request.timeoutMs) ? request.timeoutMs : undefined,
    customHeaders: sanitizeTransportCustomHeaders(request.customHeaders)
  };
}

function sanitizeChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array.");
  }

  return messages.slice(-20).map((message) => {
    if (!message || typeof message !== "object") {
      throw new Error("message must be an object.");
    }

    return {
      content: sanitizeChatMessageContent(message.content),
      role: String(message.role ?? "")
    };
  });
}

function sanitizeChatMessageContent(content) {
  if (Array.isArray(content)) {
    const parts = content
      .slice(0, maxChatContentParts)
      .map((part) => {
        if (!part || typeof part !== "object") {
          return undefined;
        }

        if (part.type === "text") {
          const text = String(part.text ?? "").trim().slice(0, maxChatMessageLength);

          return text
            ? {
                text,
                type: "text"
              }
            : undefined;
        }

        if (part.type === "image") {
          const imageUrl = String(part.imageUrl ?? "").trim();

          if (!isSupportedChatImageUrl(imageUrl)) {
            return undefined;
          }

          return {
            imageUrl: imageUrl.slice(0, maxChatImageUrlLength),
            mimeType: String(part.mimeType ?? "").trim().slice(0, 80),
            name: typeof part.name === "string" ? part.name.trim().slice(0, 180) : undefined,
            type: "image"
          };
        }

        return undefined;
      })
      .filter(Boolean);

    if (parts.length === 0) {
      throw new Error("chat message content must not be empty.");
    }

    return parts;
  }

  return String(content ?? "").trim().slice(0, maxChatMessageLength);
}

function isSupportedChatImageUrl(imageUrl) {
  return (
    imageUrl.length > 0 &&
    imageUrl.length <= maxChatImageUrlLength &&
    (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(imageUrl) || /^https:\/\//i.test(imageUrl))
  );
}

function sanitizeChatRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object.");
  }

  return {
    authType: request.authType,
    baseUrl: String(request.baseUrl ?? ""),
    endpointMode: String(request.endpointMode ?? "auto"),
    encryptedApiKey: typeof request.encryptedApiKey === "string" ? request.encryptedApiKey : undefined,
    messages: sanitizeChatMessages(request.messages),
    model: String(request.model ?? ""),
    providerId: String(request.providerId ?? ""),
    providerType: String(request.providerType ?? ""),
    thinkingEnabled: request.thinkingEnabled === true,
    timeoutMs: Number.isFinite(request.timeoutMs) ? request.timeoutMs : undefined
  };
}

function createChatStreamRequestId() {
  return `chat-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeChatStreamEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      type: "error",
      content: "Invalid stream event."
    };
  }

  const type = ["chunk", "done", "error"].includes(payload.type) ? payload.type : "error";

  return {
    content: typeof payload.content === "string" ? payload.content : undefined,
    latencyMs: Number.isFinite(payload.latencyMs) ? payload.latencyMs : undefined,
    ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
    requestEndpoint: typeof payload.requestEndpoint === "string" ? payload.requestEndpoint : undefined,
    responseText: typeof payload.responseText === "string" ? payload.responseText : undefined,
    status: Number.isFinite(payload.status) ? payload.status : undefined,
    type
  };
}

function streamChatMessage(request, onEvent) {
  if (typeof onEvent !== "function") {
    throw new Error("onEvent must be a function.");
  }

  const requestId = createChatStreamRequestId();
  const channel = "chat:stream-event";
  const listener = (_event, payload) => {
    if (!payload || payload.requestId !== requestId) {
      return;
    }

    const streamEvent = sanitizeChatStreamEvent(payload);
    onEvent(streamEvent);

    if (streamEvent.type === "done" || streamEvent.type === "error") {
      ipcRenderer.removeListener(channel, listener);
    }
  };

  ipcRenderer.on(channel, listener);

  return ipcRenderer
    .invoke("chat:stream-message", {
      ...sanitizeChatRequest(request),
      requestId
    })
    .finally(() => {
      ipcRenderer.removeListener(channel, listener);
    });
}

function sanitizeModelFetchRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object.");
  }

  return {
    apiKey: String(request.apiKey ?? ""),
    authType: request.authType,
    baseUrl: String(request.baseUrl ?? ""),
    encryptedApiKey: typeof request.encryptedApiKey === "string" ? request.encryptedApiKey : undefined,
    providerType: String(request.providerType ?? ""),
    timeoutMs: Number.isFinite(request.timeoutMs) ? request.timeoutMs : undefined
  };
}

function sanitizeRouteProxyTarget(target) {
  if (!target || typeof target !== "object") {
    throw new Error("target must be an object.");
  }

  return {
    authType: target.authType,
    baseUrl: String(target.baseUrl ?? ""),
    configId: String(target.configId ?? ""),
    configName: String(target.configName ?? ""),
    endpointMode: String(target.endpointMode ?? "auto"),
    encryptedApiKey: typeof target.encryptedApiKey === "string" ? target.encryptedApiKey : undefined,
    providerId: String(target.providerId ?? ""),
    providerType: String(target.providerType ?? ""),
    weight: Number.isFinite(target.weight) ? target.weight : undefined
  };
}

function sanitizeRouteProxyStartRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object.");
  }

  const targets = Array.isArray(request.targets) ? request.targets.map((target) => sanitizeRouteProxyTarget(target)) : [];
  const target = sanitizeRouteProxyTarget(request.target ?? targets[0]);

  return {
    cooldownMs: Number.isFinite(request.cooldownMs) ? request.cooldownMs : undefined,
    failureThreshold: Number.isFinite(request.failureThreshold) ? request.failureThreshold : undefined,
    listenAddress: String(request.listenAddress ?? ""),
    listenPort: Number.isFinite(request.listenPort) ? request.listenPort : undefined,
    profileId: String(request.profileId ?? ""),
    routingMode: ["ordered", "weighted"].includes(request.routingMode) ? request.routingMode : undefined,
    target,
    targets: targets.length > 0 ? targets : [target],
    timeoutMs: Number.isFinite(request.timeoutMs) ? request.timeoutMs : undefined
  };
}

function sanitizeRouteProxyDiagnosticsRetention(retention) {
  if (!retention || typeof retention !== "object") {
    return undefined;
  }

  return {
    maxAgeDays: Number.isFinite(retention.maxAgeDays) ? retention.maxAgeDays : undefined,
    maxEntries: Number.isFinite(retention.maxEntries) ? retention.maxEntries : undefined,
    maxTotalBytes: Number.isFinite(retention.maxTotalBytes) ? retention.maxTotalBytes : undefined
  };
}

function sanitizeRouteProxyDiagnosticsQuery(query) {
  if (!query || typeof query !== "object") {
    return {};
  }

  return {
    eventType: ["request", "target-health"].includes(query.eventType) ? query.eventType : undefined,
    limit: Number.isFinite(query.limit) ? query.limit : undefined,
    ok: typeof query.ok === "boolean" ? query.ok : undefined,
    profileId: typeof query.profileId === "string" ? query.profileId : undefined,
    since: typeof query.since === "string" ? query.since : undefined,
    targetConfigId: typeof query.targetConfigId === "string" ? query.targetConfigId : undefined
  };
}

function sanitizeRuntimeInfo(info) {
  if (!info || typeof info !== "object") {
    return {
      appVersion: "",
      electronVersion: "",
      isDev: false,
      userDataPath: ""
    };
  }

  return {
    appVersion: String(info.appVersion ?? "").slice(0, 120),
    electronVersion: String(info.electronVersion ?? "").slice(0, 120),
    isDev: info.isDev === true,
    userDataPath: String(info.userDataPath ?? "").slice(0, 1000)
  };
}

contextBridge.exposeInMainWorld("deskApi", {
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  getRuntimeInfo: () => ipcRenderer.invoke("app:get-runtime-info").then(sanitizeRuntimeInfo),
  secrets: {
    isEncryptionAvailable: () => ipcRenderer.invoke("secret:is-encryption-available"),
    encrypt: (plaintext) => {
      assertString(plaintext, "plaintext");
      return ipcRenderer.invoke("secret:encrypt", plaintext);
    },
    decrypt: (encryptedValue) => {
      assertString(encryptedValue, "encryptedValue");
      return ipcRenderer.invoke("secret:decrypt", encryptedValue);
    },
    copyToClipboard: (plaintext, options) => {
      assertString(plaintext, "plaintext");
      return ipcRenderer.invoke("secret:copy-to-clipboard", plaintext, sanitizeCopyOptions(options));
    }
  },
  clipboard: {
    writeText: (text) => {
      assertString(text, "text");
      return ipcRenderer.invoke("clipboard:write-text", text);
    }
  },
  window: {
    close: () => ipcRenderer.invoke("window:close"),
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize")
  },
  connection: {
    testOpenAiCompatible: (request) =>
      ipcRenderer.invoke("connection:test-openai-compatible", sanitizeConnectionRequest(request))
  },
  chat: {
    sendMessage: (request) => ipcRenderer.invoke("chat:send-message", sanitizeChatRequest(request)),
    streamMessage: (request, onEvent) => streamChatMessage(request, onEvent)
  },
  models: {
    fetchProviderModels: (request) =>
      ipcRenderer.invoke("models:fetch-provider-models", sanitizeModelFetchRequest(request))
  },
  routeProxy: {
    getDefaultConfig: () => ipcRenderer.invoke("route-proxy:get-default-config"),
    getRequestLogs: () => ipcRenderer.invoke("route-proxy:get-request-logs"),
    getStatus: () => ipcRenderer.invoke("route-proxy:get-status"),
    clearRequestLogs: () => ipcRenderer.invoke("route-proxy:clear-request-logs"),
    start: (request) => ipcRenderer.invoke("route-proxy:start", sanitizeRouteProxyStartRequest(request)),
    stop: () => ipcRenderer.invoke("route-proxy:stop"),
    getDiagnosticsManifest: () => ipcRenderer.invoke("route-proxy:diagnostics-get-manifest"),
    enableDiagnostics: (retention) =>
      ipcRenderer.invoke("route-proxy:diagnostics-enable", sanitizeRouteProxyDiagnosticsRetention(retention)),
    disableDiagnostics: () => ipcRenderer.invoke("route-proxy:diagnostics-disable"),
    readDiagnostics: (query) =>
      ipcRenderer.invoke("route-proxy:diagnostics-read", sanitizeRouteProxyDiagnosticsQuery(query)),
    clearDiagnostics: () => ipcRenderer.invoke("route-proxy:diagnostics-clear")
  }
});
