import type { ApiProvider } from "../types";

export interface ProviderModelFetchRequest {
  apiKey: string;
  authType: ApiProvider["authType"];
  baseUrl: string;
  encryptedApiKey?: string;
  providerType: ApiProvider["type"];
  timeoutMs?: number;
}

export interface ProviderModelFetchResult {
  errorMessage?: string;
  models: string[];
  ok?: boolean;
  requestEndpoint?: string;
  status?: number;
}

export interface ModelFetchTransport {
  fetchProviderModels(request: ProviderModelFetchRequest): Promise<ProviderModelFetchResult>;
}

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

function getModelFetchSanitizationSecrets(request: ProviderModelFetchRequest): string[] {
  return [request.apiKey, request.encryptedApiKey].filter(
    (value): value is string => Boolean(value?.trim())
  );
}

function sanitizeSensitiveText(value: string, secrets: string[] = []): string {
  let sanitizedValue = value;

  for (const secret of secrets) {
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

function sanitizeRequestEndpoint(requestEndpoint: string | undefined, secrets: string[] = []): string | undefined {
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

export function sanitizeProviderModelFetchResult(
  result: ProviderModelFetchResult,
  request: ProviderModelFetchRequest
): ProviderModelFetchResult {
  const secrets = getModelFetchSanitizationSecrets(request);

  return {
    ...result,
    errorMessage: result.errorMessage ? sanitizeSensitiveText(result.errorMessage, secrets) : result.errorMessage,
    requestEndpoint: sanitizeRequestEndpoint(result.requestEndpoint, secrets)
  };
}

function createSanitizedModelFetchError(error: unknown, request: ProviderModelFetchRequest): Error {
  const message = error instanceof Error ? error.message : "Model list fetch failed.";

  return new Error(sanitizeSensitiveText(message, getModelFetchSanitizationSecrets(request)));
}

export function createDesktopModelFetchTransport(
  deskApi: Window["deskApi"] | undefined = typeof window === "undefined" ? undefined : window.deskApi
): ModelFetchTransport | undefined {
  if (!deskApi?.models) {
    return undefined;
  }

  return {
    fetchProviderModels: async (request: ProviderModelFetchRequest) => {
      try {
        return sanitizeProviderModelFetchResult(await deskApi.models.fetchProviderModels(request), request);
      } catch (error) {
        throw createSanitizedModelFetchError(error, request);
      }
    }
  };
}
