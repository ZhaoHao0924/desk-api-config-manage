import type { ApiConfig, ApiProvider, OpenAiEndpointMode } from "../types";

export interface RouteProxyTarget {
  authType: ApiProvider["authType"];
  baseUrl: string;
  configId: string;
  configName: string;
  endpointMode: OpenAiEndpointMode;
  encryptedApiKey?: string;
  providerId: string;
  providerType: ApiProvider["type"];
  weight: number;
}

export type RouteProxyRoutingMode = "ordered" | "weighted";

export interface RouteProxyStartRequest {
  cooldownMs?: number;
  failureThreshold?: number;
  listenAddress: string;
  listenPort: number;
  profileId?: string;
  routingMode?: RouteProxyRoutingMode;
  target: RouteProxyTarget;
  targets?: RouteProxyTarget[];
  timeoutMs?: number;
}

export interface RouteProxyDefaultConfig {
  listenAddress: string;
  listenPort: number;
}

export interface RouteProxyStatus {
  activeConnections: number;
  address: string;
  cooldownMs: number;
  failedRequests: number;
  failureThreshold: number;
  lastError: string;
  lastRequestAt: string;
  port: number;
  proxyUrl: string;
  routingMode: RouteProxyRoutingMode;
  running: boolean;
  startedAt: string;
  successRate: number;
  successRequests: number;
  targetBaseUrl: string;
  targetCount: number;
  targetConfigId: string;
  targetHealth: RouteProxyTargetHealth[];
  targetName: string;
  totalRequests: number;
  uptimeSeconds: number;
}

export interface RouteProxyTargetHealth {
  baseUrl: string;
  configId: string;
  failureCount: number;
  lastError: string;
  name: string;
  state: "available" | "cooling-down";
  unavailableUntil: string;
  weight: number;
}

export interface RouteProxyRequestLog {
  attempt: number;
  completedAt: string;
  error: string;
  id: string;
  latencyMs: number;
  method: string;
  ok: boolean;
  path: string;
  startedAt: string;
  statusCode: number;
  targetConfigId: string;
  targetName: string;
}

export interface RouteProxyDiagnosticsRetention {
  maxAgeDays: number;
  maxEntries: number;
  maxTotalBytes: number;
}

export interface RouteProxyDiagnosticsManifest {
  createdAt: string;
  enabled: boolean;
  retention: RouteProxyDiagnosticsRetention;
  schemaVersion: 1;
  updatedAt: string;
}

export type RouteProxyDiagnosticResult =
  | "success"
  | "upstream-http-error"
  | "network-error"
  | "proxy-error"
  | "client-error"
  | "target-health-change";

export type RouteProxyDiagnosticEventType = "request" | "target-health";

export interface RouteProxyDiagnosticEntry {
  attempt: number;
  completedAt: string;
  errorCode: string;
  errorMessage: string;
  eventType: RouteProxyDiagnosticEventType;
  id: string;
  latencyMs: number;
  method: string;
  ok: boolean;
  path: string;
  profileId: string;
  result: RouteProxyDiagnosticResult;
  schemaVersion: 1;
  startedAt: string;
  statusCode: number;
  targetConfigId: string;
  targetHealthState: "available" | "cooling-down";
  targetOrdinal: number;
}

export interface RouteProxyDiagnosticsQuery {
  eventType?: RouteProxyDiagnosticEventType;
  limit?: number;
  ok?: boolean;
  profileId?: string;
  since?: string;
  targetConfigId?: string;
}

export interface RouteProxyEndpointExamples {
  baseUrl: string;
  chatCompletionsUrl: string;
  modelListUrl: string;
}

export type RouteProxyClientAdapterTarget = "openai-sdk" | "codex-responses" | "claude-code";

export interface RouteProxyClientAdapterSnippet {
  content: string;
  description: string;
  fileName: string;
  language: "env" | "json" | "toml";
  protocol: "anthropic-messages" | "chat-completions" | "responses";
  target: RouteProxyClientAdapterTarget;
  title: string;
}

