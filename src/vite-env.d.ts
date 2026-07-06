/// <reference types="vite/client" />

type DeskApiChatContent =
  | string
  | Array<
      | {
          text: string;
          type: "text";
        }
      | {
          imageUrl: string;
          mimeType: string;
          name?: string;
          type: "image";
        }
    >;

type DeskApiRouteProxyDiagnosticsRetention = {
  maxAgeDays: number;
  maxEntries: number;
  maxTotalBytes: number;
};

type DeskApiRouteProxyDiagnosticsManifest = {
  createdAt: string;
  enabled: boolean;
  retention: DeskApiRouteProxyDiagnosticsRetention;
  schemaVersion: 1;
  updatedAt: string;
};

type DeskApiRouteProxyDiagnosticEntry = {
  attempt: number;
  completedAt: string;
  errorCode: string;
  errorMessage: string;
  eventType: "request" | "target-health";
  id: string;
  latencyMs: number;
  method: string;
  ok: boolean;
  path: string;
  profileId: string;
  result: "success" | "upstream-http-error" | "network-error" | "proxy-error" | "client-error" | "target-health-change";
  schemaVersion: 1;
  startedAt: string;
  statusCode: number;
  targetConfigId: string;
  targetHealthState: "available" | "cooling-down";
  targetOrdinal: number;
};

type DeskApiRouteProxyDiagnosticsQuery = {
  eventType?: "request" | "target-health";
  limit?: number;
  ok?: boolean;
  profileId?: string;
  since?: string;
  targetConfigId?: string;
};

