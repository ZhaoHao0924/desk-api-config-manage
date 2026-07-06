import { ArrowUp, Brain, MessageSquare, Paperclip, RotateCcw, X } from "lucide-react";
import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatStreamEvent,
  ChatTransport,
  ChatTransportContent,
  ChatTransportMessage
} from "../../services/chatTransport";
import type { ModelFetchTransport, ProviderModelFetchResult } from "../../services/modelFetchTransport";
import { shouldUseOpenAiResponsesApi } from "../../services/connectionTestService";
import type { ApiConfig, ApiProvider, OpenAiEndpointMode, ProviderModel } from "../../types";
import {
  environmentLabels,
  normalizeProviderId,
  openAiEndpointModeLabels,
  openAiEndpointModeOptions
} from "../../types";

type ChatMessage = {
  attachments?: ChatAttachmentSummary[];
  id: string;
  role: "user" | "assistant";
  content: string;
  latencyMs?: number;
  requestContent?: ChatTransportContent;
  requestEndpoint?: string;
  status?: "ok" | "error";
};

type ChatAttachment = ChatAttachmentSummary & {
  content: string;
  dataUrl?: string;
  isImage: boolean;
  isReadable: boolean;
};

type ChatAttachmentSummary = {
  id: string;
  name: string;
  size: number;
  truncated: boolean;
  type: string;
};

const maxChatMessageLength = 12_000;
const maxChatAttachmentCount = 4;
const maxChatAttachmentBytes = 64 * 1024;
const maxChatImageAttachmentBytes = 5 * 1024 * 1024;
const maxChatAttachmentTextLength = 6_000;
const imageAttachmentMimeByExtension: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};
const readableImageAttachmentTypes = new Set(Object.values(imageAttachmentMimeByExtension));
const readableAttachmentExtensions = new Set([
  "c",
  "cjs",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "mjs",
  "py",
  "sql",
  "text",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml"
]);

interface ChatModuleProps {
  configs: ApiConfig[];
  getProviderDisplayName: (providerId: string) => string;
  modelFetchTransport: ModelFetchTransport | undefined;
  onSelectConfig: (configId: string) => void;
  providerModels: ProviderModel[];
  providers: ApiProvider[];
  selectedConfigId: string;
  transport: ChatTransport | undefined;
}

function createChatMessageId(role: ChatMessage["role"]): string {
  return `chat-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getUniqueModelIds(modelIds: string[]): string[] {
  const seenModelIds = new Set<string>();
  const uniqueModelIds: string[] = [];

  for (const modelId of modelIds) {
    const trimmedModelId = modelId.trim();
    const normalizedModelId = trimmedModelId.toLowerCase();

    if (!trimmedModelId || seenModelIds.has(normalizedModelId)) {
      continue;
    }

    seenModelIds.add(normalizedModelId);
    uniqueModelIds.push(trimmedModelId);
  }

  return uniqueModelIds;
}

function getFallbackModelIds(
  config: ApiConfig | undefined,
  provider: ApiProvider | undefined,
  providerModels: ProviderModel[]
): string[] {
  if (!config) {
    return [];
  }

  const catalogModelIds = provider
    ? providerModels.filter((model) => model.providerId === provider.id).map((model) => model.modelId)
    : [];

  return getUniqueModelIds([config.defaultModel, ...catalogModelIds]);
}

function getConfigProblem(config: ApiConfig | undefined, provider: ApiProvider | undefined): string {
  if (!config || !provider) {
    return "请选择可用配置";
  }

  if (!config.isEnabled) {
    return "当前配置未启用";
  }

  if (!config.baseUrl.trim()) {
    return "Base URL \u4e0d\u80fd\u4e3a\u7a7a";
  }

  if (provider.authType !== "none" && !config.encryptedApiKey) {
    return "请先保存 API Key";
  }

  return "";
}

export function isChatThinkingSupported(
  config: Pick<ApiConfig, "baseUrl"> | undefined,
  provider: (Pick<ApiProvider, "id" | "type"> & Partial<Pick<ApiProvider, "authType">>) | undefined,
  endpointMode: OpenAiEndpointMode
): boolean {
  if (!config || !provider) {
    return false;
  }

  if (provider.type === "anthropic") {
    return true;
  }

  return shouldUseOpenAiResponsesApi(config.baseUrl, provider, endpointMode);
}

function getChatFailureMessage(status: number | undefined, responseText: string | undefined): string {
  const statusText = typeof status === "number" && status > 0 ? `HTTP ${status}` : "\u8bf7\u6c42\u5931\u8d25";
  const trimmedResponseText = responseText?.trim();

  return trimmedResponseText
    ? `\u8bf7\u6c42\u5931\u8d25\uff1a${statusText} \u00b7 ${trimmedResponseText.slice(0, 360)}`
    : `\u8bf7\u6c42\u5931\u8d25\uff1a${statusText}`;
}

function getModelFetchFailureStatus(result: ProviderModelFetchResult | undefined, fallback: string): string {
  if (result?.ok === true) {
    return fallback;
  }

  const statusText = typeof result?.status === "number" && result.status > 0 ? `HTTP ${result.status}` : "";
  const errorMessage = result?.errorMessage?.trim();

  if (errorMessage) {
    return `获取模型失败：${errorMessage.slice(0, 180)}`;
  }

  if (statusText) {
    return `获取模型失败：${statusText}`;
  }

  return fallback;
}

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtension(fileName: string): string {
  const extension = fileName.split(".").pop();

  return extension ? extension.trim().toLowerCase() : "";
}

export function isReadableTextAttachmentName(fileName: string, mimeType = ""): boolean {
  return mimeType.toLowerCase().startsWith("text/") || readableAttachmentExtensions.has(getFileExtension(fileName));
}

function canReadAttachmentText(file: File): boolean {
  return isReadableTextAttachmentName(file.name, file.type);
}

function getAttachmentMimeType(file: File): string {
  const extension = getFileExtension(file.name);

  return file.type || imageAttachmentMimeByExtension[extension] || extension || "\u672a\u77e5\u7c7b\u578b";
}

function canReadAttachmentImage(mimeType: string): boolean {
  return readableImageAttachmentTypes.has(mimeType.toLowerCase());
}

function createAttachmentId(file: File): string {
  return `attachment-${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readFileAsDataUrl(file: File, mimeType: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separatorIndex = result.indexOf(",");
      const base64Content = separatorIndex >= 0 ? result.slice(separatorIndex + 1) : "";

      resolve(base64Content ? `data:${mimeType};base64,${base64Content}` : "");
    });
    reader.addEventListener("error", () => reject(new Error("\u6587\u4ef6\u8bfb\u53d6\u5931\u8d25")));
    reader.readAsDataURL(file);
  });
}

