import type { ApiProvider, OpenAiEndpointMode } from "../types";

/** A custom header entry passed to the main process.
 * Non-secret headers carry plaintext value.
 * Secret headers carry encrypted ciphertext; the main process decrypts them. */
export interface TransportCustomHeader {
  key: string;
  encryptedValue?: string;
  plaintextValue?: string;
  isSecret: boolean;
}

export interface OpenAiCompatibleTransportRequest {
  authType: ApiProvider["authType"];
  baseUrl: string;
  endpointMode: OpenAiEndpointMode;
  encryptedApiKey?: string;
  model: string;
  providerId: string;
  providerType: ApiProvider["type"];
  timeoutMs?: number;
  customHeaders?: TransportCustomHeader[];
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
