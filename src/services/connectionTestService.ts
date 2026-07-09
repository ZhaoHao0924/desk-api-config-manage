import type { ApiConfigRepository, TestHistoryRepository } from "../domain/repositories";
import type { ApiConfig, ApiProvider, OpenAiEndpointMode, TestHistoryItem, TestStatus } from "../types";
import type { ConnectionTestTransport, OpenAiCompatibleTransportResult, TransportCustomHeader } from "./connectionTestTransport";
import type { SecretService } from "./secretService";

type ConnectionTestRepository = ApiConfigRepository & TestHistoryRepository;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ConnectionTestOptions {
  createId?: () => string;
  fetchImpl?: FetchLike;
  monotonicNow?: () => number;
  now?: () => string;
  secretService?: SecretService;
  timeoutMs?: number;
  transport?: ConnectionTestTransport;
  customHeaders?: TransportCustomHeader[];
}

interface ConnectionTestOutcome {
  config: ApiConfig;
  historyItem: TestHistoryItem;
}

const defaultTimeoutMs = 15_000;
const localOpenAiCompatibleProviderTypes = new Set<ApiProvider["type"]>(["ollama", "lm-studio"]);
const anthropicVersion = "2023-06-01";
const maxErrorDetailLength = 800;
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
const testPrompt = "ping";