async function readChatAttachment(file: File): Promise<ChatAttachment> {
  const mimeType = getAttachmentMimeType(file);
  const isImage = canReadAttachmentImage(mimeType);
  const isReadable = !isImage && canReadAttachmentText(file);
  const truncatedByBytes = file.size > maxChatAttachmentBytes;
  const imageTooLarge = isImage && file.size > maxChatImageAttachmentBytes;
  let content = "";
  let dataUrl = "";
  let truncated = isImage ? imageTooLarge : truncatedByBytes;

  if (isReadable) {
    const rawText = await file.slice(0, maxChatAttachmentBytes).text();
    content = rawText.slice(0, maxChatAttachmentTextLength);
    truncated = truncated || rawText.length > maxChatAttachmentTextLength;
  }

  if (isImage && !imageTooLarge) {
    dataUrl = await readFileAsDataUrl(file, mimeType);
  }

  return {
    content,
    dataUrl: dataUrl || undefined,
    id: createAttachmentId(file),
    isImage,
    isReadable,
    name: file.name,
    size: file.size,
    truncated,
    type: mimeType
  };
}

function createAttachmentPrompt(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  return attachments
    .map((attachment, index) => {
      const header = `\u6587\u4ef6 ${index + 1}: ${attachment.name} (${formatFileSize(attachment.size)}, ${attachment.type})`;
      const suffix = attachment.truncated ? "\n[\u5185\u5bb9\u5df2\u622a\u65ad]" : "";

      if (attachment.isImage) {
        return attachment.dataUrl
          ? `${header}\n[\u56fe\u7247\u5185\u5bb9\u5df2\u4f5c\u4e3a\u89c6\u89c9\u8f93\u5165\u53d1\u9001]`
          : `${header}\n[\u56fe\u7247\u8d85\u8fc7 ${formatFileSize(
              maxChatImageAttachmentBytes
            )}\uff0c\u4ec5\u9644\u4e0a\u6587\u4ef6\u4fe1\u606f]`;
      }

      if (!attachment.isReadable) {
        return `${header}\n[\u8be5\u6587\u4ef6\u4e0d\u662f\u53ef\u76f4\u63a5\u8bfb\u53d6\u7684\u6587\u672c\uff0c\u4ec5\u9644\u4e0a\u6587\u4ef6\u4fe1\u606f]`;
      }

      return `${header}\n${attachment.content || "[\u7a7a\u6587\u4ef6]"}${suffix}`;
    })
    .join("\n\n");
}