export interface RouteProxyTransport {
  clearDiagnostics(): Promise<{
    entries: RouteProxyDiagnosticEntry[];
    manifest: RouteProxyDiagnosticsManifest;
  }>;
  clearRequestLogs(): Promise<RouteProxyRequestLog[]>;
  disableDiagnostics(): Promise<RouteProxyDiagnosticsManifest>;
  enableDiagnostics(retention?: Partial<RouteProxyDiagnosticsRetention>): Promise<RouteProxyDiagnosticsManifest>;
  getDefaultConfig(): Promise<RouteProxyDefaultConfig>;
  getDiagnosticsManifest(): Promise<RouteProxyDiagnosticsManifest>;
  getRequestLogs(): Promise<RouteProxyRequestLog[]>;
  getStatus(): Promise<RouteProxyStatus>;
  readDiagnostics(query?: RouteProxyDiagnosticsQuery): Promise<RouteProxyDiagnosticEntry[]>;
  start(request: RouteProxyStartRequest): Promise<RouteProxyStatus>;
  stop(): Promise<RouteProxyStatus>;
}

export const fallbackRouteProxyDefaultConfig: RouteProxyDefaultConfig = {
  listenAddress: "127.0.0.1",
  listenPort: 15_721
};

export const defaultRouteProxyFailureThreshold = 1;
export const minRouteProxyFailureThreshold = 1;
export const maxRouteProxyFailureThreshold = 10;
export const defaultRouteProxyRoutingMode: RouteProxyRoutingMode = "ordered";
export const defaultRouteProxyTargetWeight = 1;
export const minRouteProxyTargetWeight = 1;
export const maxRouteProxyTargetWeight = 10;
export const defaultRouteProxyCooldownMs = 30_000;
export const minRouteProxyCooldownMs = 5_000;
export const maxRouteProxyCooldownMs = 600_000;

export const emptyRouteProxyStatus: RouteProxyStatus = {
  activeConnections: 0,
  address: fallbackRouteProxyDefaultConfig.listenAddress,
  cooldownMs: defaultRouteProxyCooldownMs,
  failedRequests: 0,
  failureThreshold: defaultRouteProxyFailureThreshold,
  lastError: "",
  lastRequestAt: "",
  port: fallbackRouteProxyDefaultConfig.listenPort,
  proxyUrl: "",
  routingMode: defaultRouteProxyRoutingMode,
  running: false,
  startedAt: "",
  successRate: 0,
  successRequests: 0,
  targetBaseUrl: "",
  targetCount: 0,
  targetConfigId: "",
  targetHealth: [],
  targetName: "",
  totalRequests: 0,
  uptimeSeconds: 0
};

export const emptyRouteProxyRequestLogs: RouteProxyRequestLog[] = [];
export const emptyRouteProxyDiagnosticEntries: RouteProxyDiagnosticEntry[] = [];
export const defaultRouteProxyDiagnosticsRetention: RouteProxyDiagnosticsRetention = {
  maxAgeDays: 7,
  maxEntries: 10_000,
  maxTotalBytes: 10_485_760
};
export const emptyRouteProxyDiagnosticsManifest: RouteProxyDiagnosticsManifest = {
  createdAt: "",
  enabled: false,
  retention: defaultRouteProxyDiagnosticsRetention,
  schemaVersion: 1,
  updatedAt: ""
};

export function normalizeRouteProxyFailureThreshold(value: unknown): number {
  const failureThreshold = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  return Number.isInteger(failureThreshold) &&
    failureThreshold >= minRouteProxyFailureThreshold &&
    failureThreshold <= maxRouteProxyFailureThreshold
    ? failureThreshold
    : defaultRouteProxyFailureThreshold;
}

