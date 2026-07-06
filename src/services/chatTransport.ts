import type { ApiProvider, OpenAiEndpointMode } from "../types";

export type ChatRole = "user" | "assistant";

export type ChatTransportContentPart =
  | {
      text: string;
      type: "text";
    }
  | {
      imageUrl: string;
      mimeType: string;
      name?: string;
      type: "image";
    };

export type ChatTransportContent = string | ChatTransportContentPart[];

export interface ChatTransportMessage {
  content: ChatTransportContent;
  role: ChatRole;
}

export interface ChatTransportRequest {
  authType: ApiProvider["authType"];
  baseUrl: string;
  endpointMode: OpenAiEndpointMode;
  encryptedApiKey?: string;
  messages: ChatTransportMessage[];
  model: string;
  providerId: string;
  providerType: ApiProvider["type"];
  thinkingEnabled?: boolean;
  timeoutMs?: number;
}

export interface ChatTransportResult {
  content?: string;
  ok: boolean;
  requestEndpoint?: string;
  responseText?: string;
  latencyMs: number;
  status: number;
}

export interface ChatStreamEvent {
  content?: string;
  latencyMs?: number;
  ok?: boolean;
  requestEndpoint?: string;
  responseText?: string;
  status?: number;
  type: "chunk" | "done" | "error";
}

export interface ChatTransport {
  sendMessage(request: ChatTransportRequest): Promise<ChatTransportResult>;
  streamMessage?(
    request: ChatTransportRequest,
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatTransportResult>;
}

export function createDesktopChatTransport(
  deskApi: Window["deskApi"] | undefined = typeof window === "undefined" ? undefined : window.deskApi
): ChatTransport | undefined {
  const chatApi = deskApi?.chat;

  if (!chatApi) {
    return undefined;
  }

  return {
    sendMessage: (request: ChatTransportRequest) => chatApi.sendMessage(request),
    streamMessage: chatApi.streamMessage
      ? (request: ChatTransportRequest, onEvent: (event: ChatStreamEvent) => void) =>
          chatApi.streamMessage?.(request, onEvent) ?? chatApi.sendMessage(request)
      : undefined
  };
}