function createUserRequestContent(content: string, attachments: ChatAttachment[]): ChatTransportContent {
  const trimmedContent = content.trim();
  const attachmentPrompt = createAttachmentPrompt(attachments);
  const baseContent =
    trimmedContent || (attachmentPrompt ? "\u8bf7\u6839\u636e\u4e0a\u4f20\u6587\u4ef6\u56de\u7b54\u3002" : "");
  const textContent = attachmentPrompt
    ? `${baseContent}\n\n---\n${attachmentPrompt}`.slice(0, maxChatMessageLength)
    : baseContent;
  const imageParts = attachments
    .filter((attachment) => attachment.isImage && attachment.dataUrl)
    .map((attachment) => ({
      imageUrl: attachment.dataUrl ?? "",
      mimeType: attachment.type,
      name: attachment.name,
      type: "image" as const
    }));

  if (imageParts.length === 0) {
    return textContent;
  }

  return textContent
    ? [
        {
          text: textContent,
          type: "text" as const
        },
        ...imageParts
      ]
    : imageParts;
}

function toAttachmentSummary(attachment: ChatAttachment): ChatAttachmentSummary {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    truncated: attachment.truncated,
    type: attachment.type
  };
}

function ChatPanel({
  attachmentStatus,
  attachments,
  canSend,
  config,
  inputValue,
  isSending,
  isThinkingEnabled,
  isThinkingSupported,
  messages,
  model,
  statusMessage,
  onAttachFiles,
  onChangeInput,
  onClear,
  onRemoveAttachment,
  onToggleThinking,
  onSubmit
}: {
  attachmentStatus: string;
  attachments: ChatAttachment[];
  canSend: boolean;
  config: ApiConfig;
  inputValue: string;
  isSending: boolean;
  isThinkingEnabled: boolean;
  isThinkingSupported: boolean;
  messages: ChatMessage[];
  model: string;
  statusMessage: string;
  onAttachFiles: (files: FileList) => void;
  onChangeInput: (value: string) => void;
  onClear: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onToggleThinking: (enabled: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const messagesElement = messagesRef.current;

    if (messagesElement) {
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }
  }, [messages]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;

    if (files && files.length > 0) {
      onAttachFiles(files);
    }

    event.target.value = "";
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();

    if (!canSend || isSending) {
      return;
    }

    formRef.current?.requestSubmit();
  };

  return (
    <section className="chatPanel" aria-label="模型对话">
      <div className="panelTitle">
        <div>
          <h2 className="titleWithIcon">
            <MessageSquare size={16} />
            模型对话
          </h2>
          <p>{`${config.name} / ${model || config.defaultModel}`}</p>
        </div>
        <button
          className="iconButton compactIconButton"
          disabled={isSending || (messages.length === 0 && !inputValue.trim() && attachments.length === 0 && !statusMessage)}
          title="清空对话"
          type="button"
          onClick={onClear}
        >
          <RotateCcw size={17} />
        </button>
      </div>

      <div className="chatMessages" aria-live="polite" ref={messagesRef}>
        {messages.length > 0 ? (
          messages.map((message) => (
            <div
              className={`chatMessage chatMessage-${message.role} ${
                message.status === "error" ? "chatMessage-error" : ""
              }`}
              key={message.id}
            >
              <div className="chatBubble">
                <div className="chatMessageMeta">
                  <strong>{message.role === "user" ? "我" : "模型"}</strong>
                  {typeof message.latencyMs === "number" ? <span>{message.latencyMs}ms</span> : null}
                </div>
                <p>{message.content}</p>
                {message.attachments && message.attachments.length > 0 ? (
                  <div className="chatBubbleAttachments" aria-label="\u9644\u4ef6">
                    {message.attachments.map((attachment) => (
                      <span className="chatAttachmentChip" key={attachment.id}>
                        <Paperclip size={13} />
                        {attachment.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {message.requestEndpoint ? <code>{message.requestEndpoint}</code> : null}
              </div>
            </div>
          ))
        ) : (
          <div className="emptyState">暂无对话</div>
        )}
      </div>

      {statusMessage ? <div className="chatStatus">{statusMessage}</div> : null}

      <form className="chatComposer" ref={formRef} onSubmit={onSubmit}>
        <textarea
          disabled={isSending}
          maxLength={maxChatMessageLength}
          placeholder={`给 ${model || config.name} 发送消息`}
          rows={2}
          value={inputValue}
          onChange={(event) => onChangeInput(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        {attachments.length > 0 ? (
          <div className="chatAttachmentList" aria-label="\u5df2\u9009\u62e9\u6587\u4ef6">
            {attachments.map((attachment) => (
              <span className="chatAttachmentChip removable" key={attachment.id}>
                <Paperclip size={13} />
                <span>{`${attachment.name} · ${formatFileSize(attachment.size)}`}</span>
                <button
                  aria-label={`\u79fb\u9664 ${attachment.name}`}
                  disabled={isSending}
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {attachmentStatus ? <div className="chatAttachmentStatus">{attachmentStatus}</div> : null}
        <div className="chatComposerTools">
          <button
            className={`chatComposerPill ${isThinkingSupported && isThinkingEnabled ? "active" : ""}`}
            aria-pressed={isThinkingSupported && isThinkingEnabled}
            disabled={isSending || !isThinkingSupported}
            title={isThinkingSupported ? "\u6df1\u5ea6\u601d\u8003" : "\u5f53\u524d\u63a5\u53e3\u4e0d\u652f\u6301\u6df1\u5ea6\u601d\u8003"}
            type="button"
            onClick={() => {
              if (isThinkingSupported) {
                onToggleThinking(!isThinkingEnabled);
              }
            }}
          >
            <Brain size={14} />
            {"\u6df1\u5ea6\u601d\u8003"}
          </button>
        </div>
        <input
          className="hiddenFileInput"
          multiple
          onChange={handleFileChange}
          ref={fileInputRef}
          type="file"
        />
        <button
          className="chatComposerIconButton"
          disabled={isSending || attachments.length >= maxChatAttachmentCount}
          title="\u4e0a\u4f20\u6587\u4ef6"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={18} />
        </button>
        <button
          className="chatComposerSendButton"
          disabled={!canSend || isSending}
          aria-label={isSending ? "发送中" : "发送"}
          title={isSending ? "\u53d1\u9001\u4e2d" : "\u53d1\u9001"}
          type="submit"
        >
          <ArrowUp size={18} />
        </button>
      </form>
    </section>
  );
}

export function ChatModule({
  configs,
  getProviderDisplayName,
  modelFetchTransport,
  onSelectConfig,
  providerModels,
  providers,
  selectedConfigId,
  transport
}: ChatModuleProps) {
  const providerLookup = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const [activeConfigId, setActiveConfigId] = useState(selectedConfigId);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatStatus, setChatStatus] = useState("");
  const [isChatSending, setIsChatSending] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelFetchStatus, setModelFetchStatus] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [isStreamingEnabled, setIsStreamingEnabled] = useState(true);
  const [isThinkingEnabled, setIsThinkingEnabled] = useState(false);
  const [selectedEndpointMode, setSelectedEndpointMode] = useState<OpenAiEndpointMode>("auto");
  const [selectedModel, setSelectedModel] = useState("");
  const activeConfigRef = useRef("");

  useEffect(() => {
    if (selectedConfigId && configs.some((config) => config.id === selectedConfigId)) {
      setActiveConfigId(selectedConfigId);
      return;
    }

    if (!configs.some((config) => config.id === activeConfigId)) {
      setActiveConfigId(configs[0]?.id ?? "");
    }
  }, [activeConfigId, configs, selectedConfigId]);

  useEffect(() => {
    setAttachmentStatus("");
    setChatAttachments([]);
    setChatInput("");
    setChatMessages([]);
    setChatStatus("");
    setIsChatSending(false);
    activeConfigRef.current = activeConfigId;
  }, [activeConfigId]);

  const activeConfig = configs.find((config) => config.id === activeConfigId);
  const activeProvider = activeConfig ? providerLookup.get(normalizeProviderId(activeConfig.providerId)) : undefined;
  const effectiveEndpointMode: OpenAiEndpointMode =
    activeProvider?.type === "openai" ? selectedEndpointMode : "auto";
  const isThinkingSupported = isChatThinkingSupported(activeConfig, activeProvider, effectiveEndpointMode);
  const fallbackModelIds = useMemo(
    () => getFallbackModelIds(activeConfig, activeProvider, providerModels),
    [activeConfig, activeProvider, providerModels]
  );
  const configProblem = getConfigProblem(activeConfig, activeProvider);
  const modelProblem = activeConfig && !selectedModel.trim() ? "\u8bf7\u9009\u62e9\u6a21\u578b" : "";
  const activeProblem = configProblem || modelProblem;
  const canSendChat = Boolean(
    transport &&
      activeConfig &&
      activeProvider &&
      !activeProblem &&
      (chatInput.trim() || chatAttachments.length > 0) &&
      !isChatSending
  );

  useEffect(() => {
    setSelectedEndpointMode(activeConfig?.endpointMode ?? "auto");
  }, [activeConfig?.id, activeConfig?.endpointMode]);

  useEffect(() => {
    setIsThinkingEnabled(false);
  }, [activeConfig?.id, effectiveEndpointMode]);

  useEffect(() => {
    let isCurrentRequest = true;

    setModelOptions(fallbackModelIds);
    setSelectedModel((currentModel) =>
      fallbackModelIds.includes(currentModel)
        ? currentModel
        : activeConfig?.defaultModel.trim() || fallbackModelIds[0] || ""
    );
    setModelFetchStatus("");
    setIsFetchingModels(false);

    if (!activeConfig || !activeProvider) {
      return () => {
        isCurrentRequest = false;
      };
    }

    if (!modelFetchTransport) {
      setModelFetchStatus("\u5f53\u524d\u73af\u5883\u4e0d\u80fd\u83b7\u53d6\u6a21\u578b\u5217\u8868");
      return () => {
        isCurrentRequest = false;
      };
    }

    const hasRequiredSecret = activeProvider.authType === "none" || Boolean(activeConfig.encryptedApiKey);

    if (!activeConfig.baseUrl.trim() || !hasRequiredSecret) {
      setModelFetchStatus(
        "\u914d\u7f6e\u4e0d\u5b8c\u6574\uff0c\u6b63\u5728\u4f7f\u7528\u672c\u5730\u6a21\u578b\u9009\u9879"
      );
      return () => {
        isCurrentRequest = false;
      };
    }

    setIsFetchingModels(true);
    setModelFetchStatus("\u6b63\u5728\u83b7\u53d6\u6a21\u578b\u5217\u8868");

    void modelFetchTransport
      .fetchProviderModels({
        apiKey: "",
        authType: activeProvider.authType,
        baseUrl: activeConfig.baseUrl,
        encryptedApiKey: activeConfig.encryptedApiKey,
        providerType: activeProvider.type,
        timeoutMs: 15_000
      })
      .then((result) => {
        if (!isCurrentRequest) {
          return;
        }

        const fetchedModelIds = getUniqueModelIds(result.models);

        if (fetchedModelIds.length === 0) {
          setModelFetchStatus(
            getModelFetchFailureStatus(result, "\u672a\u83b7\u53d6\u5230\u6a21\u578b\uff0c\u6b63\u5728\u4f7f\u7528\u672c\u5730\u6a21\u578b\u9009\u9879")
          );
          return;
        }

        setModelOptions(fetchedModelIds);
        setSelectedModel((currentModel) =>
          fetchedModelIds.includes(currentModel)
            ? currentModel
            : fetchedModelIds.includes(activeConfig.defaultModel.trim())
              ? activeConfig.defaultModel.trim()
              : fetchedModelIds[0]
        );
        setModelFetchStatus(`\u5df2\u83b7\u53d6 ${fetchedModelIds.length} \u4e2a\u6a21\u578b`);
      })
      .catch((error) => {
        if (isCurrentRequest) {
          setModelFetchStatus(
            error instanceof Error
              ? `\u6a21\u578b\u5217\u8868\u83b7\u53d6\u5931\u8d25\uff1a${error.message.slice(0, 180)}`
              : "\u6a21\u578b\u5217\u8868\u83b7\u53d6\u5931\u8d25\uff0c\u6b63\u5728\u4f7f\u7528\u672c\u5730\u6a21\u578b\u9009\u9879"
          );
        }
      })
      .finally(() => {
        if (isCurrentRequest) {
          setIsFetchingModels(false);
        }
      });

    return () => {
      isCurrentRequest = false;
    };
  }, [
    activeConfig,
    activeProvider,
    fallbackModelIds,
    modelFetchTransport
  ]);

  const selectConfig = (configId: string) => {
    setActiveConfigId(configId);
    onSelectConfig(configId);
  };

  const clearChat = () => {
    setAttachmentStatus("");
    setChatAttachments([]);
    setChatInput("");
    setChatMessages([]);
    setChatStatus("");
  };

  const attachFiles = async (files: FileList) => {
    const availableSlots = Math.max(0, maxChatAttachmentCount - chatAttachments.length);
    const selectedFiles = Array.from(files).slice(0, availableSlots);

    if (availableSlots === 0) {
      setAttachmentStatus(`\u6700\u591a\u4e0a\u4f20 ${maxChatAttachmentCount} \u4e2a\u6587\u4ef6`);
      return;
    }

    if (selectedFiles.length === 0) {
      return;
    }

    setAttachmentStatus("\u6b63\u5728\u8bfb\u53d6\u6587\u4ef6");

    try {
      const nextAttachments = await Promise.all(selectedFiles.map((file) => readChatAttachment(file)));
      const skippedCount = files.length - selectedFiles.length;
      const truncatedCount = nextAttachments.filter((attachment) => attachment.truncated && !attachment.isImage).length;
      const imageCount = nextAttachments.filter((attachment) => attachment.dataUrl).length;
      const oversizedImageCount = nextAttachments.filter((attachment) => attachment.isImage && !attachment.dataUrl).length;
      const unreadableCount = nextAttachments.filter((attachment) => !attachment.isReadable && !attachment.isImage).length;
      const notices = [
        skippedCount > 0 ? `\u5df2\u8df3\u8fc7 ${skippedCount} \u4e2a\u8d85\u51fa\u6570\u91cf\u9650\u5236\u7684\u6587\u4ef6` : "",
        imageCount > 0 ? `\u5df2\u6dfb\u52a0 ${imageCount} \u5f20\u56fe\u7247\u89c6\u89c9\u8f93\u5165` : "",
        oversizedImageCount > 0
          ? ` ${oversizedImageCount} \u5f20\u56fe\u7247\u8d85\u8fc7 ${formatFileSize(maxChatImageAttachmentBytes)}\uff0c\u4ec5\u9644\u4e0a\u6587\u4ef6\u4fe1\u606f`
          : "",
        truncatedCount > 0 ? ` ${truncatedCount} \u4e2a\u6587\u4ef6\u5185\u5bb9\u5df2\u622a\u65ad` : "",
        unreadableCount > 0 ? ` ${unreadableCount} \u4e2a\u975e\u6587\u672c\u6587\u4ef6\u4ec5\u9644\u4e0a\u4fe1\u606f` : ""
      ]
        .filter(Boolean)
        .join("\uff1b");

      setChatAttachments((currentAttachments) => [...currentAttachments, ...nextAttachments]);
      setAttachmentStatus(notices || `\u5df2\u9009\u62e9 ${nextAttachments.length} \u4e2a\u6587\u4ef6`);
    } catch {
      setAttachmentStatus("\u6587\u4ef6\u8bfb\u53d6\u5931\u8d25");
    }
  };

  const removeAttachment = (attachmentId: string) => {
    setChatAttachments((currentAttachments) =>
      currentAttachments.filter((attachment) => attachment.id !== attachmentId)
    );
    setAttachmentStatus("");
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!activeConfig || !activeProvider) {
      setChatStatus("请先选择可用配置");
      return;
    }

    if (!transport) {
      setChatStatus("当前环境不能调用模型");
      return;
    }

    if (activeProblem) {
      setChatStatus(activeProblem);
      return;
    }

    const content = chatInput.trim();
    const requestAttachments = chatAttachments;

    if (!content && requestAttachments.length === 0) {
      setChatStatus("请输入消息");
      return;
    }

    const requestConfigId = activeConfig.id;
    const requestContent = createUserRequestContent(content, requestAttachments);
    const userMessage: ChatMessage = {
      attachments: requestAttachments.map(toAttachmentSummary),
      content: content || "\u8bf7\u67e5\u770b\u4e0a\u4f20\u6587\u4ef6",
      id: createChatMessageId("user"),
      requestContent,
      role: "user"
    };
    const requestMessages: ChatTransportMessage[] = [...chatMessages, userMessage]
      .filter((message) => message.status !== "error")
      .slice(-12)
      .map((message) => ({
        content: message.requestContent ?? message.content,
        role: message.role
      }));
    const shouldUseStreaming = isStreamingEnabled && typeof transport.streamMessage === "function";
    const assistantMessageId = createChatMessageId("assistant");
    const chatRequest = {
      authType: activeProvider.authType,
      baseUrl: activeConfig.baseUrl,
      endpointMode: effectiveEndpointMode,
      encryptedApiKey: activeConfig.encryptedApiKey,
      messages: requestMessages,
      model: selectedModel,
      providerId: activeProvider.id,
      providerType: activeProvider.type,
      thinkingEnabled: isThinkingSupported && isThinkingEnabled,
      timeoutMs: 60_000
    };
    let streamedContent = "";
    const updateAssistantMessage = (patch: Partial<ChatMessage>) => {
      setChatMessages((currentMessages) =>
        currentMessages.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                ...patch
              }
            : message
        )
      );
    };
    const handleStreamEvent = (streamEvent: ChatStreamEvent) => {
      if (activeConfigRef.current !== requestConfigId) {
        return;
      }

      if (streamEvent.type === "chunk" && streamEvent.content) {
        streamedContent += streamEvent.content;
        updateAssistantMessage({
          content: streamedContent,
          status: "ok"
        });
        setChatStatus("\u6b63\u5728\u63a5\u6536\u56de\u7b54");
        return;
      }

      if (streamEvent.type === "done") {
        const finalContent =
          streamEvent.content?.trim() ||
          streamedContent.trim() ||
          "\u6a21\u578b\u6ca1\u6709\u8fd4\u56de\u6587\u672c\u5185\u5bb9\u3002";
        updateAssistantMessage({
          content: finalContent,
          latencyMs: streamEvent.latencyMs,
          requestEndpoint: streamEvent.requestEndpoint,
          status: "ok"
        });
        return;
      }

      if (streamEvent.type === "error") {
        const failureMessage = getChatFailureMessage(streamEvent.status, streamEvent.responseText ?? streamEvent.content);
        updateAssistantMessage({
          content: failureMessage,
          latencyMs: streamEvent.latencyMs,
          requestEndpoint: streamEvent.requestEndpoint,
          status: "error"
        });
        setChatStatus(failureMessage);
      }
    };

    setChatMessages((currentMessages) =>
      shouldUseStreaming
        ? [
            ...currentMessages,
            userMessage,
            {
              id: assistantMessageId,
              role: "assistant",
              content: "\u6b63\u5728\u63a5\u6536\u56de\u7b54...",
              status: "ok"
            }
          ]
        : [...currentMessages, userMessage]
    );
    setChatInput("");
    setChatAttachments([]);
    setAttachmentStatus("");
    setChatStatus("发送中");
    setIsChatSending(true);

    try {
      if (shouldUseStreaming && transport.streamMessage) {
        const result = await transport.streamMessage(chatRequest, handleStreamEvent);

        if (activeConfigRef.current !== requestConfigId) {
          return;
        }

        if (result.ok) {
          const finalContent =
            result.content?.trim() ||
            streamedContent.trim() ||
            "\u6a21\u578b\u6ca1\u6709\u8fd4\u56de\u6587\u672c\u5185\u5bb9\u3002";
          updateAssistantMessage({
            content: finalContent,
            latencyMs: result.latencyMs,
            requestEndpoint: result.requestEndpoint,
            status: "ok"
          });
          setChatStatus(`\u5df2\u8fd4\u56de\uff0c${result.latencyMs}ms`);
          return;
        }

        const failureMessage = getChatFailureMessage(result.status, result.responseText);
        updateAssistantMessage({
          content: failureMessage,
          latencyMs: result.latencyMs,
          requestEndpoint: result.requestEndpoint,
          status: "error"
        });
        setChatStatus(`\u8bf7\u6c42\u5931\u8d25\uff1aHTTP ${result.status}`);
        return;
      }

      const result = await transport.sendMessage(chatRequest);

      if (activeConfigRef.current !== requestConfigId) {
        return;
      }

      if (result.ok) {
        setChatMessages((currentMessages) => [
          ...currentMessages,
          {
            id: createChatMessageId("assistant"),
            role: "assistant",
            content: result.content?.trim() || "模型没有返回文本内容。",
            latencyMs: result.latencyMs,
            requestEndpoint: result.requestEndpoint,
            status: "ok"
          }
        ]);
        setChatStatus(`已返回，${result.latencyMs}ms`);
        return;
      }

      const responseText = result.responseText?.trim();
      const failureMessage = responseText
        ? `请求失败：HTTP ${result.status} · ${responseText.slice(0, 360)}`
        : `请求失败：HTTP ${result.status}`;

      setChatMessages((currentMessages) => [
        ...currentMessages,
        {
          id: createChatMessageId("assistant"),
          role: "assistant",
          content: failureMessage,
          latencyMs: result.latencyMs,
          requestEndpoint: result.requestEndpoint,
          status: "error"
        }
      ]);
      setChatStatus(`请求失败，HTTP ${result.status}`);
    } catch (error) {
      if (activeConfigRef.current !== requestConfigId) {
        return;
      }

      if (shouldUseStreaming) {
        const streamErrorMessage =
          error instanceof Error ? error.message : "\u5bf9\u8bdd\u8bf7\u6c42\u5931\u8d25";
        updateAssistantMessage({
          content: streamErrorMessage,
          status: "error"
        });
        setChatStatus(streamErrorMessage);
        return;
      }

      const message = error instanceof Error ? error.message : "对话请求失败";

      setChatMessages((currentMessages) => [
        ...currentMessages,
        {
          id: createChatMessageId("assistant"),
          role: "assistant",
          content: message,
          status: "error"
        }
      ]);
      setChatStatus(message);
    } finally {
      if (activeConfigRef.current === requestConfigId) {
        setIsChatSending(false);
      }
    }
  };

  return (
    <div className="chatModule secondarySection">
      <div className="chatModuleGrid">
        <section className="chatConfigPanel widePanel" aria-label="对话配置">
          <div className="panelTitle">
            <div>
              <h2>对话配置</h2>
              <p>选择要调用的模型配置</p>
            </div>
            <span>{configs.length} 项</span>
          </div>
          <div className="chatSelectors">
            <label className="chatSelectField">
              <span>{"\u914d\u7f6e"}</span>
              <select value={activeConfigId} onChange={(event) => selectConfig(event.target.value)}>
                {configs.length === 0 ? <option value="">{"\u6682\u65e0\u914d\u7f6e"}</option> : null}
                {configs.map((config) => (
                  <option key={config.id} value={config.id}>
                    {`${config.name} / ${getProviderDisplayName(config.providerId)}`}
                  </option>
                ))}
              </select>
            </label>

            <label className="chatSelectField">
              <span>{"\u6a21\u578b"}</span>
              <select
                disabled={!activeConfig || isFetchingModels || modelOptions.length === 0}
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                {modelOptions.length === 0 ? <option value="">{"\u6682\u65e0\u6a21\u578b"}</option> : null}
                {modelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
              </select>
            </label>

            {activeProvider?.type === "openai" ? (
              <label className="chatSelectField">
                <span>{"\u63a5\u53e3\u6a21\u5f0f"}</span>
                <select
                  value={selectedEndpointMode}
                  onChange={(event) => setSelectedEndpointMode(event.target.value as OpenAiEndpointMode)}
                >
                  {openAiEndpointModeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="chatToggleField">
              <input
                checked={isStreamingEnabled}
                disabled={isChatSending || !transport?.streamMessage}
                type="checkbox"
                onChange={(event) => setIsStreamingEnabled(event.target.checked)}
              />
              <span>{"\u6d41\u5f0f\u54cd\u5e94"}</span>
            </label>

            <div className="chatSelectedSummary">
              <span>{activeProvider ? getProviderDisplayName(activeProvider.id) : "\u672a\u9009\u62e9\u4f9b\u5e94\u5546"}</span>
              <span>{activeConfig ? environmentLabels[activeConfig.environment] : "\u672a\u9009\u62e9\u73af\u5883"}</span>
            </div>

            {modelFetchStatus ? <div className="chatSelectStatus">{modelFetchStatus}</div> : null}
          </div>

          <div className="chatConfigList" hidden />
        </section>

        {activeConfig ? (
          <ChatPanel
            attachmentStatus={attachmentStatus}
            attachments={chatAttachments}
            canSend={canSendChat}
            config={activeConfig}
            inputValue={chatInput}
            isSending={isChatSending}
            isThinkingEnabled={isThinkingEnabled}
            isThinkingSupported={isThinkingSupported}
            messages={chatMessages}
            model={selectedModel}
            statusMessage={chatStatus || activeProblem}
            onAttachFiles={attachFiles}
            onChangeInput={setChatInput}
            onClear={clearChat}
            onRemoveAttachment={removeAttachment}
            onToggleThinking={setIsThinkingEnabled}
            onSubmit={sendMessage}
          />
        ) : (
          <section className="chatPanel" aria-label="模型对话">
            <div className="panelTitle">
              <div>
                <h2 className="titleWithIcon">
                  <MessageSquare size={16} />
                  模型对话
                </h2>
                <p>请选择配置</p>
              </div>
            </div>
            <div className="emptyState spacious">暂无可用配置</div>
          </section>
        )}

        {activeConfig && activeProvider ? (
          <section className="chatInfoPanel widePanel" aria-label="对话详情">
            <div className="panelTitle">
              <div>
                <h2>调用详情</h2>
                <p>{getProviderDisplayName(activeConfig.providerId)}</p>
              </div>
            </div>
            <dl className="chatInfoList">
              <div>
                <dt>Base URL</dt>
                <dd>{activeConfig.baseUrl}</dd>
              </div>
              <div>
                <dt>{"\u6a21\u578b"}</dt>
                <dd>{selectedModel || activeConfig.defaultModel}</dd>
              </div>
              <div>
                <dt>接口模式</dt>
                <dd>
                  {activeProvider.type === "openai"
                    ? openAiEndpointModeLabels[effectiveEndpointMode]
                    : "\u4e0d\u9002\u7528"}
                </dd>
              </div>
              <div>
                <dt>{"\u54cd\u5e94\u6a21\u5f0f"}</dt>
                <dd>{isStreamingEnabled && transport?.streamMessage ? "\u6d41\u5f0f" : "\u666e\u901a"}</dd>
              </div>
              <div>
                <dt>{"\u601d\u8003\u6a21\u5f0f"}</dt>
                <dd>{isThinkingSupported ? (isThinkingEnabled ? "\u5f00\u542f" : "\u5173\u95ed") : "\u4e0d\u9002\u7528"}</dd>
              </div>
              <div>
                <dt>认证</dt>
                <dd>{activeProvider.authType === "none" ? "无需密钥" : activeConfig.hasApiKey ? "已保存密钥" : "缺少密钥"}</dd>
              </div>
            </dl>
          </section>
        ) : null}
      </div>
    </div>
  );
}