export function normalizeRouteProxyCooldownMs(value: unknown): number {
  const cooldownMs = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  return Number.isInteger(cooldownMs) &&
    cooldownMs >= minRouteProxyCooldownMs &&
    cooldownMs <= maxRouteProxyCooldownMs
    ? cooldownMs
    : defaultRouteProxyCooldownMs;
}

export function createDesktopRouteProxyTransport(
  deskApi: Window["deskApi"] | undefined = typeof window === "undefined" ? undefined : window.deskApi
): RouteProxyTransport | undefined {
  if (!deskApi?.routeProxy) {
    return undefined;
  }

  return {
    clearDiagnostics: () =>
      deskApi.routeProxy?.clearDiagnostics() ??
      Promise.resolve({
        entries: emptyRouteProxyDiagnosticEntries,
        manifest: emptyRouteProxyDiagnosticsManifest
      }),
    clearRequestLogs: () => deskApi.routeProxy?.clearRequestLogs() ?? Promise.resolve(emptyRouteProxyRequestLogs),
    disableDiagnostics: () =>
      deskApi.routeProxy?.disableDiagnostics() ?? Promise.resolve(emptyRouteProxyDiagnosticsManifest),
    enableDiagnostics: (retention?: Partial<RouteProxyDiagnosticsRetention>) =>
      deskApi.routeProxy?.enableDiagnostics(retention) ?? Promise.resolve(emptyRouteProxyDiagnosticsManifest),
    getDefaultConfig: () => deskApi.routeProxy?.getDefaultConfig() ?? Promise.resolve(fallbackRouteProxyDefaultConfig),
    getDiagnosticsManifest: () =>
      deskApi.routeProxy?.getDiagnosticsManifest() ?? Promise.resolve(emptyRouteProxyDiagnosticsManifest),
    getRequestLogs: () => deskApi.routeProxy?.getRequestLogs() ?? Promise.resolve(emptyRouteProxyRequestLogs),
    getStatus: () => deskApi.routeProxy?.getStatus() ?? Promise.resolve(emptyRouteProxyStatus),
    readDiagnostics: (query?: RouteProxyDiagnosticsQuery) =>
      deskApi.routeProxy?.readDiagnostics(query) ?? Promise.resolve(emptyRouteProxyDiagnosticEntries),
    start: (request: RouteProxyStartRequest) =>
      deskApi.routeProxy?.start(request) ?? Promise.resolve(emptyRouteProxyStatus),
    stop: () => deskApi.routeProxy?.stop() ?? Promise.resolve(emptyRouteProxyStatus)
  };
}

export function createRouteProxyTarget(config: ApiConfig, provider: ApiProvider): RouteProxyTarget {
  return {
    authType: provider.authType,
    baseUrl: config.baseUrl,
    configId: config.id,
    configName: config.name,
    endpointMode: config.endpointMode,
    encryptedApiKey: config.encryptedApiKey,
    providerId: provider.id,
    providerType: provider.type,
    weight: defaultRouteProxyTargetWeight
  };
}

export function getRouteProxyConfigProblem(
  config: ApiConfig | undefined,
  provider: ApiProvider | undefined
): string {
  if (!config || !provider) {
    return "请选择可用配置";
  }

  if (!config.isEnabled) {
    return "当前配置未启用";
  }

  if (!config.baseUrl.trim()) {
    return "Base URL 不能为空";
  }

  if (provider.authType !== "none" && !config.encryptedApiKey) {
    return "请先在配置管理中保存 API Key";
  }

  return "";
}

export function formatRouteProxyHostForUrl(address: string): string {
  const normalizedAddress = address === "0.0.0.0" || address === "::" ? "127.0.0.1" : address.trim();

  return normalizedAddress.includes(":") && !normalizedAddress.startsWith("[")
    ? `[${normalizedAddress}]`
    : normalizedAddress;
}

export function createRouteProxyOrigin(address: string, port: number): string {
  return `http://${formatRouteProxyHostForUrl(address || fallbackRouteProxyDefaultConfig.listenAddress)}:${port || fallbackRouteProxyDefaultConfig.listenPort}`;
}

