const { app, BrowserWindow, clipboard, ipcMain, nativeTheme, net, safeStorage } = require("electron");
const path = require("node:path");
const { createRouteProxyDiagnosticsStore } = require("./routeProxyDiagnosticsStore.cjs");
const { createRouteProxyController } = require("./routeProxyServer.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const defaultSecretClipboardClearDelayMs = 30_000;
const minSecretClipboardClearDelayMs = 5_000;
const maxSecretClipboardClearDelayMs = 300_000;
const defaultConnectionTimeoutMs = 15_000;
const minConnectionTimeoutMs = 1_000;
const maxConnectionTimeoutMs = 120_000;
const maxChatMessages = 20;
const maxChatContentParts = 12;
const maxChatImageUrlLength = 7_500_000;
const maxChatMessageLength = 12_000;
const defaultChatMaxTokens = 1024;
const defaultChatThinkingBudgetTokens = 1024;
const defaultChatReasoningEffort = "medium";
const openAiResponsesConnectionTestMaxOutputTokens = 16;
const authQueryParamNames = new Set([
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
  "access-token",
  "access_token",
  "accesstoken",
  "token",
  "x-goog-api-key",
  "x_goog_api_key",
  "xgoogapikey",
  "xapikey",
  "x-api-key"
]);

function providerFetch(input, init) {
  return typeof net.fetch === "function" ? net.fetch(input, init) : fetch(input, init);
}
const localOpenAiCompatibleProviderTypes = new Set(["ollama", "lm-studio"]);
const anthropicVersion = "2023-06-01";
const supportedOpenAiEndpointModes = new Set(["auto", "chat-completions", "responses"]);
const supportedChatImageMimeTypes = new Set(["image/gif", "image/jpeg", "image/jpg", "image/png", "image/webp"]);
const supportedConnectionProviderTypes = new Set([
  "openai",
  "azure-openai",
  "anthropic",
  "deepseek",
  "qwen",
  "zhipu",
  "ollama",
  "lm-studio",
  "custom"
]);
const appIconPath = path.join(__dirname, "..", "assets", "app-icon.ico");
const windowsAppUserModelId = "com.desk-api-config-manager.app";
let mainWindow;
let secretClipboardClearTimer;
let routeProxyDiagnosticsStore;

function assertString(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
}

function assertEncryptionAvailable() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-backed encryption is not available.");
  }
}

function normalizeClearDelay(clearAfterMs) {
  if (!Number.isFinite(clearAfterMs)) {
    return defaultSecretClipboardClearDelayMs;
  }

  return Math.min(
    Math.max(Math.trunc(clearAfterMs), minSecretClipboardClearDelayMs),
    maxSecretClipboardClearDelayMs
  );
}

function clearSecretClipboardLater(secret, clearAfterMs) {
  if (secretClipboardClearTimer) {
    clearTimeout(secretClipboardClearTimer);
  }

  secretClipboardClearTimer = setTimeout(() => {
    if (clipboard.readText() === secret) {
      clipboard.clear();
    }

    secretClipboardClearTimer = undefined;
  }, clearAfterMs);
}

function normalizeConnectionTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs)) {
    return defaultConnectionTimeoutMs;
  }

  return Math.min(Math.max(Math.trunc(timeoutMs), minConnectionTimeoutMs), maxConnectionTimeoutMs);
}

function assertConnectionProviderType(providerType) {
  if (!supportedConnectionProviderTypes.has(providerType)) {
    throw new Error("Unsupported provider type.");
  }
}

function normalizeOpenAiEndpointMode(endpointMode) {
  const normalizedEndpointMode = typeof endpointMode === "string" ? endpointMode : "auto";

  if (!supportedOpenAiEndpointModes.has(normalizedEndpointMode)) {
    throw new Error("Unsupported OpenAI endpoint mode.");
  }

  return normalizedEndpointMode;
}

function normalizeConnectionBaseUrl(baseUrl, providerType) {
  assertString(baseUrl, "baseUrl");

  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    throw new Error("Base URL must not be empty.");
  }

  if (localOpenAiCompatibleProviderTypes.has(providerType)) {
    const parsedBaseUrl = new URL(trimmedBaseUrl);
    const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");

    if (!normalizedPath) {
      parsedBaseUrl.pathname = "/v1/";
      parsedBaseUrl.search = "";
      parsedBaseUrl.hash = "";
      return parsedBaseUrl.toString();
    }
  }

  return trimmedBaseUrl.endsWith("/") ? trimmedBaseUrl : `${trimmedBaseUrl}/`;
}