interface Window {
  deskApi?: {
    getAppVersion: () => Promise<string>;
    secrets: {
      isEncryptionAvailable: () => Promise<boolean>;
      encrypt: (plaintext: string) => Promise<string>;
      decrypt: (encryptedValue: string) => Promise<string>;
      copyToClipboard: (
        plaintext: string,
        options?: {
          clearAfterMs?: number;
        }
      ) => Promise<{
        clearAfterMs: number;
      }>;
    };
    clipboard: {
      writeText: (text: string) => Promise<{
        ok: boolean;
      }>;
    };
    window?: {
      close: () => Promise<{
        ok: boolean;
      }>;
      minimize: () => Promise<{
        ok: boolean;
      }>;
      toggleMaximize: () => Promise<{
        maximized: boolean;
        ok: boolean;
      }>;
    };
    connection: {
      testOpenAiCompatible: (request: {
        authType: "bearer" | "api-key-header" | "none";
        baseUrl: string;
        endpointMode: "auto" | "chat-completions" | "responses";
        encryptedApiKey?: string;
        model: string;
        providerId: string;
        providerType:
          | "anthropic"
          | "openai"
          | "azure-openai"
          | "deepseek"
          | "qwen"
          | "zhipu"
          | "ollama"
          | "lm-studio"
          | "custom";
        thinkingEnabled?: boolean;
        timeoutMs?: number;
      }) => Promise<{
        ok: boolean;
        status: number;
        latencyMs: number;
        requestEndpoint?: string;
        responseText?: string;
      }>;
    };
    chat?: {
      sendMessage: (request: {
        authType: "bearer" | "api-key-header" | "none";
        baseUrl: string;
        endpointMode: "auto" | "chat-completions" | "responses";
        encryptedApiKey?: string;
        messages: Array<{
          content: DeskApiChatContent;
          role: "user" | "assistant";
        }>;
        model: string;
        providerId: string;
        providerType:
          | "anthropic"
          | "openai"
          | "azure-openai"
          | "deepseek"
          | "qwen"
          | "zhipu"
          | "ollama"
          | "lm-studio"
          | "custom";
        thinkingEnabled?: boolean;
        timeoutMs?: number;
      }) => Promise<{
        content?: string;
        ok: boolean;
        requestEndpoint?: string;
        responseText?: string;
        latencyMs: number;
        status: number;
      }>;
      streamMessage?: (
        request: {
          authType: "bearer" | "api-key-header" | "none";
          baseUrl: string;
          endpointMode: "auto" | "chat-completions" | "responses";
          encryptedApiKey?: string;
          messages: Array<{
            content: DeskApiChatContent;
            role: "user" | "assistant";
          }>;
          model: string;
          providerId: string;
          providerType:
            | "anthropic"
            | "openai"
            | "azure-openai"
            | "deepseek"
            | "qwen"
            | "zhipu"
            | "ollama"
            | "lm-studio"
            | "custom";
          thinkingEnabled?: boolean;
          timeoutMs?: number;
        },
        onEvent: (event: {
          content?: string;
          latencyMs?: number;
          ok?: boolean;
          requestEndpoint?: string;
          responseText?: string;
          status?: number;
          type: "chunk" | "done" | "error";
        }) => void
      ) => Promise<{
        content?: string;
        ok: boolean;
        requestEndpoint?: string;
        responseText?: string;
        latencyMs: number;
        status: number;
      }>;
    };
    models: {
      fetchProviderModels: (request: {
        apiKey: string;
        authType: "bearer" | "api-key-header" | "none";
        baseUrl: string;
        encryptedApiKey?: string;
        providerType:
          | "anthropic"
          | "openai"
          | "azure-openai"
          | "deepseek"
          | "qwen"
          | "zhipu"
          | "ollama"
          | "lm-studio"
          | "custom";
        timeoutMs?: number;
      }) => Promise<{
        errorMessage?: string;
        models: string[];
        ok?: boolean;
        requestEndpoint?: string;
        status?: number;
      }>;
    };
    routeProxy?: {
      getDefaultConfig: () => Promise<{
        listenAddress: string;
        listenPort: number;
      }>;
      getRequestLogs: () => Promise<
        Array<{
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
        }>
      >;
      getStatus: () => Promise<{
        activeConnections: number;
        address: string;
        cooldownMs: number;
        failedRequests: number;
        failureThreshold: number;
        lastError: string;
        lastRequestAt: string;
        port: number;
        proxyUrl: string;
        routingMode: "ordered" | "weighted";
        running: boolean;
        startedAt: string;
        successRate: number;
        successRequests: number;
        targetBaseUrl: string;
        targetCount: number;
        targetConfigId: string;
        targetHealth: Array<{
          baseUrl: string;
          configId: string;
          failureCount: number;
          lastError: string;
          name: string;
          state: "available" | "cooling-down";
          unavailableUntil: string;
          weight: number;
        }>;
        targetName: string;
        totalRequests: number;
        uptimeSeconds: number;
      }>;
      start: (request: {
        cooldownMs?: number;
        failureThreshold?: number;
        listenAddress: string;
        listenPort: number;
        profileId?: string;
        routingMode?: "ordered" | "weighted";
        target: {
          authType: "bearer" | "api-key-header" | "none";
          baseUrl: string;
          configId: string;
          configName: string;
          endpointMode: "auto" | "chat-completions" | "responses";
          encryptedApiKey?: string;
          providerId: string;
          providerType:
            | "anthropic"
            | "openai"
            | "azure-openai"
            | "deepseek"
            | "qwen"
            | "zhipu"
            | "ollama"
            | "lm-studio"
            | "custom";
          weight?: number;
        };
        targets?: Array<{
          authType: "bearer" | "api-key-header" | "none";
          baseUrl: string;
          configId: string;
          configName: string;
          endpointMode: "auto" | "chat-completions" | "responses";
          encryptedApiKey?: string;
          providerId: string;
          providerType:
            | "anthropic"
            | "openai"
            | "azure-openai"
            | "deepseek"
            | "qwen"
            | "zhipu"
            | "ollama"
            | "lm-studio"
            | "custom";
          weight?: number;
        }>;
        timeoutMs?: number;
      }) => Promise<{
        activeConnections: number;
        address: string;
        cooldownMs: number;
        failedRequests: number;
        failureThreshold: number;
        lastError: string;
        lastRequestAt: string;
        port: number;
        proxyUrl: string;
        routingMode: "ordered" | "weighted";
        running: boolean;
        startedAt: string;
        successRate: number;
        successRequests: number;
        targetBaseUrl: string;
        targetCount: number;
        targetConfigId: string;
        targetHealth: Array<{
          baseUrl: string;
          configId: string;
          failureCount: number;
          lastError: string;
          name: string;
          state: "available" | "cooling-down";
          unavailableUntil: string;
          weight: number;
        }>;
        targetName: string;
        totalRequests: number;
        uptimeSeconds: number;
      }>;
      clearRequestLogs: () => Promise<
        Array<{
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
        }>
      >;
      getDiagnosticsManifest: () => Promise<DeskApiRouteProxyDiagnosticsManifest>;
      enableDiagnostics: (
        retention?: Partial<DeskApiRouteProxyDiagnosticsRetention>
      ) => Promise<DeskApiRouteProxyDiagnosticsManifest>;
      disableDiagnostics: () => Promise<DeskApiRouteProxyDiagnosticsManifest>;
      readDiagnostics: (
        query?: DeskApiRouteProxyDiagnosticsQuery
      ) => Promise<DeskApiRouteProxyDiagnosticEntry[]>;
      clearDiagnostics: () => Promise<{
        entries: DeskApiRouteProxyDiagnosticEntry[];
        manifest: DeskApiRouteProxyDiagnosticsManifest;
      }>;
      stop: () => Promise<{
        activeConnections: number;
        address: string;
        cooldownMs: number;
        failedRequests: number;
        failureThreshold: number;
        lastError: string;
        lastRequestAt: string;
        port: number;
        proxyUrl: string;
        routingMode: "ordered" | "weighted";
        running: boolean;
        startedAt: string;
        successRate: number;
        successRequests: number;
        targetBaseUrl: string;
        targetCount: number;
        targetConfigId: string;
        targetHealth: Array<{
          baseUrl: string;
          configId: string;
          failureCount: number;
          lastError: string;
          name: string;
          state: "available" | "cooling-down";
          unavailableUntil: string;
          weight: number;
        }>;
        targetName: string;
        totalRequests: number;
        uptimeSeconds: number;
      }>;
    };
  };
}
