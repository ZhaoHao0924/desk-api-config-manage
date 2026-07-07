import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clipboard,
  Database,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  Gauge,
  KeyRound,
  MessageSquare,
  Pencil,
  Plus,
  Route,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  X,
  XCircle
} from "lucide-react";
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultProviders } from "./data/sampleData";
import { ChatModule } from "./features/chat/ChatModule";
import { RouteProxyModule } from "./features/routeProxy/RouteProxyModule";
import {
  codingToolLabels,
  type CodingToolTarget,
  generateCodingToolConfig
} from "./services/codingToolConfigGenerator";
import { createDesktopChatTransport } from "./services/chatTransport";
import { runConnectionTest } from "./services/connectionTestService";
import { createDesktopConnectionTestTransport } from "./services/connectionTestTransport";
import { createApiConfig, deleteApiConfig, updateApiConfig } from "./services/configService";
import {
  createDesktopModelFetchTransport,
  type ProviderModelFetchResult
} from "./services/modelFetchTransport";
import {
  createLocalStorageRouteProxyProfileStore,
  createRouteProxyProfileId,
  routeProxyProfileSchemaVersion,
  routeProxyProfileStorageKey,
  type RouteProxyProfile
} from "./services/routeProxyProfileStore";
import {
  createDesktopRouteProxyTransport,
  defaultRouteProxyCooldownMs,
  defaultRouteProxyFailureThreshold,
  defaultRouteProxyRoutingMode,
  defaultRouteProxyTargetWeight,
  fallbackRouteProxyDefaultConfig
} from "./services/routeProxyTransport";
import { createDesktopSecretService } from "./services/secretService";
import {
  LocalStorageConfigRepository,
  localStorageDatabaseKey,
  localStorageDatabaseSchemaVersion
} from "./storage/localStorageDatabase";
import type {
  ApiConfig,
  ApiProvider,
  EnvironmentName,
  OpenAiEndpointMode,
  ProviderModel,
  TestHistoryItem,
  TestStatus
} from "./types";
import {
  environmentLabels,
  environmentOptions,
  modelCapabilityLabels,
  normalizeProviderId,
  openAiEndpointModeLabels,
  openAiEndpointModeOptions,
  openAiCompatibleProviderId,
  providerModelStatusLabels
} from "./types";

const statusMeta: Record<TestStatus, { label: string; className: string }> = {
  success: { label: "可用", className: "statusSuccess" },
  failed: { label: "异常", className: "statusFailed" },
  untested: { label: "未测试", className: "statusMuted" }
};

interface ConfigFormState {
  name: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  endpointMode: OpenAiEndpointMode;
  environment: EnvironmentName;
  tagsText: string;
  notes: string;
  isEnabled: boolean;
}

interface DesktopRuntimeInfo {
  appVersion: string;
  electronVersion: string;
  isDev: boolean;
  userDataPath: string;
}

interface RouteProxyProfileInventorySummary {
  degradedCount: number;
  staleCount: number;
  totalCount: number;
  usableCount: number;
}

type FormMode = "view" | "create" | "edit";
type AppSection = "configs" | "chat" | "proxy" | "tests" | "providers" | "security" | "settings";
type ProviderFilterItem = { id: string; label: string; count: number };
type ProviderSelectOption = { value: string; label: string };

const allProviderFilterId = "all";
const allProviderFilterLabel = "\u5168\u90e8";
export const openAiCompatibleProviderFilterId = openAiCompatibleProviderId;
const openAiCompatibleProviderFilterLabel = "OpenAI-compatible";
const unknownProviderName = "\u672a\u77e5\u4f9b\u5e94\u5546";

const authTypeLabels: Record<ApiProvider["authType"], string> = {
  bearer: "Bearer",
  "api-key-header": "API Key Header",
  none: "无需密钥"
};

const sectionTitles: Record<AppSection, string> = {
  chat: "模型对话",
  configs: "配置管理",
  proxy: "路由代理",
  tests: "测试中心",
  providers: "供应商模板",
  security: "安全中心",
  settings: "设置"
};

function StatusIcon({ status }: { status: TestStatus }) {
  if (status === "success") {
    return <CheckCircle2 size={16} />;
  }

  if (status === "failed") {
    return <XCircle size={16} />;
  }

  return <AlertTriangle size={16} />;
}

function getHistorySummary(item: TestHistoryItem): string {
  if (item.status === "success") {
    return typeof item.latencyMs === "number" ? `${item.latencyMs}ms` : "连接成功";
  }

  return item.errorMessage ?? item.errorCode ?? "连接失败";
}