function buildChatCompletionsUrl(baseUrl, providerType) {
  return new URL("chat/completions", normalizeConnectionBaseUrl(baseUrl, providerType)).toString();
}

function buildOpenAiResponsesUrl(baseUrl) {
  return new URL("responses", normalizeConnectionBaseUrl(baseUrl, "openai")).toString();
}

function shouldUseOpenAiResponsesApi(baseUrl, providerId, providerType, endpointMode = "auto") {
  if (providerType !== "openai") {
    return false;
  }

  const normalizedEndpointMode = normalizeOpenAiEndpointMode(endpointMode);

  if (normalizedEndpointMode === "responses") {
    return true;
  }

  if (normalizedEndpointMode === "chat-completions") {
    return false;
  }

  try {
    const parsedBaseUrl = new URL(normalizeConnectionBaseUrl(baseUrl, providerType));
    return parsedBaseUrl.protocol === "https:" && parsedBaseUrl.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function shouldUseChatThinking(baseUrl, providerId, providerType, endpointMode = "auto") {
  return (
    providerType === "anthropic" ||
    shouldUseOpenAiResponsesApi(baseUrl, providerId, providerType, endpointMode)
  );
}

function buildConnectionTestUrl(baseUrl, providerId, providerType, endpointMode = "auto") {
  if (providerType === "anthropic") {
    return new URL("messages", normalizeConnectionBaseUrl(baseUrl, providerType)).toString();
  }

  if (shouldUseOpenAiResponsesApi(baseUrl, providerId, providerType, endpointMode)) {
    return buildOpenAiResponsesUrl(baseUrl);
  }

  return buildChatCompletionsUrl(baseUrl, providerType);
}

function buildModelListUrl(baseUrl, providerType) {
  return new URL("models", normalizeConnectionBaseUrl(baseUrl, providerType)).toString();
}

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

function sanitizeRequestEndpointForRenderer(requestEndpoint, secrets = []) {
  const trimmedRequestEndpoint = typeof requestEndpoint === "string" ? requestEndpoint.trim() : "";

  if (!trimmedRequestEndpoint) {
    return undefined;
  }

  try {
    const parsedRequestEndpoint = new URL(trimmedRequestEndpoint);

    parsedRequestEndpoint.username = "";
    parsedRequestEndpoint.password = "";
    parsedRequestEndpoint.hash = "";

    for (const paramName of Array.from(parsedRequestEndpoint.searchParams.keys())) {
      if (authQueryParamNames.has(paramName.toLowerCase())) {
        parsedRequestEndpoint.searchParams.delete(paramName);
      }
    }

    return sanitizeSensitiveText(parsedRequestEndpoint.toString(), secrets);
  } catch {
    return sanitizeSensitiveText(trimmedRequestEndpoint, secrets);
  }
}

function assertConnectionAuthType(authType) {
  if (!["bearer", "api-key-header", "none"].includes(authType)) {
    throw new Error("Unsupported auth type.");
  }
}

function decryptConnectionApiKey(authType, encryptedApiKey) {
  if (authType === "none") {
    return undefined;
  }

  assertString(encryptedApiKey, "encryptedApiKey");
  assertEncryptionAvailable();

  return safeStorage.decryptString(Buffer.from(encryptedApiKey, "base64"));
}

function createConnectionHeaders(authType, apiKey) {
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

function createProviderConnectionHeaders(providerType, authType, apiKey) {
  if (providerType === "anthropic" && apiKey) {
    return {
      "Content-Type": "application/json",
      "anthropic-version": anthropicVersion,
      "x-api-key": apiKey
    };
  }

  return createConnectionHeaders(authType, apiKey);
}

// Protected header names that must not be overridden by custom headers from the renderer.
const protectedHeaderNames = new Set([
  "authorization",
  "x-api-key",
  "anthropic-version",
  "content-type",
  "content-length",
  "transfer-encoding",
  "host",
  "connection",
  "x-goog-api-key",
  "api-key",
  "ocp-apim-subscription-key"
]);

function resolveTransportCustomHeaders(customHeaders) {
  if (!Array.isArray(customHeaders) || customHeaders.length === 0) {
    return {};
  }

  const result = {};

  for (const header of customHeaders) {
    if (!header || typeof header !== "object") {
      continue;
    }

    const key = String(header.key ?? "").trim().toLowerCase();

    if (!key || protectedHeaderNames.has(key)) {
      continue;
    }

    if (header.isSecret && typeof header.encryptedValue === "string") {
      try {
        const plaintext = safeStorage.decryptString(Buffer.from(header.encryptedValue, "base64"));
        if (plaintext) {
          result[key] = plaintext;
        }
      } catch {
        // Skip headers that cannot be decrypted.
      }
    } else if (!header.isSecret && typeof header.plaintextValue === "string") {
      result[key] = header.plaintextValue;
    }
  }

  return result;
}

const routeProxyController = createRouteProxyController({
  appendDiagnosticEntry: (entry, options) => getRouteProxyDiagnosticsStore().appendEntry(entry, options),
  assertConnectionAuthType,
  assertConnectionProviderType,
  createProviderConnectionHeaders,
  decryptConnectionApiKey,
  normalizeConnectionBaseUrl,
  normalizeConnectionTimeout,
  providerFetch,
  sanitizeSensitiveText
});

function getRouteProxyDiagnosticsStore() {
  if (!routeProxyDiagnosticsStore) {
    routeProxyDiagnosticsStore = createRouteProxyDiagnosticsStore({
      userDataPath: app.getPath("userData")
    });
  }

  return routeProxyDiagnosticsStore;
}

function createProviderConnectionBody(providerId, providerType, endpointMode, baseUrl, model) {
  if (providerType === "anthropic") {
    return JSON.stringify({
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
      model,
      stream: false
    });
  }

  if (shouldUseOpenAiResponsesApi(baseUrl, providerId, providerType, endpointMode)) {
    return JSON.stringify({
      input: "ping",
      max_output_tokens: openAiResponsesConnectionTestMaxOutputTokens,
      model,
      store: false
    });
  }

  return JSON.stringify({
    messages: [{ role: "user", content: "ping" }],
    model,
    stream: false
  });
}

function isSupportedChatImageUrl(imageUrl) {
  return (
    imageUrl.length > 0 &&
    imageUrl.length <= maxChatImageUrlLength &&
    (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(imageUrl) || /^https:\/\//i.test(imageUrl))
  );
}

function normalizeChatImageMimeType(mimeType, imageUrl) {
  const trimmedMimeType = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  const dataUrlMatch = typeof imageUrl === "string" ? imageUrl.match(/^data:([^;,]+);base64,/i) : undefined;
  const detectedMimeType = dataUrlMatch ? dataUrlMatch[1].toLowerCase() : "";
  const normalizedMimeType = trimmedMimeType || detectedMimeType;

  return supportedChatImageMimeTypes.has(normalizedMimeType) ? normalizedMimeType : "image/png";
}

function normalizeChatMessageContent(content, role) {
  if (Array.isArray(content)) {
    const parts = content
      .slice(0, maxChatContentParts)
      .map((part) => {
        if (!part || typeof part !== "object") {
          return undefined;
        }

        if (part.type === "text") {
          const text = typeof part.text === "string" ? part.text.trim().slice(0, maxChatMessageLength) : "";

          return text
            ? {
                text,
                type: "text"
              }
            : undefined;
        }

        if (part.type === "image" && role === "user") {
          const imageUrl = typeof part.imageUrl === "string" ? part.imageUrl.trim() : "";

          if (!isSupportedChatImageUrl(imageUrl)) {
            return undefined;
          }

          return {
            imageUrl,
            mimeType: normalizeChatImageMimeType(part.mimeType, imageUrl),
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

  return typeof content === "string" ? content.trim().slice(0, maxChatMessageLength) : "";
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array.");
  }

  return messages.slice(-maxChatMessages).map((message) => {
    if (!message || typeof message !== "object") {
      throw new Error("message must be an object.");
    }

    const role = typeof message.role === "string" ? message.role : "";

    if (!["user", "assistant"].includes(role)) {
      throw new Error("Unsupported chat message role.");
    }

    const content = normalizeChatMessageContent(message.content, role);

    if (!content || (Array.isArray(content) && content.length === 0)) {
      throw new Error("chat message content must not be empty.");
    }

    return {
      role,
      content
    };
  });
}

function parseDataImageUrl(imageUrl) {
  const match = typeof imageUrl === "string" ? imageUrl.match(/^data:([^;,]+);base64,(.+)$/i) : undefined;

  return match
    ? {
        data: match[2],
        mediaType: match[1].toLowerCase()
      }
    : undefined;
}

function hasMultimodalChatContent(content) {
  return Array.isArray(content);
}

function convertOpenAiChatCompletionsContent(content) {
  if (!hasMultimodalChatContent(content)) {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return {
          text: part.text,
          type: "text"
        };
      }

      if (part.type === "image") {
        return {
          image_url: {
            url: part.imageUrl
          },
          type: "image_url"
        };
      }

      return undefined;
    })
    .filter(Boolean);
}

function convertOpenAiResponsesContent(content) {
  if (!hasMultimodalChatContent(content)) {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return {
          text: part.text,
          type: "input_text"
        };
      }

      if (part.type === "image") {
        return {
          image_url: part.imageUrl,
          type: "input_image"
        };
      }

      return undefined;
    })
    .filter(Boolean);
}

function convertAnthropicContent(content) {
  if (!hasMultimodalChatContent(content)) {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return {
          text: part.text,
          type: "text"
        };
      }

      if (part.type === "image") {
        const parsedImage = parseDataImageUrl(part.imageUrl);

        if (!parsedImage) {
          return undefined;
        }

        return {
          source: {
            data: parsedImage.data,
            media_type: part.mimeType || parsedImage.mediaType,
            type: "base64"
          },
          type: "image"
        };
      }

      return undefined;
    })
    .filter(Boolean);
}

function convertProviderChatMessages(messages, providerId, providerType, endpointMode, baseUrl) {
  if (providerType === "anthropic") {
    return messages.map((message) => ({
      role: message.role,
      content: convertAnthropicContent(message.content)
    }));
  }

  if (shouldUseOpenAiResponsesApi(baseUrl, providerId, providerType, endpointMode)) {
    return messages.map((message) => ({
      role: message.role,
      content: convertOpenAiResponsesContent(message.content)
    }));
  }

  return messages.map((message) => ({
    role: message.role,
    content: convertOpenAiChatCompletionsContent(message.content)
  }));
}

function createProviderChatBody(
  providerId,
  providerType,
  endpointMode,
  baseUrl,
  model,
  messages,
  stream = false,
  thinkingEnabled = false
) {
  const providerMessages = convertProviderChatMessages(messages, providerId, providerType, endpointMode, baseUrl);
  const useThinking = thinkingEnabled === true && shouldUseChatThinking(baseUrl, providerId, providerType, endpointMode);

  if (providerType === "anthropic") {
    const body = {
      max_tokens: useThinking
        ? defaultChatMaxTokens + defaultChatThinkingBudgetTokens
        : defaultChatMaxTokens,
      messages: providerMessages,
      model,
      stream
    };

    if (useThinking) {
      body.thinking = {
        budget_tokens: defaultChatThinkingBudgetTokens,
        type: "enabled"
      };
    }

    return JSON.stringify(body);
  }

  if (shouldUseOpenAiResponsesApi(baseUrl, providerId, providerType, endpointMode)) {
    const body = {
      input: providerMessages,
      max_output_tokens: defaultChatMaxTokens,
      model,
      store: false
    };

    if (stream) {
      body.stream = true;
    }

    if (useThinking) {
      body.reasoning = {
        effort: defaultChatReasoningEffort
      };
    }

    return JSON.stringify(body);
  }

  const body = {
    messages: providerMessages,
    model,
    stream
  };

  return JSON.stringify(body);
}

function parseJsonText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractTextFromContentParts(content) {
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

function extractChatContent(responseJson, providerId, providerType, endpointMode, baseUrl) {
  if (!responseJson || typeof responseJson !== "object") {
    return "";
  }

  if (providerType === "anthropic") {
    return extractTextFromContentParts(responseJson.content).trim();
  }

  if (shouldUseOpenAiResponsesApi(baseUrl, providerId, providerType, endpointMode)) {
    if (typeof responseJson.output_text === "string") {
      return responseJson.output_text.trim();
    }

    if (Array.isArray(responseJson.output)) {
      return responseJson.output
        .map((item) => (item && typeof item === "object" ? extractTextFromContentParts(item.content) : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
    }
  }

  const choices = Array.isArray(responseJson.choices) ? responseJson.choices : [];
  const message = choices[0] && typeof choices[0] === "object" ? choices[0].message : undefined;

  return message && typeof message === "object" ? extractTextFromContentParts(message.content).trim() : "";
}

function normalizeChatStreamRequestId(requestId) {
  assertString(requestId, "requestId");

  const trimmedRequestId = requestId.trim();

  if (!trimmedRequestId || trimmedRequestId.length > 120) {
    throw new Error("requestId must be a non-empty short string.");
  }

  return trimmedRequestId;
}

function createChatStreamEvent(requestId, payload) {
  return {
    requestId,
    ...payload
  };
}

function sendChatStreamEvent(webContents, requestId, payload) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send("chat:stream-event", createChatStreamEvent(requestId, payload));
}

function parseSseBlock(block) {
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

function extractChatStreamDelta(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (value.type === "content_block_delta" && value.delta && typeof value.delta.text === "string") {
    return value.delta.text;
  }

  if (value.type === "content_block_start" && value.content_block && typeof value.content_block.text === "string") {
    return value.content_block.text;
  }

  if (
    (value.type === "response.output_text.delta" || value.type === "response.refusal.delta") &&
    typeof value.delta === "string"
  ) {
    return value.delta;
  }

  const choices = Array.isArray(value.choices) ? value.choices : [];
  const choice = choices[0] && typeof choices[0] === "object" ? choices[0] : undefined;

  if (choice && choice.delta && typeof choice.delta === "object") {
    return extractTextFromContentParts(choice.delta.content);
  }

  if (choice && typeof choice.text === "string") {
    return choice.text;
  }

  return "";
}

function extractChatStreamError(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (value.type === "error" && value.error && typeof value.error.message === "string") {
    return value.error.message;
  }

  if (value.error && typeof value.error === "object" && typeof value.error.message === "string") {
    return value.error.message;
  }

  if (typeof value.error === "string") {
    return value.error;
  }

  return "";
}

function isChatStreamDone(value, eventType, data) {
  if (data === "[DONE]") {
    return true;
  }

  if (eventType === "done") {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  if (["message_stop", "response.completed", "response.done"].includes(value.type)) {
    return true;
  }

  const choices = Array.isArray(value.choices) ? value.choices : [];
  return choices.some((choice) => choice && typeof choice === "object" && Boolean(choice.finish_reason));
}

function processChatStreamBlock(block) {
  const parsedBlock = parseSseBlock(block);
  const data = parsedBlock.data.trim();

  if (!data) {
    return {
      done: false,
      error: "",
      text: ""
    };
  }

  if (data === "[DONE]") {
    return {
      done: true,
      error: "",
      text: ""
    };
  }

  const value = parseJsonText(data);

  if (!value) {
    return {
      done: false,
      error: "",
      text: ""
    };
  }

  return {
    done: isChatStreamDone(value, parsedBlock.eventType, data),
    error: extractChatStreamError(value),
    text: extractChatStreamDelta(value)
  };
}

function normalizeModelFetchApiKey(authType, apiKey, encryptedApiKey) {
  if (authType === "none") {
    return undefined;
  }

  if (typeof apiKey === "string" && apiKey.trim()) {
    return apiKey.trim();
  }

  if (typeof encryptedApiKey === "string" && encryptedApiKey.trim()) {
    assertEncryptionAvailable();
    return safeStorage.decryptString(Buffer.from(encryptedApiKey, "base64"));
  }

  throw new Error("API key must not be empty.");
}

function createModelListHeaders(providerType, authType, apiKey) {
  if (providerType === "anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey
    };
  }

  return createConnectionHeaders(authType, apiKey);
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function extractModelIds(value) {
  const data = value && typeof value === "object" && Array.isArray(value.data) ? value.data : [];
  const modelIds = [];
  const seenModelIds = new Set();

  for (const item of data) {
    const modelId = typeof item === "string" ? item : item && typeof item.id === "string" ? item.id : "";
    const trimmedModelId = modelId.trim();

    if (!trimmedModelId || seenModelIds.has(trimmedModelId)) {
      continue;
    }

    seenModelIds.add(trimmedModelId);
    modelIds.push(trimmedModelId);
  }

  return modelIds;
}

function createModelFetchErrorMessage(status, responseText) {
  const statusText = typeof status === "number" && status > 0 ? `HTTP ${status}` : "Model list fetch failed";
  const trimmedResponseText = typeof responseText === "string" ? responseText.trim() : "";

  return trimmedResponseText ? `${statusText} 路 ${trimmedResponseText.slice(0, 360)}` : statusText;
}

async function fetchProviderModels(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object.");
  }

  assertConnectionAuthType(request.authType);
  assertConnectionProviderType(request.providerType);

  const apiKey = normalizeModelFetchApiKey(request.authType, request.apiKey, request.encryptedApiKey);
  const timeoutMs = normalizeConnectionTimeout(request.timeoutMs);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestEndpoint = buildModelListUrl(request.baseUrl, request.providerType);
    const baseModelListHeaders = createModelListHeaders(request.providerType, request.authType, apiKey);
    const customModelListHeadersResolved = resolveTransportCustomHeaders(request.customHeaders);
    const response = await providerFetch(requestEndpoint, {
      headers: { ...customModelListHeadersResolved, ...baseModelListHeaders },
      method: "GET",
      signal: controller.signal
    });

    if (!response.ok) {
      const responseText = sanitizeSensitiveText(await readResponseText(response), [
        apiKey ?? "",
        request.encryptedApiKey ?? ""
      ]);

      return {
        errorMessage: createModelFetchErrorMessage(response.status, responseText),
        models: [],
        ok: false,
        status: response.status,
        requestEndpoint: sanitizeRequestEndpointForRenderer(requestEndpoint, [apiKey ?? "", request.encryptedApiKey ?? ""])
      };
    }

    return {
      models: extractModelIds(await readResponseJson(response)),
      ok: true,
      status: response.status,
      requestEndpoint: sanitizeRequestEndpointForRenderer(requestEndpoint, [apiKey ?? "", request.encryptedApiKey ?? ""])
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model list fetch failed.";
    throw new Error(sanitizeSensitiveText(message, [apiKey ?? "", request.encryptedApiKey ?? ""]));
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function testOpenAiCompatibleConnection(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object.");
  }

  assertConnectionAuthType(request.authType);
  assertConnectionProviderType(request.providerType);
  assertString(request.providerId, "providerId");
  assertString(request.model, "model");

  const model = request.model.trim();

  if (!model) {
    throw new Error("model must not be empty.");
  }

  const apiKey = decryptConnectionApiKey(request.authType, request.encryptedApiKey);
  const endpointMode = normalizeOpenAiEndpointMode(request.endpointMode);
  const timeoutMs = normalizeConnectionTimeout(request.timeoutMs);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestEndpoint = buildConnectionTestUrl(request.baseUrl, request.providerId, request.providerType, endpointMode);
    const baseHeaders = createProviderConnectionHeaders(request.providerType, request.authType, apiKey);
    const customHeadersResolved = resolveTransportCustomHeaders(request.customHeaders);
    const response = await providerFetch(requestEndpoint, {
      body: createProviderConnectionBody(request.providerId, request.providerType, endpointMode, request.baseUrl, model),
      headers: { ...customHeadersResolved, ...baseHeaders },
      method: "POST",
      signal: controller.signal
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const responseText = response.ok ? "" : sanitizeSensitiveText(await readResponseText(response), [apiKey ?? ""]);

    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      requestEndpoint: sanitizeRequestEndpointForRenderer(requestEndpoint, [apiKey ?? ""]),
      responseText
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed.";
    throw new Error(sanitizeSensitiveText(message, [apiKey ?? ""]));
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function sendChatMessage(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object.");
  }

  assertConnectionAuthType(request.authType);
  assertConnectionProviderType(request.providerType);
  assertString(request.providerId, "providerId");
  assertString(request.model, "model");

  const model = request.model.trim();

  if (!model) {
    throw new Error("model must not be empty.");
  }

  const messages = normalizeChatMessages(request.messages);
  const apiKey = decryptConnectionApiKey(request.authType, request.encryptedApiKey);
  const endpointMode = normalizeOpenAiEndpointMode(request.endpointMode);
  const timeoutMs = normalizeConnectionTimeout(request.timeoutMs);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestEndpoint = buildConnectionTestUrl(request.baseUrl, request.providerId, request.providerType, endpointMode);
    const baseChatHeaders = createProviderConnectionHeaders(request.providerType, request.authType, apiKey);
    const customChatHeadersResolved = resolveTransportCustomHeaders(request.customHeaders);
    const response = await providerFetch(requestEndpoint, {
      body: createProviderChatBody(
        request.providerId,
        request.providerType,
        endpointMode,
        request.baseUrl,
        model,
        messages,
        false,
        request.thinkingEnabled === true
      ),
      headers: { ...customChatHeadersResolved, ...baseChatHeaders },
      method: "POST",
      signal: controller.signal
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const responseText = await readResponseText(response);
    const sanitizedResponseText = sanitizeSensitiveText(responseText, [apiKey ?? ""]);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        requestEndpoint,
        responseText: sanitizedResponseText
      };
    }

    return {
      ok: true,
      status: response.status,
      latencyMs,
      requestEndpoint,
      content: extractChatContent(
        parseJsonText(responseText),
        request.providerId,
        request.providerType,
        endpointMode,
        request.baseUrl
      )
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat request failed.";
    throw new Error(sanitizeSensitiveText(message, [apiKey ?? ""]));
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function streamChatMessage(webContents, request) {
  let requestId = typeof request?.requestId === "string" ? request.requestId.trim() : "";
  let apiKey;

  try {
    if (!request || typeof request !== "object") {
      throw new Error("request must be an object.");
    }

    requestId = normalizeChatStreamRequestId(request.requestId);
    assertConnectionAuthType(request.authType);
    assertConnectionProviderType(request.providerType);
    assertString(request.providerId, "providerId");
    assertString(request.model, "model");

    const model = request.model.trim();

    if (!model) {
      throw new Error("model must not be empty.");
    }

    const messages = normalizeChatMessages(request.messages);
    apiKey = decryptConnectionApiKey(request.authType, request.encryptedApiKey);
    const endpointMode = normalizeOpenAiEndpointMode(request.endpointMode);
    const timeoutMs = normalizeConnectionTimeout(request.timeoutMs);
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestEndpoint = buildConnectionTestUrl(request.baseUrl, request.providerId, request.providerType, endpointMode);
      const baseStreamHeaders = createProviderConnectionHeaders(request.providerType, request.authType, apiKey);
      const customStreamHeadersResolved = resolveTransportCustomHeaders(request.customHeaders);
      const response = await providerFetch(requestEndpoint, {
        body: createProviderChatBody(
          request.providerId,
          request.providerType,
          endpointMode,
          request.baseUrl,
          model,
          messages,
          true,
          request.thinkingEnabled === true
        ),
        headers: { ...customStreamHeadersResolved, ...baseStreamHeaders },
        method: "POST",
        signal: controller.signal
      });
      const latencyMs = Math.max(0, Date.now() - startedAt);

      if (!response.ok) {
        const responseText = sanitizeSensitiveText(await readResponseText(response), [apiKey ?? ""]);
        const result = {
          ok: false,
          status: response.status,
          latencyMs,
          requestEndpoint,
          responseText
        };

        sendChatStreamEvent(webContents, requestId, {
          type: "error",
          ...result
        });

        return result;
      }

      if (!response.body || typeof response.body.getReader !== "function") {
        const responseText = await readResponseText(response);
        const content = extractChatContent(
          parseJsonText(responseText),
          request.providerId,
          request.providerType,
          endpointMode,
          request.baseUrl
        );
        const result = {
          ok: true,
          status: response.status,
          latencyMs,
          requestEndpoint,
          content
        };

        if (content) {
          sendChatStreamEvent(webContents, requestId, {
            type: "chunk",
            content
          });
        }

        sendChatStreamEvent(webContents, requestId, {
          type: "done",
          ...result
        });

        return result;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawStreamText = "";
      let streamedContent = "";
      let receivedDone = false;

      const processBlock = (block) => {
        const streamEvent = processChatStreamBlock(block);

        if (streamEvent.error) {
          throw new Error(streamEvent.error);
        }

        if (streamEvent.text) {
          streamedContent += streamEvent.text;
          sendChatStreamEvent(webContents, requestId, {
            type: "chunk",
            content: streamEvent.text
          });
        }

        if (streamEvent.done) {
          receivedDone = true;
        }
      };

      while (!receivedDone) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        rawStreamText += chunk;
        buffer += chunk;

        let separatorIndex = buffer.indexOf("\n\n");

        while (separatorIndex >= 0) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          processBlock(block);
          separatorIndex = buffer.indexOf("\n\n");
        }
      }

      const finalChunk = decoder.decode().replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      if (finalChunk) {
        rawStreamText += finalChunk;
        buffer += finalChunk;
      }

      if (buffer.trim()) {
        processBlock(buffer);
      }

      if (!streamedContent.trim()) {
        const fallbackContent = extractChatContent(
          parseJsonText(rawStreamText.trim()),
          request.providerId,
          request.providerType,
          endpointMode,
          request.baseUrl
        );

        if (fallbackContent) {
          streamedContent = fallbackContent;
          sendChatStreamEvent(webContents, requestId, {
            type: "chunk",
            content: fallbackContent
          });
        }
      }

      const result = {
        ok: true,
        status: response.status,
        latencyMs: Math.max(0, Date.now() - startedAt),
        requestEndpoint,
        content: streamedContent
      };

      sendChatStreamEvent(webContents, requestId, {
        type: "done",
        ...result
      });

      return result;
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    const message = sanitizeSensitiveText(error instanceof Error ? error.message : "Chat request failed.", [
      apiKey ?? ""
    ]);

    if (requestId) {
      sendChatStreamEvent(webContents, requestId, {
        type: "error",
        ok: false,
        status: 0,
        latencyMs: 0,
        content: message,
        responseText: message
      });
    }

    throw new Error(message);
  }
}

function createMainWindow() {
  const nextMainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    autoHideMenuBar: true,
    frame: false,
    icon: appIconPath,
    title: "Desk API Config Manager",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111827" : "#f7f8fb",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = nextMainWindow;
  nextMainWindow.setMenuBarVisibility(false);

  nextMainWindow.once("ready-to-show", () => {
    nextMainWindow.show();
  });

  nextMainWindow.on("closed", () => {
    if (mainWindow === nextMainWindow) {
      mainWindow = undefined;
    }
  });

  if (isDev) {
    nextMainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    nextMainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  return nextMainWindow;
}

function getWindowForIpcEvent(event) {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);

  if (!targetWindow || targetWindow.isDestroyed()) {
    return undefined;
  }

  return targetWindow;
}

function focusMainWindow() {
  const existingWindow =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];

  if (!existingWindow) {
    createMainWindow();
    return;
  }

  if (existingWindow.isMinimized()) {
    existingWindow.restore();
  }

  existingWindow.show();
  existingWindow.focus();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  if (process.platform === "win32") {
    app.setAppUserModelId(windowsAppUserModelId);
  }

  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(() => {
    void getRouteProxyDiagnosticsStore().open().catch(() => undefined);

    ipcMain.handle("app:get-version", () => app.getVersion());
    ipcMain.handle("app:get-runtime-info", () => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron || "",
      isDev,
      userDataPath: app.getPath("userData")
    }));
    ipcMain.handle("secret:is-encryption-available", () => safeStorage.isEncryptionAvailable());
    ipcMain.handle("secret:encrypt", (_event, plaintext) => {
      assertString(plaintext, "plaintext");
      assertEncryptionAvailable();

      return safeStorage.encryptString(plaintext).toString("base64");
    });
    ipcMain.handle("secret:decrypt", (_event, encryptedValue) => {
      assertString(encryptedValue, "encryptedValue");
      assertEncryptionAvailable();

      return safeStorage.decryptString(Buffer.from(encryptedValue, "base64"));
    });
    ipcMain.handle("secret:copy-to-clipboard", (_event, plaintext, options = {}) => {
      assertString(plaintext, "plaintext");

      const clearAfterMs = normalizeClearDelay(options.clearAfterMs);
      clipboard.writeText(plaintext);
      clearSecretClipboardLater(plaintext, clearAfterMs);

      return { clearAfterMs };
    });
    ipcMain.handle("clipboard:write-text", (_event, text) => {
      assertString(text, "text");
      clipboard.writeText(text);

      return { ok: true };
    });
    ipcMain.handle("window:close", (event) => {
      const targetWindow = getWindowForIpcEvent(event);

      if (!targetWindow) {
        return { ok: false };
      }

      targetWindow.close();

      return { ok: true };
    });
    ipcMain.handle("window:minimize", (event) => {
      const targetWindow = getWindowForIpcEvent(event);

      if (!targetWindow) {
        return { ok: false };
      }

      targetWindow.minimize();

      return { ok: true };
    });
    ipcMain.handle("window:toggle-maximize", (event) => {
      const targetWindow = getWindowForIpcEvent(event);

      if (!targetWindow) {
        return { maximized: false, ok: false };
      }

      if (targetWindow.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow.maximize();
      }

      return { maximized: targetWindow.isMaximized(), ok: true };
    });
    ipcMain.handle("connection:test-openai-compatible", (_event, request) =>
      testOpenAiCompatibleConnection(request)
    );
    ipcMain.handle("chat:send-message", (_event, request) => sendChatMessage(request));
    ipcMain.handle("chat:stream-message", (event, request) => streamChatMessage(event.sender, request));
    ipcMain.handle("models:fetch-provider-models", (_event, request) => fetchProviderModels(request));
    ipcMain.handle("route-proxy:get-default-config", () => routeProxyController.getDefaultConfig());
    ipcMain.handle("route-proxy:get-status", () => routeProxyController.getStatus());
    ipcMain.handle("route-proxy:get-request-logs", () => routeProxyController.getRequestLogs());
    ipcMain.handle("route-proxy:clear-request-logs", () => routeProxyController.clearRequestLogs());
    ipcMain.handle("route-proxy:start", (_event, request) => routeProxyController.start(request));
    ipcMain.handle("route-proxy:stop", () => routeProxyController.stop());
    ipcMain.handle("route-proxy:diagnostics-get-manifest", () =>
      getRouteProxyDiagnosticsStore().readManifest()
    );
    ipcMain.handle("route-proxy:diagnostics-enable", (_event, retention) =>
      getRouteProxyDiagnosticsStore().enable(retention)
    );
    ipcMain.handle("route-proxy:diagnostics-disable", () => getRouteProxyDiagnosticsStore().disable());
    ipcMain.handle("route-proxy:diagnostics-read", (_event, query) =>
      getRouteProxyDiagnosticsStore().readEntries(query)
    );
    ipcMain.handle("route-proxy:diagnostics-clear", async () => {
      const diagnosticsStore = getRouteProxyDiagnosticsStore();

      await routeProxyController.flushDiagnostics();
      await diagnosticsStore.clearAll();

      return {
        entries: [],
        manifest: await diagnosticsStore.readManifest()
      };
    });
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    routeProxyController.close();
  });
}