function defaultCreateId(): string {
  return crypto.randomUUID();
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function normalizeBaseUrl(baseUrl: string, providerType?: ApiProvider["type"]): string {
  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    throw new Error("Base URL 不能为空");
  }

  if (providerType && localOpenAiCompatibleProviderTypes.has(providerType)) {
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

export function buildChatCompletionsUrl(baseUrl: string, provider?: Pick<ApiProvider, "type">): string {
  return new URL("chat/completions", normalizeBaseUrl(baseUrl, provider?.type)).toString();
}

export function buildOpenAiResponsesUrl(baseUrl: string): string {
  return new URL("responses", normalizeBaseUrl(baseUrl, "openai")).toString();
}

type ConnectionEndpointProvider = Pick<ApiProvider, "type"> & Partial<Pick<ApiProvider, "id">>;

function normalizeEndpointMode(endpointMode: OpenAiEndpointMode | undefined): OpenAiEndpointMode {
  return endpointMode === "chat-completions" || endpointMode === "responses" || endpointMode === "auto"
    ? endpointMode
    : "auto";
}

export function shouldUseOpenAiResponsesApi(
  baseUrl: string,
  provider: ConnectionEndpointProvider,
  endpointMode: OpenAiEndpointMode = "auto"
): boolean {
  if (provider.type !== "openai") {
    return false;
  }

  const normalizedEndpointMode = normalizeEndpointMode(endpointMode);

  if (normalizedEndpointMode === "responses") {
    return true;
  }

  if (normalizedEndpointMode === "chat-completions") {
    return false;
  }

  try {
    const parsedBaseUrl = new URL(normalizeBaseUrl(baseUrl, provider.type));
    return parsedBaseUrl.protocol === "https:" && parsedBaseUrl.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function buildConnectionTestUrl(
  baseUrl: string,
  provider: ConnectionEndpointProvider,
  endpointMode: OpenAiEndpointMode = "auto"
): string {
  if (provider.type === "anthropic") {
    return new URL("messages", normalizeBaseUrl(baseUrl, provider.type)).toString();
  }

  if (shouldUseOpenAiResponsesApi(baseUrl, provider, endpointMode)) {
    return buildOpenAiResponsesUrl(baseUrl);
  }

  return buildChatCompletionsUrl(baseUrl, provider);
}

export function sanitizeSensitiveText(value: string, secrets: string[] = []): string {
  let sanitizedValue = value;

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

function getConnectionSanitizationSecrets(config: ApiConfig, apiKey: string | undefined): string[] {
  return [apiKey, config.encryptedApiKey, config.apiKeyPreview].filter(
    (value): value is string => Boolean(value?.trim()) && value !== "未设置" && value !== "无需密钥"
  );
}

function getReadableHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return "认证失败，请检查 API Key 或权限";
  }

  if (status === 404) {
    return "接口或模型不存在，请检查 Base URL 和模型名称";
  }

  if (status === 429) {
    return "请求过于频繁或额度不足";
  }

  return `请求失败，HTTP ${status}`;
}

function getConnectionErrorCode(errorMessage: string): string {
  if (errorMessage === "缺少 API Key") {
    return "MISSING_API_KEY";
  }

  if (errorMessage === "当前环境未启用安全存储") {
    return "SECRET_STORAGE_UNAVAILABLE";
  }

  return "CONNECTION_ERROR";
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncateErrorDetail(value: string): string {
  return value.length > maxErrorDetailLength ? `${value.slice(0, maxErrorDetailLength)}...` : value;
}

function sanitizeRequestEndpointForHistory(requestEndpoint: string | undefined, secrets: string[] = []): string | undefined {
  const trimmedRequestEndpoint = requestEndpoint?.trim();

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

async function resolveApiKey(
  config: ApiConfig,
  provider: ApiProvider,
  secretService: SecretService | undefined
): Promise<string | undefined> {
  if (provider.authType === "none") {
    return undefined;
  }

  if (!config.encryptedApiKey) {
    throw new Error("缺少 API Key");
  }

  if (!secretService) {
    throw new Error("当前环境未启用安全存储");
  }

  return secretService.decryptSecret(config.encryptedApiKey);
}

function createRequestHeaders(provider: ApiProvider, apiKey: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (provider.type === "anthropic" && apiKey) {
    headers["anthropic-version"] = anthropicVersion;
    headers["x-api-key"] = apiKey;
    return headers;
  }

  if (provider.authType === "bearer" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (provider.authType === "api-key-header" && apiKey) {
    headers["api-key"] = apiKey;
  }

  return headers;
}

function createRequestBody(provider: ApiProvider, baseUrl: string, model: string, endpointMode: OpenAiEndpointMode): string {
  if (provider.type === "anthropic") {
    return JSON.stringify({
      max_tokens: 1,
      messages: [{ role: "user", content: testPrompt }],
      model,
      stream: false
    });
  }

  if (shouldUseOpenAiResponsesApi(baseUrl, provider, endpointMode)) {
    return JSON.stringify({
      input: testPrompt,
      max_output_tokens: openAiResponsesConnectionTestMaxOutputTokens,
      model,
      store: false
    });
  }

  return JSON.stringify({
    messages: [{ role: "user", content: testPrompt }],
    model,
    stream: false
  });
}

function createReadableFailure(
  status: number,
  responseText?: string
): { errorCode: string; errorMessage: string; errorDetail?: string } {
  const readableError = getReadableHttpError(status);

  return {
    errorCode: String(status),
    errorMessage: readableError,
    errorDetail: responseText ? truncateErrorDetail(responseText) : undefined
  };
}

function createHistoryItem(input: {
  configId: string;
  createId: () => string;
  requestEndpoint?: string;
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
  latencyMs?: number;
  status: TestStatus;
  testedAt: string;
}): TestHistoryItem {
  return {
    id: input.createId(),
    configId: input.configId,
    status: input.status,
    latencyMs: input.latencyMs,
    requestEndpoint: input.requestEndpoint,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    errorDetail: input.errorDetail,
    testedAt: input.testedAt
  };
}

export async function runConnectionTest(
  repository: ConnectionTestRepository,
  config: ApiConfig,
  provider: ApiProvider,
  options: ConnectionTestOptions = {}
): Promise<ConnectionTestOutcome> {
  const createId = options.createId ?? defaultCreateId;
  const fetchImpl = options.fetchImpl ?? fetch;
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const now = options.now ?? defaultNow;
  const testedAt = now();
  const startedAt = monotonicNow();
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  let apiKey: string | undefined;
  let requestEndpoint: string | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const finish = async (input: {
    errorCode?: string;
    errorMessage?: string;
    errorDetail?: string;
    latencyMs?: number;
    requestEndpoint?: string;
    status: TestStatus;
  }): Promise<ConnectionTestOutcome> => {
    const nextConfig: ApiConfig = {
      ...config,
      lastTestStatus: input.status,
      lastTestAt: testedAt,
      latencyMs: input.latencyMs,
      updatedAt: testedAt
    };
    const historyItem = createHistoryItem({
      configId: config.id,
      createId,
      requestEndpoint: sanitizeRequestEndpointForHistory(
        input.requestEndpoint,
        getConnectionSanitizationSecrets(config, apiKey)
      ),
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      errorDetail: input.errorDetail,
      latencyMs: input.latencyMs,
      status: input.status,
      testedAt
    });

    const [savedConfig, savedHistoryItem] = await Promise.all([
      repository.replaceConfig(nextConfig),
      repository.saveTestHistory(historyItem)
    ]);

    return {
      config: savedConfig,
      historyItem: savedHistoryItem
    };
  };

  try {
    if (options.transport) {
      if (provider.authType !== "none" && !config.encryptedApiKey) {
        throw new Error("缺少 API Key");
      }

      requestEndpoint = buildConnectionTestUrl(config.baseUrl, provider, config.endpointMode);
      const transportResult: OpenAiCompatibleTransportResult = await options.transport.testOpenAiCompatible({
        authType: provider.authType,
        baseUrl: config.baseUrl,
        endpointMode: config.endpointMode,
        encryptedApiKey: config.encryptedApiKey,
        model: config.defaultModel,
        providerId: provider.id,
        providerType: provider.type,
        timeoutMs,
        customHeaders: options.customHeaders
      });
      requestEndpoint = transportResult.requestEndpoint ?? requestEndpoint;

      if (transportResult.ok) {
        return finish({
          latencyMs: transportResult.latencyMs,
          requestEndpoint,
          status: "success"
        });
      }

      const responseText = transportResult.responseText
        ? sanitizeSensitiveText(transportResult.responseText, getConnectionSanitizationSecrets(config, apiKey))
        : undefined;
      const failure = createReadableFailure(transportResult.status, responseText);

      return finish({
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        errorDetail: failure.errorDetail,
        latencyMs: transportResult.latencyMs,
        requestEndpoint,
        status: "failed"
      });
    }

    apiKey = await resolveApiKey(config, provider, options.secretService);
    requestEndpoint = buildConnectionTestUrl(config.baseUrl, provider, config.endpointMode);

    timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchImpl(requestEndpoint, {
      body: createRequestBody(provider, config.baseUrl, config.defaultModel, config.endpointMode),
      headers: createRequestHeaders(provider, apiKey),
      method: "POST",
      signal: controller.signal
    });
    const latencyMs = Math.max(0, Math.round(monotonicNow() - startedAt));

    if (response.ok) {
      return finish({
        latencyMs,
        requestEndpoint,
        status: "success"
      });
    }

    const responseText = sanitizeSensitiveText(
      await readResponseText(response),
      getConnectionSanitizationSecrets(config, apiKey)
    );
    const failure = createReadableFailure(response.status, responseText);

    return finish({
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      errorDetail: failure.errorDetail,
      latencyMs,
      requestEndpoint,
      status: "failed"
    });
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(monotonicNow() - startedAt));
    const isAbort =
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError");
    const rawMessage = error instanceof Error ? error.message : "连接测试失败";
    const errorMessage = isAbort
      ? "请求超时"
      : sanitizeSensitiveText(rawMessage, getConnectionSanitizationSecrets(config, apiKey));

    return finish({
      errorCode: isAbort ? "TIMEOUT" : getConnectionErrorCode(rawMessage),
      errorMessage,
      requestEndpoint,
      latencyMs,
      status: "failed"
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