function TestHistoryDetails({ item }: { item: TestHistoryItem }) {
  const latencyText = typeof item.latencyMs === "number" ? `${item.latencyMs}ms` : undefined;
  const hasDetails = Boolean(item.errorCode || item.requestEndpoint || item.errorDetail || latencyText);

  if (!hasDetails) {
    return null;
  }

  return (
    <details className="historyDetails">
      <summary>详情</summary>
      <dl>
        {item.errorCode ? (
          <>
            <dt>错误码</dt>
            <dd>{item.errorCode}</dd>
          </>
        ) : null}
        {latencyText ? (
          <>
            <dt>耗时</dt>
            <dd>{latencyText}</dd>
          </>
        ) : null}
        {item.requestEndpoint ? (
          <>
            <dt>端点</dt>
            <dd>{item.requestEndpoint}</dd>
          </>
        ) : null}
        {item.errorDetail ? (
          <>
            <dt>响应</dt>
            <dd className="historyDetailBlock">{item.errorDetail}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

function toTags(tagsText: string): string[] {
  return tagsText
    .split(/[,\n，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function isOpenAiEndpointMode(value: unknown): value is OpenAiEndpointMode {
  return value === "auto" || value === "chat-completions" || value === "responses";
}

function readEndpointMode(value: unknown): OpenAiEndpointMode {
  return isOpenAiEndpointMode(value) ? value : "auto";
}

function createEmptyForm(provider?: ApiProvider): ConfigFormState {
  return {
    name: "",
    providerId: provider?.id ?? defaultProviders[0].id,
    baseUrl: provider?.defaultBaseUrl ?? "",
    apiKey: "",
    defaultModel: "",
    endpointMode: "auto",
    environment: "development",
    tagsText: "",
    notes: "",
    isEnabled: true
  };
}

function createEditForm(config: ApiConfig): ConfigFormState {
  return {
    name: config.name,
    providerId: normalizeProviderId(config.providerId),
    baseUrl: config.baseUrl,
    apiKey: "",
    defaultModel: config.defaultModel,
    endpointMode: readEndpointMode(config.endpointMode),
    environment: config.environment,
    tagsText: config.tags.join(", "),
    notes: config.notes,
    isEnabled: config.isEnabled
  };
}

export function getBaseUrlAfterProviderChange(
  currentBaseUrl: string,
  currentProvider: ApiProvider | undefined,
  nextProvider: ApiProvider
): string {
  const trimmedCurrentBaseUrl = currentBaseUrl.trim();
  const previousDefaultBaseUrl = currentProvider?.defaultBaseUrl.trim() ?? "";

  if (!trimmedCurrentBaseUrl || (previousDefaultBaseUrl && trimmedCurrentBaseUrl === previousDefaultBaseUrl)) {
    return nextProvider.defaultBaseUrl || "";
  }

  return currentBaseUrl;
}

export function pickCreateProvider(providers: ApiProvider[], providerFilter: string): ApiProvider {
  const candidateProviders = providers.length > 0 ? providers : defaultProviders;
  const normalizedProviderFilter = normalizeProviderId(providerFilter);
  const filteredProvider =
    normalizedProviderFilter === openAiCompatibleProviderFilterId
      ? candidateProviders.find(isOpenAiCompatibleProvider)
      : normalizedProviderFilter !== allProviderFilterId
        ? candidateProviders.find((provider) => provider.id === normalizedProviderFilter)
        : undefined;

  return filteredProvider ?? candidateProviders[0] ?? defaultProviders[0];
}

export function isOpenAiCompatibleProvider(provider: ApiProvider): boolean {
  return provider.type === "openai";
}

export function shouldShowEndpointMode(provider: ApiProvider | undefined): boolean {
  return Boolean(provider && isOpenAiCompatibleProvider(provider));
}

export function getProviderDisplayName(providerId: string, providers: ApiProvider[]): string {
  const candidateProviders = providers.length > 0 ? providers : defaultProviders;
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = candidateProviders.find((item) => item.id === normalizedProviderId);

  return provider && isOpenAiCompatibleProvider(provider)
    ? openAiCompatibleProviderFilterLabel
    : provider?.name ?? unknownProviderName;
}

export function getProviderFilterLabel(providerFilter: string, providers: ApiProvider[]): string {
  const candidateProviders = providers.length > 0 ? providers : defaultProviders;
  const normalizedProviderFilter = normalizeProviderId(providerFilter);

  if (normalizedProviderFilter === allProviderFilterId) {
    return allProviderFilterLabel;
  }

  if (normalizedProviderFilter === openAiCompatibleProviderFilterId) {
    return openAiCompatibleProviderFilterLabel;
  }

  const provider = candidateProviders.find((item) => item.id === normalizedProviderFilter);
  return provider && isOpenAiCompatibleProvider(provider)
    ? openAiCompatibleProviderFilterLabel
    : provider?.name ?? allProviderFilterLabel;
}

export function configMatchesProviderFilter(
  config: ApiConfig,
  providerFilter: string,
  providers: ApiProvider[]
): boolean {
  const candidateProviders = providers.length > 0 ? providers : defaultProviders;
  const normalizedProviderFilter = normalizeProviderId(providerFilter);

  if (normalizedProviderFilter === allProviderFilterId) {
    return true;
  }

  if (normalizedProviderFilter === openAiCompatibleProviderFilterId) {
    const normalizedConfigProviderId = normalizeProviderId(config.providerId);
    const provider = candidateProviders.find((item) => item.id === normalizedConfigProviderId);
    return Boolean(provider && isOpenAiCompatibleProvider(provider));
  }

  return normalizeProviderId(config.providerId) === normalizedProviderFilter;
}

export function createProviderFilterItems(configs: ApiConfig[], providers: ApiProvider[]): ProviderFilterItem[] {
  const candidateProviders = providers.length > 0 ? providers : defaultProviders;
  const items: ProviderFilterItem[] = [];
  let hasOpenAiCompatibleItem = false;

  for (const provider of candidateProviders) {
    if (isOpenAiCompatibleProvider(provider)) {
      if (hasOpenAiCompatibleItem) {
        continue;
      }

      items.push({
        id: openAiCompatibleProviderFilterId,
        label: openAiCompatibleProviderFilterLabel,
        count: configs.filter((config) =>
          configMatchesProviderFilter(config, openAiCompatibleProviderFilterId, candidateProviders)
        ).length
      });
      hasOpenAiCompatibleItem = true;
      continue;
    }

    items.push({
      id: provider.id,
      label: provider.name,
      count: configs.filter((config) => configMatchesProviderFilter(config, provider.id, candidateProviders)).length
    });
  }

  return items;
}

export function createProviderSelectOptions(providers: ApiProvider[]): ProviderSelectOption[] {
  const candidateProviders = providers.length > 0 ? providers : defaultProviders;
  const options: ProviderSelectOption[] = [];
  let hasOpenAiCompatibleOption = false;

  for (const provider of candidateProviders) {
    if (isOpenAiCompatibleProvider(provider)) {
      if (hasOpenAiCompatibleOption) {
        continue;
      }

      options.push({
        value: openAiCompatibleProviderFilterId,
        label: openAiCompatibleProviderFilterLabel
      });
      hasOpenAiCompatibleOption = true;
      continue;
    }

    options.push({
      value: provider.id,
      label: provider.name
    });
  }

  return options;
}

export function getProviderSelectValue(providerId: string, providers: ApiProvider[]): string {
  const candidateProviders = providers.length > 0 ? providers : defaultProviders;
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = candidateProviders.find((item) => item.id === normalizedProviderId);

  return provider && isOpenAiCompatibleProvider(provider) ? openAiCompatibleProviderFilterId : normalizedProviderId;
}

export function getFetchedModelSelectValue(modelOptions: string[], defaultModel: string): string {
  return modelOptions.includes(defaultModel) ? defaultModel : "";
}

export function getDefaultModelAfterFetch(currentDefaultModel: string, modelOptions: string[]): string {
  return currentDefaultModel.trim() ? currentDefaultModel : modelOptions[0] ?? currentDefaultModel;
}

export function getLatestProviderModelFetchedAt(models: ProviderModel[]): string {
  return models
    .map((model) => {
      const value = typeof model.fetchedAt === "string" ? model.fetchedAt : "";
      const timestamp = Date.parse(value);

      return Number.isFinite(timestamp) ? { timestamp, value } : undefined;
    })
    .filter((item): item is { timestamp: number; value: string } => Boolean(item))
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.value ?? "";
}

export function formatLocalDateTime(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    hour12: false
  });
}

export function formatProviderModelFetchedAt(value: string): string {
  return formatLocalDateTime(value);
}

export function getRuntimeDisplayLabel(isDesktop: boolean, isDev?: boolean): string {
  if (!isDesktop) {
    return "浏览器预览";
  }

  if (isDev === undefined) {
    return "Electron";
  }

  return isDev ? "Electron 开发模式" : "Electron 生产模式";
}

export function getRuntimeVersionDisplayLabel(version: string | undefined, fallback = "读取中"): string {
  const normalizedVersion = version?.trim() ?? "";

  return normalizedVersion || fallback;
}

export function getStorageOriginDisplayLabel(origin: string, protocol = ""): string {
  if (origin && origin !== "null") {
    return origin;
  }

  if (protocol === "file:") {
    return "file://";
  }

  return "未知来源";
}

export function getStoragePageUrlDisplayLabel(href: string): string {
  const trimmedHref = href.trim();

  if (!trimmedHref) {
    return "未知地址";
  }

  try {
    const parsedHref = new URL(trimmedHref);

    parsedHref.search = "";
    parsedHref.hash = "";
    return parsedHref.toString();
  } catch {
    return trimmedHref.slice(0, 500);
  }
}

export function getLocalStorageKeyDisplayLabel(key: string): string {
  return `localStorage / ${key}`;
}

export function getStorageItemCountDisplayLabel(count: number): string {
  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;

  return `${normalizedCount} 项`;
}

export function getStorageSchemaDisplayLabel(version: number): string {
  const normalizedVersion = Number.isFinite(version) ? Math.max(0, Math.trunc(version)) : 0;

  return `快照 v${normalizedVersion}`;
}

export function summarizeRouteProxyProfileInventory(
  profiles: RouteProxyProfile[],
  configs: ApiConfig[]
): RouteProxyProfileInventorySummary {
  const configIds = new Set(configs.map((config) => config.id));
  const summary: RouteProxyProfileInventorySummary = {
    degradedCount: 0,
    staleCount: 0,
    totalCount: profiles.length,
    usableCount: 0
  };

  for (const profile of profiles) {
    if (!configIds.has(profile.configId)) {
      summary.staleCount += 1;
      continue;
    }

    summary.usableCount += 1;

    if (profile.failoverConfigIds.some((configId) => !configIds.has(configId))) {
      summary.degradedCount += 1;
    }
  }

  return summary;
}

export function getEnabledConnectionTestTargets(configs: ApiConfig[]): ApiConfig[] {
  return configs.filter((config) => config.isEnabled);
}

export interface ConnectionTestBatchTarget {
  config: ApiConfig;
  provider: ApiProvider;
}

export interface ConnectionTestBatchPlan {
  skippedCount: number;
  targets: ConnectionTestBatchTarget[];
}

export interface ConnectionTestBatchRunResult {
  failedCount: number;
  isCanceled: boolean;
  skippedCount: number;
  successCount: number;
  totalCount: number;
}

export type ConnectionTestBatchTargetResult = "success" | "failed";

export function createConnectionTestBatchPlan(configs: ApiConfig[], providers: ApiProvider[]): ConnectionTestBatchPlan {
  const providerById = new Map(providers.map((provider) => [normalizeProviderId(provider.id), provider]));

  return configs.reduce<ConnectionTestBatchPlan>(
    (plan, config) => {
      if (!config.isEnabled) {
        return plan;
      }

      const provider = providerById.get(normalizeProviderId(config.providerId));

      if (!provider) {
        plan.skippedCount += 1;
        return plan;
      }

      plan.targets.push({ config, provider });
      return plan;
    },
    { skippedCount: 0, targets: [] }
  );
}

export async function runConnectionTestBatchPlan(
  plan: ConnectionTestBatchPlan,
  options: {
    isCanceled: () => boolean;
    onTargetComplete?: (target: ConnectionTestBatchTarget) => Promise<void> | void;
    onTargetStart?: (target: ConnectionTestBatchTarget, index: number, targetCount: number) => Promise<void> | void;
    runTarget: (target: ConnectionTestBatchTarget) => Promise<ConnectionTestBatchTargetResult>;
  }
): Promise<ConnectionTestBatchRunResult> {
  let successCount = 0;
  let failedCount = 0;

  for (const [index, target] of plan.targets.entries()) {
    if (options.isCanceled()) {
      break;
    }

    await options.onTargetStart?.(target, index, plan.targets.length);

    if (options.isCanceled()) {
      break;
    }

    try {
      const result = await options.runTarget(target);

      if (result === "success") {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    } catch {
      failedCount += 1;
    }

    await options.onTargetComplete?.(target);
  }

  return {
    failedCount,
    isCanceled: options.isCanceled(),
    skippedCount: plan.skippedCount,
    successCount,
    totalCount: plan.targets.length + plan.skippedCount
  };
}

export function formatBatchConnectionTestSummary(input: {
  failedCount: number;
  isCanceled: boolean;
  skippedCount?: number;
  successCount: number;
  totalCount: number;
}): string {
  const skippedCount = input.skippedCount ?? 0;
  const skippedText = skippedCount > 0 ? `，跳过 ${skippedCount}` : "";
  const completedCount = input.successCount + input.failedCount + skippedCount;

  if (input.isCanceled) {
    return `已停止：完成 ${completedCount}/${input.totalCount}，成功 ${input.successCount}，失败 ${input.failedCount}${skippedText}`;
  }

  return `批量测试完成：成功 ${input.successCount}，失败 ${input.failedCount}${skippedText}`;
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

function toStableId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createFetchedProviderModels(
  provider: ApiProvider,
  modelIds: string[],
  fetchedAt = new Date().toISOString()
): ProviderModel[] {
  const seenModelIds = new Set<string>();
  const uniqueModelIds = modelIds.filter((modelId) => {
    const normalizedModelId = modelId.trim().toLowerCase();

    if (!normalizedModelId || seenModelIds.has(normalizedModelId)) {
      return false;
    }

    seenModelIds.add(normalizedModelId);
    return true;
  });

  return uniqueModelIds.map((modelId, index) => ({
    id: `live-${provider.id}-${toStableId(modelId) || index}`,
    providerId: provider.id,
    modelId: modelId.trim(),
    displayName: modelId.trim(),
    capabilities: ["chat"],
    fetchedAt,
    status: "available",
    notes: "从供应商接口实时获取。"
  }));
}

export function isConfigDatabaseStorageEvent(key: string | null): boolean {
  return key === localStorageDatabaseKey;
}

export function isRouteProxyProfileStorageEvent(key: string | null): boolean {
  return key === routeProxyProfileStorageKey;
}

export function createConfigTemplateExport(
  configs: ApiConfig[],
  exportedAt = new Date().toISOString(),
  routeProxyProfiles: RouteProxyProfile[] = []
) {
  const exportedConfigIds = new Set(configs.map((config) => config.id));

  return {
    schemaVersion: 1,
    exportedAt,
    configs: configs.map((config) => ({
      sourceId: config.id,
      name: config.name,
      providerId: normalizeProviderId(config.providerId),
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel,
      endpointMode: config.endpointMode,
      environment: config.environment,
      tags: [...config.tags],
      notes: config.notes,
      isEnabled: config.isEnabled
    })),
    routeProxyProfiles: routeProxyProfiles
      .filter((profile) => exportedConfigIds.has(profile.configId))
      .map((profile) => ({
        name: profile.name,
        configTemplateId: profile.configId,
        failoverConfigTemplateIds: profile.failoverConfigIds.filter((configId) => exportedConfigIds.has(configId)),
        listenAddress: profile.listenAddress,
        listenPort: profile.listenPort,
        failureThreshold: profile.failureThreshold,
        cooldownMs: profile.cooldownMs,
        routingMode: profile.routingMode,
        targetWeights: Object.fromEntries(
          [profile.configId, ...profile.failoverConfigIds]
            .filter((configId) => exportedConfigIds.has(configId))
            .map((configId) => [configId, profile.targetWeights[configId]])
            .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
        )
      }))
  };
}

export function createEnvSnippet(config: ApiConfig): string {
  return `LLM_API_KEY=${config.apiKeyPreview}
LLM_BASE_URL=${config.baseUrl}
LLM_MODEL=${config.defaultModel}`;
}

export async function writeClipboardText(text: string): Promise<void> {
  if (typeof window !== "undefined" && window.deskApi?.clipboard?.writeText) {
    try {
      await window.deskApi.clipboard.writeText(text);
      return;
    } catch {
      // Older running Electron main processes may not have the matching IPC handler yet.
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Continue to the legacy Electron clipboard bridge below when focus-gated browser copy fails.
    }
  }

  if (typeof window !== "undefined" && window.deskApi?.secrets?.copyToClipboard) {
    await window.deskApi.secrets.copyToClipboard(text, {
      clearAfterMs: 300_000
    });
    return;
  }

  throw new Error("Clipboard is not available.");
}

function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string" && value in environmentLabels;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readTags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
}

function readConfigTemplates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object" && Array.isArray((value as { configs?: unknown }).configs)) {
    return (value as { configs: unknown[] }).configs;
  }

  return [];
}

export function readRouteProxyProfileTemplates(value: unknown): unknown[] {
  if (value && typeof value === "object" && Array.isArray((value as { routeProxyProfiles?: unknown }).routeProxyProfiles)) {
    return (value as { routeProxyProfiles: unknown[] }).routeProxyProfiles;
  }

  return [];
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);

    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  return undefined;
}

function readRouteProxyRoutingMode(value: unknown): RouteProxyProfile["routingMode"] {
  return value === "ordered" || value === "weighted" ? value : defaultRouteProxyRoutingMode;
}

function readRouteProxyTargetWeight(value: unknown): number {
  const numericValue = readNumber(value);

  if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
    return defaultRouteProxyTargetWeight;
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 10);
}

export function createRouteProxyProfileFromTemplate(
  value: unknown,
  resolveConfigId: (configTemplateId: string) => string,
  createdAt = new Date().toISOString()
): RouteProxyProfile | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const configTemplateId = readString(candidate.configTemplateId) || readString(candidate.configId);
  const configId = resolveConfigId(configTemplateId);

  if (!configId) {
    return undefined;
  }

  const failoverConfigTemplateIds = Array.isArray(candidate.failoverConfigTemplateIds)
    ? candidate.failoverConfigTemplateIds
    : Array.isArray(candidate.failoverConfigIds)
      ? candidate.failoverConfigIds
      : [];
  const failoverConfigIds = [
    ...new Set(
      failoverConfigTemplateIds
        .map((configTemplateId) => resolveConfigId(readString(configTemplateId)))
        .filter((nextConfigId) => nextConfigId && nextConfigId !== configId)
    )
  ];
  const rawTargetWeights =
    candidate.targetWeights && typeof candidate.targetWeights === "object"
      ? (candidate.targetWeights as Record<string, unknown>)
      : {};
  const targetWeights = Object.fromEntries(
    [configTemplateId, ...failoverConfigTemplateIds.map((configTemplateId) => readString(configTemplateId))]
      .map((configTemplateId) => {
        const resolvedConfigId = resolveConfigId(configTemplateId);
        const weight = readRouteProxyTargetWeight(rawTargetWeights[configTemplateId] ?? rawTargetWeights[resolvedConfigId]);

        return [resolvedConfigId, weight] as const;
      })
      .filter(([resolvedConfigId, weight]) => resolvedConfigId && weight !== defaultRouteProxyTargetWeight)
  );

  return {
    configId,
    cooldownMs: readNumber(candidate.cooldownMs) ?? defaultRouteProxyCooldownMs,
    createdAt,
    failoverConfigIds,
    failureThreshold: readNumber(candidate.failureThreshold) ?? defaultRouteProxyFailureThreshold,
    id: createRouteProxyProfileId(new Date(createdAt)),
    listenAddress: readString(candidate.listenAddress) || fallbackRouteProxyDefaultConfig.listenAddress,
    listenPort: readNumber(candidate.listenPort) ?? fallbackRouteProxyDefaultConfig.listenPort,
    name: readString(candidate.name) || "导入的代理方案",
    routingMode: readRouteProxyRoutingMode(candidate.routingMode),
    targetWeights,
    updatedAt: createdAt
  };
}

function ConfigListItem({
  config,
  providerName,
  selected,
  onSelect
}: {
  config: ApiConfig;
  providerName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = statusMeta[config.lastTestStatus];

  return (
    <button className={`configItem ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="configItemTop">
        <span className="configName">{config.name}</span>
        <span className={`statusPill ${meta.className}`}>
          <StatusIcon status={config.lastTestStatus} />
          {meta.label}
        </span>
      </div>
      <div className="configMeta">
        <span>{providerName}</span>
        <span>{config.defaultModel}</span>
      </div>
      <div className="tagRow">
        <span className={`tag ${config.isEnabled ? "" : "tagMuted"}`}>{config.isEnabled ? "启用" : "停用"}</span>
        <span className="tag">{environmentLabels[config.environment]}</span>
        {config.tags.map((tag) => (
          <span className="tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
    </button>
  );
}

function ModelCatalogPanel({
  provider,
  models,
  selectedModelId,
  statusMessage,
  onSelectModel
}: {
  provider: ApiProvider | undefined;
  models: ProviderModel[];
  selectedModelId: string;
  statusMessage?: string;
  onSelectModel: (modelId: string) => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const latestFetchedAt = getLatestProviderModelFetchedAt(models);
  const catalogSubtitle = provider
    ? latestFetchedAt
      ? `${provider.name} 实时模型目录`
      : `${provider.name} 内置模型目录`
    : "请选择供应商";
  const formattedFetchedAt = latestFetchedAt ? formatProviderModelFetchedAt(latestFetchedAt) : "";

  return (
    <div className="modelCatalogPanel">
      <div className="panelTitle">
        <div>
          <h2>支持模型</h2>
          <p>{catalogSubtitle}</p>
          {formattedFetchedAt ? <div className="modelCatalogMeta">上次刷新：{formattedFetchedAt}</div> : null}
        </div>
        <span>{models.length} 个</span>
        <button
          aria-expanded={!isCollapsed}
          className="iconButton compactIconButton"
          title={isCollapsed ? "灞曞紑妯″瀷鐩綍" : "鏀惰捣妯″瀷鐩綍"}
          type="button"
          onClick={() => setIsCollapsed((currentValue) => !currentValue)}
        >
          {isCollapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
        </button>
      </div>
      {isCollapsed ? null : (
        <>
      {statusMessage ? <div className="modelCatalogNotice">{statusMessage}</div> : null}
      {models.length > 0 ? (
        <div className="modelList">
          {models.map((model) => (
            <button
              className={`modelItem ${selectedModelId === model.id ? "selectedModel" : ""}`}
              key={model.id}
              onClick={() => onSelectModel(model.id)}
              type="button"
            >
              <div className="modelItemTop">
                <div>
                  <strong>{model.displayName}</strong>
                  <code>{model.modelId}</code>
                </div>
                <span className={`modelStatus modelStatus-${model.status}`}>
                  {providerModelStatusLabels[model.status]}
                </span>
              </div>
              <div className="modelMeta">
                {model.contextWindow ? <span>{model.contextWindow}</span> : null}
                {model.capabilities.map((capability) => (
                  <span key={capability}>{modelCapabilityLabels[capability]}</span>
                ))}
              </div>
              <p>{model.notes}</p>
            </button>
          ))}
        </div>
      ) : (
        <div className="emptyState">暂无内置模型目录</div>
      )}
        </>
      )}
    </div>
  );
}

function CodingToolConfigPanel({
  provider,
  model,
  baseUrl,
  selectedTarget,
  copyStatus,
  onSelectTarget,
  onCopy
}: {
  provider: ApiProvider | undefined;
  model: ProviderModel | undefined;
  baseUrl: string;
  selectedTarget: CodingToolTarget;
  copyStatus: string;
  onSelectTarget: (target: CodingToolTarget) => void;
  onCopy: (content: string) => void;
}) {
  if (!provider || !model) {
    return (
      <div className="toolConfigPanel">
        <div className="panelTitle">
          <div>
            <h2>工具配置</h2>
            <p>请选择供应商和模型</p>
          </div>
        </div>
        <div className="emptyState">暂无可生成配置</div>
      </div>
    );
  }

  const generatedConfig = generateCodingToolConfig(selectedTarget, {
    provider,
    model,
    baseUrl
  });

  return (
    <div className="toolConfigPanel">
      <div className="panelTitle">
        <div>
          <h2>工具配置</h2>
          <p>{`${provider.name} / ${model.modelId}`}</p>
        </div>
        <span>{generatedConfig.fileName}</span>
      </div>

      <div className="toolTabs" role="tablist" aria-label="配置目标">
        {(Object.keys(codingToolLabels) as CodingToolTarget[]).map((target) => (
          <button
            className={selectedTarget === target ? "activeToolTab" : ""}
            key={target}
            onClick={() => onSelectTarget(target)}
            type="button"
          >
            {codingToolLabels[target]}
          </button>
        ))}
      </div>

      <div className="toolConfigHeader">
        <div>
          <strong>{generatedConfig.title}</strong>
          <p>{generatedConfig.description}</p>
        </div>
        <button className="secondaryButton" type="button" onClick={() => onCopy(generatedConfig.content)}>
          <Clipboard size={18} />
          {copyStatus || "复制配置"}
        </button>
      </div>

      <pre className="toolConfigCode">{generatedConfig.content}</pre>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="infoRow">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SecondarySectionPanel({
  activeSection,
  batchTestStatus,
  configs,
  isBatchTesting,
  onBatchTestEnabledConfigs,
  onCancelBatchTest,
  providers,
  providerModels,
  providerFilter,
  routeProxyProfileInventory,
  runtimeInfo,
  testHistory,
  secretStorageAvailable
}: {
  activeSection: Exclude<AppSection, "configs" | "chat" | "proxy">;
  batchTestStatus: string;
  configs: ApiConfig[];
  isBatchTesting: boolean;
  onBatchTestEnabledConfigs: () => void;
  onCancelBatchTest: () => void;
  providers: ApiProvider[];
  providerModels: ProviderModel[];
  providerFilter: string;
  routeProxyProfileInventory: RouteProxyProfileInventorySummary;
  runtimeInfo?: DesktopRuntimeInfo;
  testHistory: TestHistoryItem[];
  secretStorageAvailable: boolean;
}) {
  const enabledCount = configs.filter((config) => config.isEnabled).length;
  const savedKeyCount = configs.filter((config) => config.hasApiKey).length;
  const missingKeyCount = configs.filter((config) => !config.hasApiKey).length;
  const successCount = configs.filter((config) => config.lastTestStatus === "success").length;
  const failedCount = configs.filter((config) => config.lastTestStatus === "failed").length;
  const untestedCount = configs.filter((config) => config.lastTestStatus === "untested").length;
  const recentHistory = testHistory.slice(0, 20);
  const activeFilterName = getProviderFilterLabel(providerFilter, providers);
  const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.deskApi);
  const runtimeLabel = getRuntimeDisplayLabel(isDesktopRuntime, runtimeInfo?.isDev);
  const appVersionLabel = isDesktopRuntime
    ? getRuntimeVersionDisplayLabel(runtimeInfo?.appVersion)
    : "浏览器预览";
  const electronVersionLabel = isDesktopRuntime
    ? getRuntimeVersionDisplayLabel(runtimeInfo?.electronVersion)
    : "未运行";
  const storageOrigin = getStorageOriginDisplayLabel(
    typeof window !== "undefined" ? window.location.origin : "",
    typeof window !== "undefined" ? window.location.protocol : ""
  );
  const storagePageUrl = getStoragePageUrlDisplayLabel(typeof window !== "undefined" ? window.location.href : "");
  const configStorageLabel = getLocalStorageKeyDisplayLabel(localStorageDatabaseKey);
  const routeProxyProfileStorageLabel = getLocalStorageKeyDisplayLabel(routeProxyProfileStorageKey);
  const configSchemaLabel = getStorageSchemaDisplayLabel(localStorageDatabaseSchemaVersion);
  const routeProxyProfileSchemaLabel = getStorageSchemaDisplayLabel(routeProxyProfileSchemaVersion);
  const userDataPath = isDesktopRuntime ? runtimeInfo?.userDataPath || "读取中" : "浏览器配置目录";
  const getConfigName = (configId: string) => configs.find((config) => config.id === configId)?.name ?? "已删除配置";

  if (activeSection === "tests") {
    return (
      <div className="secondarySection">
        <div className="summaryGrid">
          <div className="metricPanel">
            <span>可用配置</span>
            <strong>{successCount}</strong>
          </div>
          <div className="metricPanel warning">
            <span>异常配置</span>
            <strong>{failedCount}</strong>
          </div>
          <div className="metricPanel">
            <span>未测试</span>
            <strong>{untestedCount}</strong>
          </div>
          <div className="metricPanel">
            <span>历史记录</span>
            <strong>{testHistory.length}</strong>
          </div>
        </div>

        <section className="widePanel testHistoryPanel" aria-label="最近测试">
          <div className="panelTitle">
            <div>
              <h2>最近测试</h2>
              <p>连接测试历史</p>
            </div>
            <div className="testCenterActions">
              <span>{recentHistory.length} 条</span>
              <button
                className="secondaryButton"
                disabled={isBatchTesting || enabledCount === 0}
                type="button"
                onClick={onBatchTestEnabledConfigs}
              >
                <Gauge size={16} />
                测试启用配置
              </button>
              {isBatchTesting ? (
                <button className="secondaryButton dangerButton" type="button" onClick={onCancelBatchTest}>
                  <X size={16} />
                  停止
                </button>
              ) : null}
            </div>
          </div>
          {batchTestStatus ? <div className="testActionStatus testCenterStatus">{batchTestStatus}</div> : null}
          <div className="testHistoryList">
            {recentHistory.length > 0 ? (
              recentHistory.map((item) => (
                <div className="historyItem" key={item.id}>
                  <span className={`statusDot ${statusMeta[item.status].className}`} />
                  <div>
                    <strong>{getConfigName(item.configId)}</strong>
                    <p>{`${statusMeta[item.status].label} · ${getHistorySummary(item)}`}</p>
                  </div>
                  <time dateTime={item.testedAt}>{formatLocalDateTime(item.testedAt) || item.testedAt}</time>
                  <TestHistoryDetails item={item} />
                </div>
              ))
            ) : (
              <div className="emptyState">暂无测试记录</div>
            )}
          </div>
        </section>
      </div>
    );
  }

  if (activeSection === "providers") {
    return (
      <div className="secondarySection">
        <section className="widePanel" aria-label="供应商模板">
          <div className="panelTitle">
            <div>
              <h2>供应商模板</h2>
              <p>内置供应商预设</p>
            </div>
            <span>{providers.length} 个</span>
          </div>
          <div className="templateGrid">
            {providers.map((provider) => {
              const modelCount = providerModels.filter((model) => model.providerId === provider.id).length;

              return (
                <article className="templateItem" key={provider.id}>
                  <div className="templateItemHeader">
                    <strong>{provider.name}</strong>
                    <span className="tag">{provider.isBuiltIn ? "内置" : "自定义"}</span>
                  </div>
                  <dl className="infoList">
                    <InfoRow label="类型" value={provider.type} />
                    <InfoRow label="认证" value={authTypeLabels[provider.authType]} />
                    <InfoRow label="默认 Base URL" value={provider.defaultBaseUrl || "待配置"} />
                    <InfoRow label="模型目录" value={`${modelCount} 个`} />
                  </dl>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  if (activeSection === "security") {
    return (
      <div className="secondarySection">
        <div className="summaryGrid">
          <div className="metricPanel">
            <span>已保存密钥</span>
            <strong>{savedKeyCount}</strong>
          </div>
          <div className="metricPanel warning">
            <span>缺少密钥</span>
            <strong>{missingKeyCount}</strong>
          </div>
          <div className="metricPanel">
            <span>启用配置</span>
            <strong>{enabledCount}</strong>
          </div>
          <div className="metricPanel">
            <span>加密状态</span>
            <strong>{secretStorageAvailable ? "可用" : "不可用"}</strong>
          </div>
        </div>

        <section className="widePanel" aria-label="安全中心">
          <div className="panelTitle">
            <div>
              <h2>安全中心</h2>
              <p>本机密钥与剪贴板状态</p>
            </div>
          </div>
          <div className="infoGrid">
            <div className="infoBlock">
              <dl className="infoList">
                <InfoRow label="系统加密" value={secretStorageAvailable ? "Electron safeStorage 可用" : "当前环境不可用"} />
                <InfoRow label="密钥显示" value="默认隐藏" />
                <InfoRow label="复制清理" value="30 秒后清理" />
              </dl>
            </div>
            <div className="infoBlock">
              <dl className="infoList">
                <InfoRow label="配置总数" value={configs.length} />
                <InfoRow label="已保存密钥" value={savedKeyCount} />
                <InfoRow label="需要补录" value={missingKeyCount} />
              </dl>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="secondarySection">
      <section className="widePanel" aria-label="设置">
        <div className="panelTitle">
          <div>
            <h2>设置</h2>
            <p>当前工作区状态</p>
          </div>
        </div>
        <div className="infoGrid">
          <div className="infoBlock">
            <dl className="infoList">
              <InfoRow label="运行环境" value={runtimeLabel} />
              <InfoRow label="应用版本" value={appVersionLabel} />
              <InfoRow label="Electron 版本" value={electronVersionLabel} />
              <InfoRow label="页面来源" value={storageOrigin} />
              <InfoRow label="页面地址" value={storagePageUrl} />
              <InfoRow label="主配置存储" value={configStorageLabel} />
              <InfoRow label="代理方案存储" value={routeProxyProfileStorageLabel} />
              <InfoRow label="主配置版本" value={configSchemaLabel} />
              <InfoRow label="代理方案版本" value={routeProxyProfileSchemaLabel} />
              <InfoRow label="数据目录" value={userDataPath} />
              <InfoRow label="供应商筛选" value={activeFilterName} />
            </dl>
          </div>
          <div className="infoBlock">
            <dl className="infoList">
              <InfoRow label="配置数量" value={getStorageItemCountDisplayLabel(configs.length)} />
              <InfoRow label="供应商模板" value={getStorageItemCountDisplayLabel(providers.length)} />
              <InfoRow label="模型目录" value={getStorageItemCountDisplayLabel(providerModels.length)} />
              <InfoRow label="代理方案" value={getStorageItemCountDisplayLabel(routeProxyProfileInventory.totalCount)} />
              <InfoRow label="可用代理方案" value={getStorageItemCountDisplayLabel(routeProxyProfileInventory.usableCount)} />
              <InfoRow label="失效代理方案" value={getStorageItemCountDisplayLabel(routeProxyProfileInventory.staleCount)} />
              <InfoRow label="降级代理方案" value={getStorageItemCountDisplayLabel(routeProxyProfileInventory.degradedCount)} />
            </dl>
          </div>
        </div>
      </section>
    </div>
  );
}

export function App() {
  const repository = useMemo(() => new LocalStorageConfigRepository(), []);
  const secretService = useMemo(() => createDesktopSecretService(), []);
  const connectionTestTransport = useMemo(() => createDesktopConnectionTestTransport(), []);
  const chatTransport = useMemo(() => createDesktopChatTransport(), []);
  const modelFetchTransport = useMemo(() => createDesktopModelFetchTransport(), []);
  const routeProxyTransport = useMemo(() => createDesktopRouteProxyTransport(), []);
  const routeProxyProfileStore = useMemo(() => createLocalStorageRouteProxyProfileStore(), []);
  const importInputRef = useRef<HTMLInputElement>(null);
  const toolConfigPanelRef = useRef<HTMLDivElement>(null);
  const envSnippetPanelRef = useRef<HTMLDivElement>(null);
  const batchTestCancelRef = useRef(false);
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState<AppSection>("configs");
  const [providerFilter, setProviderFilter] = useState(allProviderFilterId);
  const [providers, setProviders] = useState<ApiProvider[]>(defaultProviders);
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const [configs, setConfigs] = useState<ApiConfig[]>([]);
  const [testHistory, setTestHistory] = useState<TestHistoryItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedCodingTool, setSelectedCodingTool] = useState<CodingToolTarget>("codex");
  const [copyStatus, setCopyStatus] = useState("");
  const [secretStorageAvailable, setSecretStorageAvailable] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{ configId: string; value: string }>();
  const [secretActionStatus, setSecretActionStatus] = useState("");
  const [testingConfigId, setTestingConfigId] = useState("");
  const [connectionTestStatus, setConnectionTestStatus] = useState("");
  const [batchTestStatus, setBatchTestStatus] = useState("");
  const [isBatchTesting, setIsBatchTesting] = useState(false);
  const [modelFetchAttempted, setModelFetchAttempted] = useState(false);
  const [modelFetchOptions, setModelFetchOptions] = useState<string[]>([]);
  const [modelFetchStatus, setModelFetchStatus] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [liveCatalogModels, setLiveCatalogModels] = useState<ProviderModel[]>([]);
  const [catalogFetchStatus, setCatalogFetchStatus] = useState("");
  const [formMode, setFormMode] = useState<FormMode>("view");
  const [formState, setFormState] = useState<ConfigFormState>(() => createEmptyForm(defaultProviders[0]));
  const [formError, setFormError] = useState("");
  const [toolbarStatus, setToolbarStatus] = useState("");
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo>();
  const [routeProxyProfileStoreVersion, setRouteProxyProfileStoreVersion] = useState(0);
  const [routeProxyProfileInventoryVersion, setRouteProxyProfileInventoryVersion] = useState(0);

  const providerLookup = useMemo(() => {
    return new Map(providers.map((provider) => [provider.id, provider]));
  }, [providers]);

  const providerFilterItems = useMemo(() => createProviderFilterItems(configs, providers), [configs, providers]);
  const providerSelectOptions = useMemo(() => createProviderSelectOptions(providers), [providers]);
  const routeProxyProfileInventory = useMemo(
    () => summarizeRouteProxyProfileInventory(routeProxyProfileStore?.listProfiles() ?? [], configs),
    [configs, routeProxyProfileStore, routeProxyProfileStoreVersion, routeProxyProfileInventoryVersion]
  );
  const refreshRouteProxyProfileStore = useCallback(() => {
    setRouteProxyProfileStoreVersion((currentVersion) => currentVersion + 1);
    setRouteProxyProfileInventoryVersion((currentVersion) => currentVersion + 1);
  }, []);
  const refreshRouteProxyProfileInventory = useCallback(() => {
    setRouteProxyProfileInventoryVersion((currentVersion) => currentVersion + 1);
  }, []);

  const getProviderName = useCallback(
    (providerId: string) => providerLookup.get(normalizeProviderId(providerId))?.name ?? unknownProviderName,
    [providerLookup]
  );
  const getProviderDisplayNameForConfig = useCallback(
    (providerId: string) => getProviderDisplayName(providerId, providers),
    [providers]
  );

  const loadData = useCallback(async () => {
    const [loadedProviders, loadedProviderModels, loadedConfigs, loadedHistory] = await Promise.all([
      repository.listProviders(),
      repository.listProviderModels(),
      repository.listConfigs(),
      repository.listTestHistory()
    ]);

    setProviders(loadedProviders);
    setProviderModels(loadedProviderModels);
    setConfigs(loadedConfigs);
    setTestHistory(loadedHistory);
  }, [repository]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    let isMounted = true;

    window.deskApi
      ?.getRuntimeInfo?.()
      .then((info) => {
        if (isMounted) {
          setRuntimeInfo(info);
        }
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (isConfigDatabaseStorageEvent(event.key)) {
        void loadData();
      }

      if (isRouteProxyProfileStorageEvent(event.key)) {
        refreshRouteProxyProfileStore();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [loadData, refreshRouteProxyProfileStore]);

  useEffect(() => {
    let isMounted = true;

    if (!secretService) {
      setSecretStorageAvailable(false);
      return () => {
        isMounted = false;
      };
    }

    secretService
      .isEncryptionAvailable()
      .then((isAvailable) => {
        if (isMounted) {
          setSecretStorageAvailable(isAvailable);
        }
      })
      .catch(() => {
        if (isMounted) {
          setSecretStorageAvailable(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [secretService]);

  useEffect(() => {
    setRevealedSecret(undefined);
    setSecretActionStatus("");
    setConnectionTestStatus("");
    setBatchTestStatus("");
  }, [formMode, selectedId]);

  useEffect(() => {
    if (
      providerFilter === allProviderFilterId ||
      providerFilterItems.some((item) => item.id === providerFilter)
    ) {
      return;
    }

    const provider = providerLookup.get(normalizeProviderId(providerFilter));
    setProviderFilter(
      provider && isOpenAiCompatibleProvider(provider) ? openAiCompatibleProviderFilterId : allProviderFilterId
    );
  }, [providerFilter, providerFilterItems, providerLookup]);

  const filteredConfigs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return configs.filter((config) => {
      if (!configMatchesProviderFilter(config, providerFilter, providers)) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        config.name,
        config.baseUrl,
        config.defaultModel,
        environmentLabels[config.environment],
        config.notes,
        getProviderName(config.providerId),
        getProviderDisplayNameForConfig(config.providerId),
        ...config.tags
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [configs, getProviderDisplayNameForConfig, getProviderName, providerFilter, providers, query]);

  useEffect(() => {
    if (formMode !== "view") {
      return;
    }

    if (filteredConfigs.length === 0) {
      if (selectedId) {
        setSelectedId("");
      }
      return;
    }

    if (!filteredConfigs.some((config) => config.id === selectedId)) {
      setSelectedId(filteredConfigs[0].id);
    }
  }, [filteredConfigs, formMode, selectedId]);

  const selectedConfig = configs.find((config) => config.id === selectedId);
  const selectedHistory = testHistory.filter((item) => item.configId === selectedConfig?.id);
  const catalogFilterProvider =
    providerFilter === openAiCompatibleProviderFilterId
      ? providers.find(isOpenAiCompatibleProvider)
      : providerFilter !== allProviderFilterId
        ? providerLookup.get(providerFilter)
        : providers[0];
  const catalogProviderId = selectedConfig ? normalizeProviderId(selectedConfig.providerId) : catalogFilterProvider?.id;
  const catalogProvider = providers.find((provider) => provider.id === catalogProviderId);
  const builtInCatalogModels = useMemo(
    () => providerModels.filter((model) => model.providerId === catalogProviderId),
    [catalogProviderId, providerModels]
  );
  const catalogModels = liveCatalogModels.length > 0 ? liveCatalogModels : builtInCatalogModels;
  const selectedCatalogModel = catalogModels.find((model) => model.id === selectedModelId) ?? catalogModels[0];
  const selectedBaseUrl = selectedConfig?.baseUrl ?? catalogProvider?.defaultBaseUrl ?? "";
  const successCount = configs.filter((config) => config.lastTestStatus === "success").length;
  const failedCount = configs.filter((config) => config.lastTestStatus === "failed").length;
  const isSelectedSecretRevealed = Boolean(selectedConfig && revealedSecret?.configId === selectedConfig.id);
  const selectedSecretValue = isSelectedSecretRevealed ? revealedSecret?.value ?? "" : selectedConfig?.apiKeyPreview ?? "";
  const canUseSelectedSecret = Boolean(secretService && secretStorageAvailable && selectedConfig?.encryptedApiKey);
  const isTestingSelectedConfig = Boolean(selectedConfig && testingConfigId === selectedConfig.id);
  const formProvider = providerLookup.get(normalizeProviderId(formState.providerId));
  const selectedProvider = selectedConfig ? providerLookup.get(normalizeProviderId(selectedConfig.providerId)) : undefined;
  const isFormOpenAiCompatible = shouldShowEndpointMode(formProvider);
  const isSelectedOpenAiCompatible = shouldShowEndpointMode(selectedProvider);
  const hasSavedFormApiKey = Boolean(formMode === "edit" && selectedConfig?.encryptedApiKey);
  const canFetchFormModels = Boolean(
    formMode !== "view" &&
      modelFetchTransport &&
      formProvider &&
      formState.baseUrl.trim() &&
      (formProvider.authType === "none" || formState.apiKey.trim() || hasSavedFormApiKey)
  );

  useEffect(() => {
    if (catalogModels.length === 0) {
      if (selectedModelId) {
        setSelectedModelId("");
      }
      return;
    }

    const selectedModelExists = catalogModels.some((model) => model.id === selectedModelId);

    if (selectedModelExists) {
      return;
    }

    const preferredModel = selectedConfig
      ? catalogModels.find((model) => model.modelId === selectedConfig.defaultModel)
      : undefined;

    setSelectedModelId(preferredModel?.id ?? catalogModels[0].id);
  }, [catalogModels, selectedConfig, selectedModelId]);

  useEffect(() => {
    let isCurrentRequest = true;

    setLiveCatalogModels([]);

    if (!selectedConfig || !catalogProvider) {
      setCatalogFetchStatus("");
      return () => {
        isCurrentRequest = false;
      };
    }

    if (!modelFetchTransport) {
      setCatalogFetchStatus("当前环境不能连接供应商模型接口，正在显示内置默认模型。");
      return () => {
        isCurrentRequest = false;
      };
    }

    const hasRequiredSecret = catalogProvider.authType === "none" || Boolean(selectedConfig.encryptedApiKey);

    if (!selectedConfig.baseUrl.trim() || !hasRequiredSecret) {
      setCatalogFetchStatus("供应商信息不完整，正在显示内置默认模型。");
      return () => {
        isCurrentRequest = false;
      };
    }

    setCatalogFetchStatus("正在从供应商接口获取模型，暂时显示内置默认模型。");

    void modelFetchTransport
      .fetchProviderModels({
        apiKey: "",
        authType: catalogProvider.authType,
        baseUrl: selectedConfig.baseUrl,
        encryptedApiKey: selectedConfig.encryptedApiKey,
        providerType: catalogProvider.type,
        timeoutMs: 15_000
      })
      .then((result) => {
        if (!isCurrentRequest) {
          return;
        }

        if (result.models.length === 0) {
          setLiveCatalogModels([]);
          setCatalogFetchStatus(
            getModelFetchFailureStatus(result, "未从供应商接口获取到模型，正在显示内置默认模型。")
          );
          return;
        }

        const fetchedModels = createFetchedProviderModels(catalogProvider, result.models);

        setLiveCatalogModels(fetchedModels);
        void repository
          .saveProviderModels(catalogProvider.id, fetchedModels)
          .then((savedProviderModels) => {
            if (isCurrentRequest) {
              setProviderModels(savedProviderModels);
            }
          })
          .catch(() => undefined);
        setCatalogFetchStatus("已显示供应商接口返回的模型。");
      })
      .catch(() => {
        if (!isCurrentRequest) {
          return;
        }

        setLiveCatalogModels([]);
        setCatalogFetchStatus("模型接口暂时不可用，正在显示内置默认模型。");
      });

    return () => {
      isCurrentRequest = false;
    };
  }, [
    catalogProvider,
    modelFetchTransport,
    repository,
    selectedConfig?.baseUrl,
    selectedConfig?.encryptedApiKey,
    selectedConfig?.id
  ]);

  useEffect(() => {
    setModelFetchAttempted(false);
    setModelFetchOptions([]);
    setModelFetchStatus("");
    setFetchingModels(false);
  }, [formState.providerId, formState.baseUrl, formState.apiKey]);

  const startCreate = () => {
    const createProvider = pickCreateProvider(providers, providerFilter);
    setActiveSection("configs");
    setSelectedId("");
    setFormState(createEmptyForm(createProvider));
    setFormMode("create");
    setFormError("");
  };

  const startEdit = () => {
    if (!selectedConfig) {
      return;
    }

    setActiveSection("configs");
    setFormState(createEditForm(selectedConfig));
    setFormMode("edit");
    setFormError("");
  };

  const cancelForm = () => {
    setFormMode("view");
    setFormError("");
  };

  const deleteSelectedConfig = async () => {
    if (!selectedConfig) {
      return;
    }

    if (!window.confirm(`删除配置「${selectedConfig.name}」？`)) {
      return;
    }

    await deleteApiConfig(repository, selectedConfig.id);
    const remainingConfigs = configs.filter((config) => config.id !== selectedConfig.id);
    setSelectedId(remainingConfigs[0]?.id ?? "");
    await loadData();
  };

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const input = {
      name: formState.name,
      providerId: formState.providerId,
      baseUrl: formState.baseUrl,
      apiKey: formState.apiKey,
      defaultModel: formState.defaultModel,
      endpointMode: isFormOpenAiCompatible ? formState.endpointMode : "auto",
      environment: formState.environment,
      tags: toTags(formState.tagsText),
      notes: formState.notes,
      isEnabled: formState.isEnabled
    };

    try {
      if (formMode === "create") {
        const createdConfig = await createApiConfig(repository, input, {
          secretService
        });
        setSelectedId(createdConfig.id);
      }

      if (formMode === "edit" && selectedConfig) {
        const updatedConfig = await updateApiConfig(repository, selectedConfig.id, input, {
          replaceApiKey: formState.apiKey.trim().length > 0,
          secretService
        });
        setSelectedId(updatedConfig.id);
      }

      setFormMode("view");
      setFormError("");
      await loadData();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "保存失败");
    }
  };

  const updateFormField = <Key extends keyof ConfigFormState>(key: Key, value: ConfigFormState[Key]) => {
    setFormState((currentState) => ({
      ...currentState,
      [key]: value
    }));
  };

  const fetchFormModelOptions = async () => {
    if (!modelFetchTransport || !formProvider) {
      setModelFetchAttempted(true);
      setModelFetchOptions([]);
      setModelFetchStatus("未获取到模型");
      return;
    }

    const baseUrl = formState.baseUrl.trim();
    const apiKey = formState.apiKey.trim();
    const encryptedApiKey = apiKey ? undefined : selectedConfig?.encryptedApiKey;

    if (!baseUrl || (formProvider.authType !== "none" && !apiKey && !encryptedApiKey)) {
      setModelFetchAttempted(true);
      setModelFetchOptions([]);
      setModelFetchStatus("未获取到模型");
      return;
    }

    setFetchingModels(true);
    setModelFetchAttempted(true);
    setModelFetchStatus("获取中");

    try {
      const result = await modelFetchTransport.fetchProviderModels({
        apiKey,
        authType: formProvider.authType,
        baseUrl,
        encryptedApiKey,
        providerType: formProvider.type,
        timeoutMs: 15_000
      });

      setModelFetchOptions(result.models);
      setFormState((currentState) => ({
        ...currentState,
        defaultModel: getDefaultModelAfterFetch(currentState.defaultModel, result.models)
      }));

      if (result.models.length > 0) {
        const fetchedModels = createFetchedProviderModels(formProvider, result.models);

        void repository
          .saveProviderModels(formProvider.id, fetchedModels)
          .then((savedProviderModels) => setProviderModels(savedProviderModels))
          .catch(() => undefined);
      }
      setModelFetchStatus(
        result.models.length > 0 ? `已获取 ${result.models.length} 个模型` : getModelFetchFailureStatus(result, "未获取到模型")
      );
    } catch (error) {
      setModelFetchOptions([]);
      setModelFetchStatus(error instanceof Error ? `获取模型失败：${error.message.slice(0, 180)}` : "未获取到模型");
    } finally {
      setFetchingModels(false);
    }
  };

  const setTemporarySecretStatus = (message: string) => {
    setSecretActionStatus(message);
    window.setTimeout(() => {
      setSecretActionStatus((currentMessage) => (currentMessage === message ? "" : currentMessage));
    }, 2200);
  };

  const revealSelectedSecret = async () => {
    if (!selectedConfig) {
      return;
    }

    if (isSelectedSecretRevealed) {
      setRevealedSecret(undefined);
      setSecretActionStatus("");
      return;
    }

    if (!secretService || !secretStorageAvailable || !selectedConfig.encryptedApiKey) {
      setTemporarySecretStatus("未保存密钥");
      return;
    }

    try {
      const plaintext = await secretService.decryptSecret(selectedConfig.encryptedApiKey);
      setRevealedSecret({ configId: selectedConfig.id, value: plaintext });
      setTemporarySecretStatus("已显示");
    } catch {
      setTemporarySecretStatus("解密失败");
    }
  };

  const copySelectedSecret = async () => {
    if (!selectedConfig) {
      return;
    }

    if (!secretService || !secretStorageAvailable || !selectedConfig.encryptedApiKey) {
      setTemporarySecretStatus("未保存密钥");
      return;
    }

    try {
      const plaintext = isSelectedSecretRevealed
        ? revealedSecret?.value ?? ""
        : await secretService.decryptSecret(selectedConfig.encryptedApiKey);
      const result = await secretService.copySecretToClipboard(plaintext, {
        clearAfterMs: 30_000
      });

      setTemporarySecretStatus(`已复制，${Math.round(result.clearAfterMs / 1000)} 秒后清空`);
    } catch {
      setTemporarySecretStatus("复制失败");
    }
  };

  const testSelectedConnection = async () => {
    if (!selectedConfig) {
      return;
    }

    const provider = providerLookup.get(normalizeProviderId(selectedConfig.providerId));

    if (!provider) {
      setConnectionTestStatus("供应商不存在");
      return;
    }

    setTestingConfigId(selectedConfig.id);
    setConnectionTestStatus("测试中");

    try {
      const result = await runConnectionTest(repository, selectedConfig, provider, {
        secretService,
        transport: connectionTestTransport
      });
      const nextMessage =
        result.historyItem.status === "success"
          ? `连接成功，${result.historyItem.latencyMs ?? 0}ms`
          : result.historyItem.errorMessage ?? "连接失败";

      setSelectedId(result.config.id);
      setConnectionTestStatus(nextMessage);
      await loadData();
    } catch (error) {
      setConnectionTestStatus(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setTestingConfigId("");
    }
  };

  const testEnabledConnections = async () => {
    if (isBatchTesting) {
      return;
    }

    const batchPlan = createConnectionTestBatchPlan(configs, providers);
    const totalCount = batchPlan.targets.length + batchPlan.skippedCount;

    if (totalCount === 0) {
      setBatchTestStatus("暂无启用配置可测试");
      return;
    }

    if (batchPlan.targets.length === 0) {
      setBatchTestStatus(`没有可测试配置，已跳过 ${batchPlan.skippedCount} 个配置`);
      return;
    }

    batchTestCancelRef.current = false;
    setIsBatchTesting(true);
    setBatchTestStatus(
      batchPlan.skippedCount > 0
        ? `准备测试 ${batchPlan.targets.length} 个配置，跳过 ${batchPlan.skippedCount} 个`
        : `准备测试 ${batchPlan.targets.length} 个启用配置`
    );

    try {
      const batchResult = await runConnectionTestBatchPlan(batchPlan, {
        isCanceled: () => batchTestCancelRef.current,
        onTargetComplete: async () => {
          await loadData();
        },
        onTargetStart: ({ config }, index, targetCount) => {
          setTestingConfigId(config.id);
          setBatchTestStatus(`正在测试 ${index + 1}/${targetCount}：${config.name}`);
        },
        runTarget: async ({ config, provider }) => {
          const result = await runConnectionTest(repository, config, provider, {
            secretService,
            transport: connectionTestTransport
          });

          return result.historyItem.status === "success" ? "success" : "failed";
        }
      });

      setBatchTestStatus(
        formatBatchConnectionTestSummary({
          failedCount: batchResult.failedCount,
          isCanceled: batchResult.isCanceled,
          skippedCount: batchResult.skippedCount,
          successCount: batchResult.successCount,
          totalCount: batchResult.totalCount
        })
      );
    } finally {
      setTestingConfigId("");
      setIsBatchTesting(false);
      batchTestCancelRef.current = false;
      await loadData();
    }
  };

  const cancelBatchConnectionTest = () => {
    if (!isBatchTesting) {
      return;
    }

    batchTestCancelRef.current = true;
    setBatchTestStatus("正在停止，当前配置测试完成后停止");
  };

  const updateFormProvider = (providerSelection: string) => {
    setFormState((currentState) => {
      const normalizedProviderSelection = normalizeProviderId(providerSelection);
      const currentProvider = providerLookup.get(normalizeProviderId(currentState.providerId));
      const provider =
        normalizedProviderSelection === openAiCompatibleProviderFilterId
          ? currentProvider && isOpenAiCompatibleProvider(currentProvider)
            ? currentProvider
            : providers.find(isOpenAiCompatibleProvider)
          : providerLookup.get(normalizedProviderSelection);

      if (!provider) {
        return currentState;
      }

      return {
        ...currentState,
        providerId: provider.id,
        baseUrl: getBaseUrlAfterProviderChange(currentState.baseUrl, currentProvider, provider),
        endpointMode: provider.type === "openai" ? currentState.endpointMode : "auto"
      };
    });
  };

  const setTemporaryToolbarStatus = (message: string) => {
    setToolbarStatus(message);
    window.setTimeout(() => {
      setToolbarStatus((currentMessage) => (currentMessage === message ? "" : currentMessage));
    }, 2400);
  };

  const resetConfigFilters = () => {
    setActiveSection("configs");
    setProviderFilter(allProviderFilterId);
    setQuery("");
    setTemporaryToolbarStatus("已显示全部配置");
  };

  const exportConfigTemplates = () => {
    const routeProxyProfiles = routeProxyProfileStore?.listProfiles() ?? [];
    const exportSnapshot = createConfigTemplateExport(configs, new Date().toISOString(), routeProxyProfiles);
    const blob = new Blob([JSON.stringify(exportSnapshot, null, 2)], {
      type: "application/json"
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = `desk-api-config-templates-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(objectUrl);
    const profileCount = exportSnapshot.routeProxyProfiles.length;
    setTemporaryToolbarStatus(
      profileCount > 0
        ? `已导出 ${configs.length} 项模板、${profileCount} 个代理方案，不含密钥`
        : `已导出 ${configs.length} 项模板，不含密钥`
    );
  };

  const importConfigTemplates = async (file: File) => {
    try {
      const parsedValue: unknown = JSON.parse(await file.text());
      const knownProviderIds = new Set(providers.map((provider) => provider.id));
      const configTemplates = readConfigTemplates(parsedValue);
      const profileTemplates = readRouteProxyProfileTemplates(parsedValue);
      const sourceConfigIds = configTemplates.map((item) => {
        const candidate = item && typeof item === "object" ? (item as Record<string, unknown>) : {};

        return readString(candidate.sourceId) || readString(candidate.id);
      });
      const importedInputs = configTemplates.map((item) => {
        const candidate = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const providerId = normalizeProviderId(readString(candidate.providerId));

        if (!knownProviderIds.has(providerId)) {
          throw new Error(`未知供应商：${providerId || "未设置"}`);
        }

        return {
          name: readString(candidate.name),
          providerId,
          baseUrl: readString(candidate.baseUrl),
          defaultModel: readString(candidate.defaultModel),
          endpointMode: readEndpointMode(candidate.endpointMode),
          environment: isEnvironmentName(candidate.environment) ? candidate.environment : "development",
          tags: readTags(candidate.tags),
          notes: readString(candidate.notes),
          isEnabled: typeof candidate.isEnabled === "boolean" ? candidate.isEnabled : true
        };
      });

      if (importedInputs.length === 0 && profileTemplates.length === 0) {
        throw new Error("未找到可导入的配置模板");
      }

      const createdConfigs: ApiConfig[] = [];
      const importedConfigIdsBySourceId = new Map<string, string>();

      for (const [index, input] of importedInputs.entries()) {
        const createdConfig = await createApiConfig(repository, input);
        const sourceConfigId = sourceConfigIds[index];

        createdConfigs.push(createdConfig);

        if (sourceConfigId) {
          importedConfigIdsBySourceId.set(sourceConfigId, createdConfig.id);
        }
      }

      const knownConfigIds = new Set([...configs.map((config) => config.id), ...createdConfigs.map((config) => config.id)]);
      const resolveImportedConfigId = (configTemplateId: string) =>
        importedConfigIdsBySourceId.get(configTemplateId) ?? (knownConfigIds.has(configTemplateId) ? configTemplateId : "");
      const importedProfiles: RouteProxyProfile[] = [];

      if (routeProxyProfileStore) {
        const importedAt = new Date().toISOString();

        for (const template of profileTemplates) {
          const profile = createRouteProxyProfileFromTemplate(template, resolveImportedConfigId, importedAt);

          if (profile) {
            importedProfiles.push(routeProxyProfileStore.saveProfile(profile));
          }
        }

        if (importedProfiles.length > 0) {
          refreshRouteProxyProfileStore();
        }
      }

      if (createdConfigs.length === 0 && importedProfiles.length === 0) {
        throw new Error("未找到可导入的配置模板或代理方案");
      }

      setActiveSection(createdConfigs.length > 0 ? "configs" : "proxy");
      setProviderFilter(allProviderFilterId);
      setQuery("");
      setSelectedId((currentSelectedId) => createdConfigs[0]?.id ?? currentSelectedId);
      setFormMode("view");
      await loadData();
      const configImportText =
        createdConfigs.length > 0 ? `已导入 ${createdConfigs.length} 项模板，请补充 API Key` : "";
      const profileImportText = importedProfiles.length > 0 ? `已导入 ${importedProfiles.length} 个代理方案` : "";
      setTemporaryToolbarStatus([configImportText, profileImportText].filter(Boolean).join("；"));
    } catch (error) {
      setTemporaryToolbarStatus(error instanceof Error ? error.message : "导入失败");
    }
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    event.target.value = "";

    if (!file) {
      return;
    }

    await importConfigTemplates(file);
  };

  const copyGeneratedConfig = async (content: string) => {
    try {
      await writeClipboardText(content);
      setCopyStatus("已复制");
      window.setTimeout(() => setCopyStatus(""), 1600);
    } catch {
      setCopyStatus("复制失败");
      window.setTimeout(() => setCopyStatus(""), 1600);
    }
  };

  const showGeneratedSnippets = () => {
    const target = toolConfigPanelRef.current ?? document.getElementById("generated-snippets-panel");

    target?.scrollIntoView({
      behavior: "auto",
      block: "start"
    });
    setCopyStatus("已定位到片段");
    window.setTimeout(() => setCopyStatus(""), 1600);
  };

  const copySelectedEnvSnippet = async () => {
    if (!selectedConfig) {
      return;
    }

    await copyGeneratedConfig(createEnvSnippet(selectedConfig));
  };

  const closeWindow = () => {
    void window.deskApi?.window?.close?.();
  };

  const minimizeWindow = () => {
    void window.deskApi?.window?.minimize?.();
  };

  const toggleMaximizeWindow = () => {
    void window.deskApi?.window?.toggleMaximize?.();
  };

  return (
    <div className="appFrame">
      <header className="macTitlebar">
        <div className="macWindowControls" aria-label="窗口控制">
          <button
            aria-label="关闭窗口"
            className="macWindowControl close"
            onClick={closeWindow}
            title="关闭窗口"
            type="button"
          />
          <button
            aria-label="最小化窗口"
            className="macWindowControl minimize"
            onClick={minimizeWindow}
            title="最小化窗口"
            type="button"
          />
          <button
            aria-label="最大化窗口"
            className="macWindowControl zoom"
            onClick={toggleMaximizeWindow}
            title="最大化窗口"
            type="button"
          />
        </div>
        <div className="macTitleIdentity">
          <span className="macTitleIcon">
            <KeyRound size={14} />
          </span>
          <span>Desk API Config Manager</span>
        </div>
      </header>
      <main className="appShell">
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandMark">
            <KeyRound size={22} />
          </div>
          <div>
            <h1>Desk API</h1>
            <p>配置管理台</p>
          </div>
        </div>

        <nav className="navList" aria-label="主导航">
          <button
            className={`navItem ${activeSection === "configs" ? "active" : ""}`}
            onClick={() => setActiveSection("configs")}
            type="button"
          >
            <Database size={18} />
            配置管理
          </button>
          <button
            className={`navItem ${activeSection === "chat" ? "active" : ""}`}
            onClick={() => setActiveSection("chat")}
            type="button"
          >
            <MessageSquare size={18} />
            模型对话
          </button>
          <button
            className={`navItem ${activeSection === "proxy" ? "active" : ""}`}
            onClick={() => setActiveSection("proxy")}
            type="button"
          >
            <Route size={18} />
            路由代理
          </button>
          <button
            className={`navItem ${activeSection === "tests" ? "active" : ""}`}
            onClick={() => setActiveSection("tests")}
            type="button"
          >
            <Gauge size={18} />
            测试中心
          </button>
          <button
            className={`navItem ${activeSection === "providers" ? "active" : ""}`}
            onClick={() => setActiveSection("providers")}
            type="button"
          >
            <Server size={18} />
            供应商模板
          </button>
          <button
            className={`navItem ${activeSection === "security" ? "active" : ""}`}
            onClick={() => setActiveSection("security")}
            type="button"
          >
            <ShieldCheck size={18} />
            安全中心
          </button>
          <button
            className={`navItem ${activeSection === "settings" ? "active" : ""}`}
            onClick={() => setActiveSection("settings")}
            type="button"
          >
            <Settings size={18} />
            设置
          </button>
        </nav>

        {activeSection === "configs" ? (
          <div className="filterBlock">
          <h2>供应商</h2>
          <button
            className={`filterItem ${providerFilter === allProviderFilterId ? "activeFilter" : ""}`}
            onClick={() => {
              setActiveSection("configs");
              setProviderFilter(allProviderFilterId);
            }}
            type="button"
          >
            <span>全部</span>
            <span>{configs.length}</span>
          </button>
          {providerFilterItems.map((item) => (
            <button
              className={`filterItem ${providerFilter === item.id ? "activeFilter" : ""}`}
              key={item.id}
              onClick={() => {
                setActiveSection("configs");
                setProviderFilter(item.id);
              }}
              type="button"
            >
              <span>{item.label}</span>
              <span>{item.count}</span>
            </button>
          ))}
          </div>
        ) : null}
      </aside>

      <section className="workbench">
        <header className={`topbar ${activeSection === "configs" ? "configTopbar" : "sectionTopbar"}`}>
          {activeSection === "configs" ? (
            <div className="searchBox">
              <Search size={18} />
              <input
                aria-label="搜索配置"
                placeholder="搜索名称、模型、Base URL、标签"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : (
            <div className="sectionHeading">
              <span>当前工作区</span>
              <h2>{sectionTitles[activeSection]}</h2>
            </div>
          )}
          <div className="toolbar">
            <input
              accept="application/json,.json"
              className="hiddenFileInput"
              onChange={handleImportFileChange}
              ref={importInputRef}
              type="file"
            />
            {activeSection === "configs" ? (
              <>
                <button className="iconButton" title="重置筛选" type="button" onClick={resetConfigFilters}>
                  <SlidersHorizontal size={18} />
                </button>
                <button className="secondaryButton" type="button" onClick={() => importInputRef.current?.click()}>
                  <UploadCloud size={18} />
                  导入
                </button>
                <button className="secondaryButton" type="button" onClick={exportConfigTemplates}>
                  <Download size={18} />
                  导出
                </button>
              </>
            ) : null}
            {activeSection === "configs" ? (
              <button className="primaryButton" onClick={startCreate} type="button">
              <Plus size={18} />
              新建配置
              </button>
            ) : null}
            {toolbarStatus ? <span className="toolbarStatus">{toolbarStatus}</span> : null}
          </div>
        </header>

        {activeSection === "configs" ? (
          <>
            <div className="summaryGrid">
              <div className="metricPanel">
                <span>全部配置</span>
                <strong>{configs.length}</strong>
              </div>
              <div className="metricPanel">
                <span>可用配置</span>
                <strong>{successCount}</strong>
              </div>
              <div className="metricPanel warning">
                <span>异常配置</span>
                <strong>{failedCount}</strong>
              </div>
              <div className="metricPanel">
                <span>内置供应商</span>
                <strong>{providers.length}</strong>
              </div>
            </div>

            <div className="contentGrid">
          <section className="listPanel" aria-label="配置列表">
            <div className="panelTitle">
              <h2>API 配置</h2>
              <span>{filteredConfigs.length} 项</span>
            </div>
            <div className="configList">
              {filteredConfigs.length > 0 ? (
                filteredConfigs.map((config) => (
                  <ConfigListItem
                    config={config}
                    key={config.id}
                    providerName={getProviderDisplayNameForConfig(config.providerId)}
                    selected={selectedConfig?.id === config.id}
                    onSelect={() => {
                      setSelectedId(config.id);
                      setFormMode("view");
                    }}
                  />
                ))
              ) : (
                <div className="emptyState">暂无配置</div>
              )}
            </div>
          </section>

          <section className="detailPanel" aria-label="配置详情">
            {formMode !== "view" ? (
              <form className="configForm" onSubmit={submitForm}>
                <div className="detailHeader">
                  <div>
                    <p>{formMode === "create" ? "新配置" : getProviderDisplayNameForConfig(formState.providerId)}</p>
                    <h2>{formMode === "create" ? "新建 API 配置" : "编辑 API 配置"}</h2>
                  </div>
                  <button className="iconButton" title="取消" type="button" onClick={cancelForm}>
                    <X size={18} />
                  </button>
                </div>

                <div className="formGrid">
                  <label>
                    <span>名称</span>
                    <input value={formState.name} onChange={(event) => updateFormField("name", event.target.value)} />
                  </label>
                  <label>
                    <span>供应商</span>
                    <select
                      value={getProviderSelectValue(formState.providerId, providers)}
                      onChange={(event) => updateFormProvider(event.target.value)}
                    >
                      {providerSelectOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {isFormOpenAiCompatible ? (
                    <label>
                      <span>接口模式</span>
                      <select
                        value={formState.endpointMode}
                        onChange={(event) =>
                          updateFormField("endpointMode", event.target.value as OpenAiEndpointMode)
                        }
                      >
                        {openAiEndpointModeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <small className="fieldHint">自动会对 api.openai.com 使用 Responses，其他地址使用 Chat Completions</small>
                    </label>
                  ) : null}
                  <label>
                    <span>Base URL</span>
                    <input
                      value={formState.baseUrl}
                      onChange={(event) => updateFormField("baseUrl", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>API Key</span>
                    <input
                      placeholder={formMode === "edit" && selectedConfig?.hasApiKey ? "留空保留当前密钥" : ""}
                      type="password"
                      value={formState.apiKey}
                      onChange={(event) => updateFormField("apiKey", event.target.value)}
                    />
                    {formMode === "edit" && selectedConfig?.hasApiKey ? (
                      <small className="fieldHint">{`已保存：${selectedConfig.apiKeyPreview}，留空将保留当前密钥`}</small>
                    ) : null}
                  </label>
                  <label className="modelField">
                    <span>默认模型</span>
                    <div className="modelInputRow">
                      <input
                        value={formState.defaultModel}
                        onChange={(event) => updateFormField("defaultModel", event.target.value)}
                      />
                      <button
                        className="secondaryButton compactButton"
                        disabled={!canFetchFormModels || fetchingModels}
                        type="button"
                        onClick={fetchFormModelOptions}
                      >
                        {fetchingModels ? "获取中" : "获取模型"}
                      </button>
                    </div>
                    {modelFetchAttempted ? (
                      <div className="modelSelectBlock">
                        <select
                          aria-label="可选模型列表"
                          disabled={modelFetchOptions.length === 0}
                          size={Math.min(Math.max(modelFetchOptions.length, 2), 6)}
                          value={getFetchedModelSelectValue(modelFetchOptions, formState.defaultModel)}
                          onChange={(event) => updateFormField("defaultModel", event.target.value)}
                        >
                          {modelFetchOptions.map((modelId) => (
                            <option key={modelId} value={modelId}>
                              {modelId}
                            </option>
                          ))}
                        </select>
                        {modelFetchStatus ? <span>{modelFetchStatus}</span> : null}
                      </div>
                    ) : null}
                  </label>
                  <label>
                    <span>环境</span>
                    <select
                      value={formState.environment}
                      onChange={(event) => updateFormField("environment", event.target.value as EnvironmentName)}
                    >
                      {environmentOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>标签</span>
                    <input
                      value={formState.tagsText}
                      onChange={(event) => updateFormField("tagsText", event.target.value)}
                    />
                  </label>
                  <div className="formField toggleField">
                    <span>状态</span>
                    <div className="switchRow">
                      <input
                        id="config-is-enabled"
                        type="checkbox"
                        checked={formState.isEnabled}
                        onChange={(event) => updateFormField("isEnabled", event.target.checked)}
                      />
                      <label htmlFor="config-is-enabled">{formState.isEnabled ? "启用" : "停用"}</label>
                    </div>
                  </div>
                  <label className="wideField">
                    <span>备注</span>
                    <textarea
                      rows={4}
                      value={formState.notes}
                      onChange={(event) => updateFormField("notes", event.target.value)}
                    />
                  </label>
                </div>

                {formError ? <div className="formError">{formError}</div> : null}

                <div className="formActions">
                  <button className="secondaryButton" type="button" onClick={cancelForm}>
                    <X size={18} />
                    取消
                  </button>
                  <button className="primaryButton" type="submit">
                    <Save size={18} />
                    保存
                  </button>
                </div>
              </form>
            ) : selectedConfig ? (
              <>
                <div className="detailHeader">
                  <div>
                    <p>{getProviderDisplayNameForConfig(selectedConfig.providerId)}</p>
                    <h2>{selectedConfig.name}</h2>
                  </div>
                  <span className={`statusPill ${statusMeta[selectedConfig.lastTestStatus].className}`}>
                    <StatusIcon status={selectedConfig.lastTestStatus} />
                    {statusMeta[selectedConfig.lastTestStatus].label}
                  </span>
                </div>

                <div className="fieldGrid">
                  <label>
                    <span>Base URL</span>
                    <input value={selectedConfig.baseUrl} readOnly />
                  </label>
                  <label>
                    <span>API Key</span>
                    <div className="secretField">
                      <input value={selectedSecretValue} readOnly />
                      <button
                        className="iconButton"
                        disabled={!canUseSelectedSecret}
                        title={isSelectedSecretRevealed ? "隐藏密钥" : "显示密钥"}
                        type="button"
                        onClick={revealSelectedSecret}
                      >
                        {isSelectedSecretRevealed ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                      <button
                        className="iconButton"
                        disabled={!canUseSelectedSecret}
                        title="复制密钥"
                        type="button"
                        onClick={copySelectedSecret}
                      >
                        <Clipboard size={17} />
                      </button>
                    </div>
                  </label>
                  <label>
                    <span>默认模型</span>
                    <input value={selectedConfig.defaultModel} readOnly />
                  </label>
                  {isSelectedOpenAiCompatible ? (
                    <label>
                      <span>接口模式</span>
                      <input value={openAiEndpointModeLabels[selectedConfig.endpointMode]} readOnly />
                    </label>
                  ) : null}
                  <label>
                    <span>环境</span>
                    <input value={environmentLabels[selectedConfig.environment]} readOnly />
                  </label>
                </div>

                {secretActionStatus ? <div className="secretActionStatus">{secretActionStatus}</div> : null}

                <div className="notesPanel">
                  <span>备注</span>
                  <p>{selectedConfig.notes || "暂无备注"}</p>
                </div>

                <div className="actionStrip">
                  <button
                    className="primaryButton"
                    disabled={isTestingSelectedConfig}
                    type="button"
                    onClick={testSelectedConnection}
                  >
                    <Gauge size={18} />
                    {isTestingSelectedConfig ? "测试中" : "测试连接"}
                  </button>
                  <button className="secondaryButton" type="button" onClick={showGeneratedSnippets}>
                    <FileCode2 size={18} />
                    生成片段
                  </button>
                  <button className="secondaryButton" type="button" onClick={copySelectedEnvSnippet}>
                    <Clipboard size={18} />
                    复制环境变量
                  </button>
                  <button className="secondaryButton" onClick={startEdit}>
                    <Pencil size={18} />
                    编辑
                  </button>
                  <button className="dangerButton" onClick={deleteSelectedConfig}>
                    <Trash2 size={18} />
                    删除
                  </button>
                </div>

                {connectionTestStatus ? <div className="testActionStatus">{connectionTestStatus}</div> : null}

                <ModelCatalogPanel
                  provider={catalogProvider}
                  models={catalogModels}
                  selectedModelId={selectedCatalogModel?.id ?? ""}
                  statusMessage={catalogFetchStatus}
                  onSelectModel={setSelectedModelId}
                />

                <div id="generated-snippets-panel" ref={toolConfigPanelRef}>
                  <CodingToolConfigPanel
                    provider={catalogProvider}
                    model={selectedCatalogModel}
                    baseUrl={selectedBaseUrl}
                    selectedTarget={selectedCodingTool}
                    copyStatus={copyStatus}
                    onSelectTarget={setSelectedCodingTool}
                    onCopy={copyGeneratedConfig}
                  />
                </div>

                <div className="snippetPanel" ref={envSnippetPanelRef}>
                  <div className="panelTitle">
                    <h2>.env</h2>
                    <button className="iconButton" title="复制片段" type="button" onClick={copySelectedEnvSnippet}>
                      <Clipboard size={17} />
                    </button>
                  </div>
                  <pre>{createEnvSnippet(selectedConfig)}</pre>
                </div>

                <div className="historyPanel">
                  <div className="panelTitle">
                    <h2>最近测试</h2>
                    <span>{selectedHistory.length} 条</span>
                  </div>
                  {selectedHistory.length > 0 ? (
                    selectedHistory.map((item) => (
                      <div className="historyItem" key={item.id}>
                        <span className={`statusDot ${statusMeta[item.status].className}`} />
                        <div>
                          <strong>{statusMeta[item.status].label}</strong>
                          <p>{getHistorySummary(item)}</p>
                        </div>
                        <time dateTime={item.testedAt}>{formatLocalDateTime(item.testedAt) || item.testedAt}</time>
                        <TestHistoryDetails item={item} />
                      </div>
                    ))
                  ) : (
                    <div className="emptyState">暂无测试记录</div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="emptyState spacious">
                  <RotateCcw size={20} />
                  暂无配置
                </div>
                <ModelCatalogPanel
                  provider={catalogProvider}
                  models={catalogModels}
                  selectedModelId={selectedCatalogModel?.id ?? ""}
                  statusMessage={catalogFetchStatus}
                  onSelectModel={setSelectedModelId}
                />
                <CodingToolConfigPanel
                  provider={catalogProvider}
                  model={selectedCatalogModel}
                  baseUrl={selectedBaseUrl}
                  selectedTarget={selectedCodingTool}
                  copyStatus={copyStatus}
                  onSelectTarget={setSelectedCodingTool}
                  onCopy={copyGeneratedConfig}
                />
              </>
            )}
              </section>
            </div>
          </>
        ) : activeSection === "chat" ? (
          <ChatModule
            configs={configs}
            getProviderDisplayName={getProviderDisplayNameForConfig}
            modelFetchTransport={modelFetchTransport}
            providerModels={providerModels}
            providers={providers}
            selectedConfigId={selectedId}
            transport={chatTransport}
            onSelectConfig={(configId) => {
              setSelectedId(configId);
              setFormMode("view");
            }}
          />
        ) : activeSection === "proxy" ? (
          <RouteProxyModule
            configs={configs}
            getProviderDisplayName={getProviderDisplayNameForConfig}
            onProfileInventoryChange={refreshRouteProxyProfileInventory}
            profileStore={routeProxyProfileStore}
            profileStoreVersion={routeProxyProfileStoreVersion}
            providers={providers}
            selectedConfigId={selectedId}
            transport={routeProxyTransport}
            onSelectConfig={(configId) => {
              setSelectedId(configId);
              setFormMode("view");
            }}
          />
        ) : (
          <SecondarySectionPanel
            activeSection={activeSection}
            batchTestStatus={batchTestStatus}
            configs={configs}
            isBatchTesting={isBatchTesting}
            onBatchTestEnabledConfigs={testEnabledConnections}
            onCancelBatchTest={cancelBatchConnectionTest}
            providerFilter={providerFilter}
            providerModels={providerModels}
            providers={providers}
            routeProxyProfileInventory={routeProxyProfileInventory}
            runtimeInfo={runtimeInfo}
            secretStorageAvailable={secretStorageAvailable}
            testHistory={testHistory}
          />
        )}
      </section>
    </main>
    </div>
  );
}
