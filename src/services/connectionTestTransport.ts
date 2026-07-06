import type { ApiProvider, OpenAiEndpointMode } from "../types";

export interface OpenAiCompatibleTransportRequest {
  authType: ApiProvider["authType"];
  baseUrl: string;
  endpointMode: OpenAiEndpointMode;
  encryptedApiKey?: string;
  model: string;
  providerId: string;
  providerType: ApiProvider["type"];
  timeoutMs?: number;
}

export interface OpenAiCompatibleTransportResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  requestEndpoint?: string;
  responseText?: string;
}

export interface ConnectionTestTransport {
  testOpenAiCompatible(request: OpenAiCompatibleTransportRequest): Promise<OpenAiCompatibleTransportResult>;
}

export function createDesktopConnectionTestTransport(
  deskApi: Window["deskApi"] | undefined = typeof window === "undefined" ? undefined : window.deskApi
): ConnectionTestTransport | undefined {
  if (!deskApi?.connection) {
    return undefined;
  }

  return {
    testOpenAiCompatible: (request: OpenAiCompatibleTransportRequest) =>
      deskApi.connection.testOpenAiCompatible(request)
  };
}