export function getBaseUrlPath(baseUrl: string): string {
  try {
    const path = new URL(baseUrl).pathname.replace(/\/+$/, "");

    return path && path !== "/" ? path : "";
  } catch {
    return "";
  }
}

export function createRouteProxyLocalBaseUrl(address: string, port: number, targetBaseUrl: string): string {
  return `${createRouteProxyOrigin(address, port)}${getBaseUrlPath(targetBaseUrl)}`;
}

export function joinRouteProxyUrlPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function createRouteProxyEndpointExamples(localBaseUrl: string): RouteProxyEndpointExamples {
  return {
    baseUrl: localBaseUrl,
    chatCompletionsUrl: joinRouteProxyUrlPath(localBaseUrl, "chat/completions"),
    modelListUrl: joinRouteProxyUrlPath(localBaseUrl, "models")
  };
}

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

export function createRouteProxyClientAdapterSnippets(
  localBaseUrl: string,
  model: string
): RouteProxyClientAdapterSnippet[] {
  const modelName = model.trim() || "<model-id>";

  return [
    {
      content: `OPENAI_BASE_URL=${localBaseUrl}
OPENAI_API_KEY=desk-api-local-proxy
OPENAI_MODEL=${modelName}`,
      description: "用于 OpenAI SDK 或兼容 Chat Completions 的客户端。",
      fileName: ".env",
      language: "env",
      protocol: "chat-completions",
      target: "openai-sdk",
      title: "OpenAI SDK"
    },
    {
      content: `model = ${quoteToml(modelName)}
model_provider = "desk-api-local-proxy"

[model_providers.desk-api-local-proxy]
name = "Desk API Local Proxy"
base_url = ${quoteToml(localBaseUrl)}
env_key = "DESK_API_PROXY_KEY"
wire_api = "responses"`,
      description: "用于需要 Responses wire API 的 Codex 本地代理入口。",
      fileName: ".codex/config.toml",
      language: "toml",
      protocol: "responses",
      target: "codex-responses",
      title: "Codex Responses"
    },
    {
      content: JSON.stringify(
        {
          model: modelName,
          availableModels: [modelName],
          env: {
            ANTHROPIC_BASE_URL: localBaseUrl,
            ANTHROPIC_API_KEY: "desk-api-local-proxy",
            ANTHROPIC_MODEL: modelName,
            ANTHROPIC_CUSTOM_MODEL_OPTION: modelName,
            ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: modelName
          }
        },
        null,
        2
      ),
      description: "用于走 Anthropic Messages 协议的 Claude Code 本地代理入口。",
      fileName: ".claude/settings.local.json",
      language: "json",
      protocol: "anthropic-messages",
      target: "claude-code",
      title: "Claude Code"
    }
  ];
}

export function createRouteProxyStreamingExample(localBaseUrl: string, model: string): string {
  const chatCompletionsUrl = joinRouteProxyUrlPath(localBaseUrl, "chat/completions");
  const modelName = model.trim() || "<model-id>";

  return `const response = await fetch(${JSON.stringify(chatCompletionsUrl)}, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: ${JSON.stringify(modelName)},
    messages: [{ role: "user", content: "Hello" }],
    stream: true
  })
});

const reader = response.body?.getReader();
if (!reader) {
  throw new Error("Streaming body is unavailable");
}

const decoder = new TextDecoder();
let pending = "";
let receivedText = "";
let shouldStop = false;

while (!shouldStop) {
  const { value, done } = await reader.read();
  if (done) break;

  pending += decoder.decode(value, { stream: true });
  const lines = pending.split("\\n");
  pending = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;

    const event = line.slice(6).trim();
    if (event === "[DONE]") {
      shouldStop = true;
      break;
    }

    receivedText += JSON.parse(event).choices?.[0]?.delta?.content ?? "";
  }
}`;
}
