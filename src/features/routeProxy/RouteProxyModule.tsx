import { Clipboard, Play, Plus, Power, PowerOff, RefreshCw, Route, Save, Square, Trash2, X } from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRouteProxyClientAdapterSnippets,
  createRouteProxyEndpointExamples,
  createRouteProxyLocalBaseUrl,
  createRouteProxyOrigin,
  createRouteProxyStreamingExample,
  createRouteProxyTarget,
  defaultRouteProxyCooldownMs,
  defaultRouteProxyFailureThreshold,
  defaultRouteProxyRoutingMode,
  defaultRouteProxyTargetWeight,
  emptyRouteProxyDiagnosticEntries,
  emptyRouteProxyDiagnosticsManifest,
  emptyRouteProxyStatus,
  fallbackRouteProxyDefaultConfig,
  getRouteProxyConfigProblem,
  maxRouteProxyCooldownMs,
  maxRouteProxyFailureThreshold,
  maxRouteProxyTargetWeight,
  minRouteProxyCooldownMs,
  minRouteProxyFailureThreshold,
  minRouteProxyTargetWeight,
  type RouteProxyDiagnosticEntry,
  type RouteProxyDiagnosticEventType,
  type RouteProxyDiagnosticsManifest,
  type RouteProxyClientAdapterTarget,
  type RouteProxyRequestLog,
  type RouteProxyRoutingMode,
  type RouteProxyStatus,
  type RouteProxyTarget,
  type RouteProxyTransport
} from "../../services/routeProxyTransport";
import {
  createLocalStorageRouteProxyProfileStore,
  createRouteProxyProfileId,
  type RouteProxyProfile,
  type RouteProxyProfileStore
} from "../../services/routeProxyProfileStore";
import type { ApiConfig, ApiProvider } from "../../types";
import { environmentLabels, normalizeProviderId } from "../../types";

interface RouteProxyModuleProps {
  configs: ApiConfig[];
  getProviderDisplayName: (providerId: string) => string;
  onSelectConfig: (configId: string) => void;
  profileStore?: RouteProxyProfileStore;
  profileStoreVersion?: number;
  providers: ApiProvider[];
  selectedConfigId: string;
  transport: RouteProxyTransport | undefined;
}

type RouteProxyDiagnosticEventFilter = "all" | RouteProxyDiagnosticEventType;
type RouteProxyTargetWeightValues = Record<string, string>;

export interface RouteProxyHealthHistorySummary {
  cooldownCount: number;
  latestAt: string;
  recoveryCount: number;
  total: number;
}

const routeProxyDiagnosticEventFilters: Array<{
  label: string;
  value: RouteProxyDiagnosticEventFilter;
}> = [
  {
    label: "\u5168\u90e8",
    value: "all"
  },
  {
    label: "\u8bf7\u6c42",
    value: "request"
  },
  {
    label: "\u5065\u5eb7",
    value: "target-health"
  }
];

const routeProxyRoutingModeOptions: Array<{
  label: string;
  value: RouteProxyRoutingMode;
}> = [
  {
    label: "故障切换",
    value: "ordered"
  },
  {
    label: "权重轮询",
    value: "weighted"
  }
];

function getProviderForConfig(config: ApiConfig | undefined, providers: ApiProvider[]): ApiProvider | undefined {
  if (!config) {
    return undefined;
  }

  const providerId = normalizeProviderId(config.providerId);
  return providers.find((provider) => normalizeProviderId(provider.id) === providerId);
}

function formatDateTime(value: string): string {
  if (!value) {
    return "无";
  }

  return new Date(value).toLocaleString("zh-CN", {
    hour12: false
  });
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0 秒";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = Math.floor(seconds % 60);

  return [
    hours > 0 ? `${hours} 小时` : "",
    minutes > 0 ? `${minutes} 分钟` : "",
    `${restSeconds} 秒`
  ]
    .filter(Boolean)
    .join(" ");
}

function formatLatencyMs(latencyMs: number): string {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
    return "0ms";
  }

  return `${Math.round(latencyMs)}ms`;
}

function formatDiagnosticsRetention(manifest: RouteProxyDiagnosticsManifest): string {
  return `${manifest.retention.maxAgeDays} 天 / ${manifest.retention.maxEntries} 条`;
}

function getDiagnosticItemClassName(entry: RouteProxyDiagnosticEntry): string {
  return [
    "routeProxyRequestLogItem",
    entry.ok ? "ok" : "failed",
    entry.eventType === "target-health" ? "healthEvent" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function getDiagnosticMethodLabel(entry: RouteProxyDiagnosticEntry): string {
  return entry.eventType === "target-health" ? "\u5065\u5eb7" : entry.method;
}

function getDiagnosticTitle(entry: RouteProxyDiagnosticEntry): string {
  if (entry.eventType !== "target-health") {
    return entry.path;
  }

  return entry.targetHealthState === "cooling-down" ? "\u76ee\u6807\u8fdb\u5165\u51b7\u5374" : "\u76ee\u6807\u5df2\u6062\u590d";
}

function getDiagnosticStatusLabel(entry: RouteProxyDiagnosticEntry): string {
  if (entry.eventType !== "target-health") {
    return entry.statusCode ? String(entry.statusCode) : "-";
  }

  return entry.targetHealthState === "cooling-down" ? "\u51b7\u5374\u4e2d" : "\u53ef\u7528";
}

function getDiagnosticEventMetaLabel(entry: RouteProxyDiagnosticEntry): string {
  return entry.eventType === "target-health"
    ? "\u5065\u5eb7\u4e8b\u4ef6"
    : `\u7b2c ${entry.attempt} \u6b21`;
}

export function summarizeRouteProxyHealthHistory(
  entries: RouteProxyDiagnosticEntry[]
): RouteProxyHealthHistorySummary {
  return entries
    .filter((entry) => entry.eventType === "target-health")
    .reduce<RouteProxyHealthHistorySummary>(
      (summary, entry) => {
        const entryTimestamp = entry.completedAt || entry.startedAt;
        const currentLatestTime = summary.latestAt ? new Date(summary.latestAt).getTime() : 0;
        const entryTime = entryTimestamp ? new Date(entryTimestamp).getTime() : 0;

        return {
          cooldownCount: summary.cooldownCount + (entry.targetHealthState === "cooling-down" ? 1 : 0),
          latestAt: entryTime > currentLatestTime ? entryTimestamp : summary.latestAt,
          recoveryCount: summary.recoveryCount + (entry.targetHealthState === "available" ? 1 : 0),
          total: summary.total + 1
        };
      },
      {
        cooldownCount: 0,
        latestAt: "",
        recoveryCount: 0,
        total: 0
      }
    );
}

const minRouteProxyCooldownSeconds = Math.ceil(minRouteProxyCooldownMs / 1000);
const maxRouteProxyCooldownSeconds = Math.floor(maxRouteProxyCooldownMs / 1000);

function formatCooldownSeconds(cooldownMs: number): string {
  return String(Math.round(cooldownMs / 1000));
}

function getRouteProxyFailoverPolicyProblem(failureThresholdValue: string, cooldownSecondsValue: string): string {
  const failureThreshold = Number(failureThresholdValue.trim());
  const cooldownSeconds = Number(cooldownSecondsValue.trim());

  if (
    !Number.isInteger(failureThreshold) ||
    failureThreshold < minRouteProxyFailureThreshold ||
    failureThreshold > maxRouteProxyFailureThreshold
  ) {
    return `失败阈值必须是 ${minRouteProxyFailureThreshold} 到 ${maxRouteProxyFailureThreshold} 的整数`;
  }

  if (
    !Number.isInteger(cooldownSeconds) ||
    cooldownSeconds < minRouteProxyCooldownSeconds ||
    cooldownSeconds > maxRouteProxyCooldownSeconds
  ) {
    return `冷却秒数必须是 ${minRouteProxyCooldownSeconds} 到 ${maxRouteProxyCooldownSeconds} 的整数`;
  }

  return "";
}

function normalizeRouteProxyTargetWeightValue(weightValue: string): number {
  const weight = Number(weightValue.trim());

  if (!Number.isInteger(weight)) {
    return defaultRouteProxyTargetWeight;
  }

  return Math.min(Math.max(weight, minRouteProxyTargetWeight), maxRouteProxyTargetWeight);
}

function getRouteProxyTargetWeightProblem(
  routingMode: RouteProxyRoutingMode,
  targetIds: string[],
  targetWeightValues: RouteProxyTargetWeightValues
): string {
  if (routingMode !== "weighted") {
    return "";
  }

  for (const targetId of targetIds) {
    const value = targetWeightValues[targetId] ?? String(defaultRouteProxyTargetWeight);
    const weight = Number(value.trim());

    if (!Number.isInteger(weight) || weight < minRouteProxyTargetWeight || weight > maxRouteProxyTargetWeight) {
      return `权重必须是 ${minRouteProxyTargetWeight} 到 ${maxRouteProxyTargetWeight} 的整数`;
    }
  }

  return "";
}

async function copyText(text: string): Promise<void> {
  if (typeof window !== "undefined" && window.deskApi?.clipboard?.writeText) {
    await window.deskApi.clipboard.writeText(text);
    return;
  }

  await navigator.clipboard.writeText(text);
}

function RouteProxyInfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="infoRow">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function RouteProxyModule({
  configs,
  getProviderDisplayName,
  onSelectConfig,
  profileStore: providedProfileStore,
  profileStoreVersion = 0,
  providers,
  selectedConfigId,
  transport
}: RouteProxyModuleProps) {
  const [selectedProxyConfigId, setSelectedProxyConfigId] = useState(selectedConfigId);
  const [listenAddress, setListenAddress] = useState(fallbackRouteProxyDefaultConfig.listenAddress);
  const [listenPort, setListenPort] = useState(String(fallbackRouteProxyDefaultConfig.listenPort));
  const [status, setStatus] = useState<RouteProxyStatus>(emptyRouteProxyStatus);
  const [requestLogs, setRequestLogs] = useState<RouteProxyRequestLog[]>([]);
  const [diagnosticsManifest, setDiagnosticsManifest] = useState<RouteProxyDiagnosticsManifest>(
    emptyRouteProxyDiagnosticsManifest
  );
  const [diagnosticEntries, setDiagnosticEntries] = useState<RouteProxyDiagnosticEntry[]>(
    emptyRouteProxyDiagnosticEntries
  );
  const [diagnosticHealthEntries, setDiagnosticHealthEntries] = useState<RouteProxyDiagnosticEntry[]>(
    emptyRouteProxyDiagnosticEntries
  );
  const [diagnosticEventFilter, setDiagnosticEventFilter] = useState<RouteProxyDiagnosticEventFilter>("all");
  const [selectedClientAdapterTarget, setSelectedClientAdapterTarget] =
    useState<RouteProxyClientAdapterTarget>("openai-sdk");
  const [actionStatus, setActionStatus] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [profiles, setProfiles] = useState<RouteProxyProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [failoverTargetIds, setFailoverTargetIds] = useState<string[]>([]);
  const [pendingFailoverTargetId, setPendingFailoverTargetId] = useState("");
  const [failureThreshold, setFailureThreshold] = useState(String(defaultRouteProxyFailureThreshold));
  const [cooldownSeconds, setCooldownSeconds] = useState(formatCooldownSeconds(defaultRouteProxyCooldownMs));
  const [routingMode, setRoutingMode] = useState<RouteProxyRoutingMode>(defaultRouteProxyRoutingMode);
  const [targetWeightValues, setTargetWeightValues] = useState<RouteProxyTargetWeightValues>({});
  const fallbackProfileStore = useMemo(() => createLocalStorageRouteProxyProfileStore(), []);
  const profileStore = providedProfileStore ?? fallbackProfileStore;
  const onSelectConfigRef = useRef(onSelectConfig);
  const profileAppliedRef = useRef(false);

  useEffect(() => {
    onSelectConfigRef.current = onSelectConfig;
  }, [onSelectConfig]);

  useEffect(() => {
    if (selectedConfigId) {
      setSelectedProxyConfigId(selectedConfigId);
    }
  }, [selectedConfigId]);

  useEffect(() => {
    if (selectedProxyConfigId && configs.some((config) => config.id === selectedProxyConfigId)) {
      return;
    }

    const nextConfig = configs.find((config) => config.isEnabled) ?? configs[0];

    if (nextConfig) {
      setSelectedProxyConfigId(nextConfig.id);
      onSelectConfig(nextConfig.id);
    }
  }, [configs, onSelectConfig, selectedProxyConfigId]);

  useEffect(() => {
    setFailoverTargetIds((currentIds) =>
      currentIds.filter(
        (configId, index) =>
          configId !== selectedProxyConfigId &&
          currentIds.indexOf(configId) === index &&
          configs.some((config) => config.id === configId)
      )
    );
  }, [configs, selectedProxyConfigId]);

  const selectedConfig = useMemo(
    () => configs.find((config) => config.id === selectedProxyConfigId),
    [configs, selectedProxyConfigId]
  );
  const selectedProvider = useMemo(
    () => getProviderForConfig(selectedConfig, providers),
    [providers, selectedConfig]
  );
  const configNameById = useMemo(() => new Map(configs.map((config) => [config.id, config.name])), [configs]);
  const getTargetWeightInput = useCallback(
    (configId: string) => targetWeightValues[configId] ?? String(defaultRouteProxyTargetWeight),
    [targetWeightValues]
  );
  const getTargetWeight = useCallback(
    (configId: string) => normalizeRouteProxyTargetWeightValue(getTargetWeightInput(configId)),
    [getTargetWeightInput]
  );
  const createTargetForConfig = useCallback(
    (config: ApiConfig | undefined) => {
      const provider = getProviderForConfig(config, providers);

      if (!config || !provider || getRouteProxyConfigProblem(config, provider)) {
        return undefined;
      }

      return {
        ...createRouteProxyTarget(config, provider),
        weight: getTargetWeight(config.id)
      };
    },
    [getTargetWeight, providers]
  );
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId]
  );
  const parsedListenPort = Number.parseInt(listenPort, 10);
  const normalizedListenPort = Number.isFinite(parsedListenPort)
    ? parsedListenPort
    : fallbackRouteProxyDefaultConfig.listenPort;
  const failoverPolicyProblem = getRouteProxyFailoverPolicyProblem(failureThreshold, cooldownSeconds);
  const normalizedFailureThreshold = failoverPolicyProblem
    ? defaultRouteProxyFailureThreshold
    : Number(failureThreshold.trim());
  const normalizedCooldownMs = failoverPolicyProblem
    ? defaultRouteProxyCooldownMs
    : Number(cooldownSeconds.trim()) * 1000;
  const configProblem = getRouteProxyConfigProblem(selectedConfig, selectedProvider);
  const selectedRouteProxyTarget = createTargetForConfig(selectedConfig);
  const failoverRouteProxyTargets = failoverTargetIds
    .map((configId) => createTargetForConfig(configs.find((config) => config.id === configId)))
    .filter((target): target is RouteProxyTarget => Boolean(target));
  const routeProxyTargets = selectedRouteProxyTarget
    ? [selectedRouteProxyTarget, ...failoverRouteProxyTargets]
    : failoverRouteProxyTargets;
  const routeProxyTargetIds = routeProxyTargets.map((target) => target.configId);
  const targetWeightProblem = getRouteProxyTargetWeightProblem(routingMode, routeProxyTargetIds, targetWeightValues);
  const availableFailoverConfigs = configs.filter((config) => {
    if (config.id === selectedProxyConfigId || failoverTargetIds.includes(config.id)) {
      return false;
    }

    return Boolean(createTargetForConfig(config));
  });
  const failoverConfigs = failoverTargetIds
    .map((configId) => configs.find((config) => config.id === configId))
    .filter((config): config is ApiConfig => Boolean(config));
  const canStart = Boolean(
    transport &&
      selectedConfig &&
      selectedProvider &&
      !configProblem &&
      !failoverPolicyProblem &&
      !targetWeightProblem &&
      routeProxyTargets.length > 0 &&
      !isBusy
  );

  useEffect(() => {
    if (pendingFailoverTargetId && availableFailoverConfigs.some((config) => config.id === pendingFailoverTargetId)) {
      return;
    }

    setPendingFailoverTargetId(availableFailoverConfigs[0]?.id ?? "");
  }, [availableFailoverConfigs, pendingFailoverTargetId]);
  useEffect(() => {
    const currentTargetIds = new Set(routeProxyTargetIds);

    setTargetWeightValues((currentValues) =>
      Object.fromEntries(Object.entries(currentValues).filter(([configId]) => currentTargetIds.has(configId)))
    );
  }, [routeProxyTargetIds.join("|")]);
  const effectiveAddress = status.running ? status.address : listenAddress;
  const effectivePort = status.running ? status.port : normalizedListenPort;
  const effectiveFailureThreshold = status.running ? status.failureThreshold : normalizedFailureThreshold;
  const effectiveCooldownMs = status.running ? status.cooldownMs : normalizedCooldownMs;
  const effectiveTargetBaseUrl = status.running ? status.targetBaseUrl : selectedConfig?.baseUrl ?? "";
  const proxyOrigin = createRouteProxyOrigin(effectiveAddress, effectivePort);
  const localBaseUrl = createRouteProxyLocalBaseUrl(effectiveAddress, effectivePort, effectiveTargetBaseUrl);
  const routeProxyExamples = createRouteProxyEndpointExamples(localBaseUrl);
  const streamingExample = createRouteProxyStreamingExample(localBaseUrl, selectedConfig?.defaultModel ?? "");
  const clientAdapterSnippets = useMemo(
    () => createRouteProxyClientAdapterSnippets(localBaseUrl, selectedConfig?.defaultModel ?? ""),
    [localBaseUrl, selectedConfig?.defaultModel]
  );
  const selectedClientAdapterSnippet =
    clientAdapterSnippets.find((snippet) => snippet.target === selectedClientAdapterTarget) ?? clientAdapterSnippets[0];

  const applyProfile = useCallback(
    (profile: RouteProxyProfile) => {
      profileAppliedRef.current = true;
      setSelectedProfileId(profile.id);
      setProfileName(profile.name);
      setListenAddress(profile.listenAddress);
      setListenPort(String(profile.listenPort));
      setFailureThreshold(String(profile.failureThreshold));
      setCooldownSeconds(formatCooldownSeconds(profile.cooldownMs));
      setRoutingMode(profile.routingMode ?? defaultRouteProxyRoutingMode);
      setTargetWeightValues(
        Object.fromEntries(
          Object.entries(profile.targetWeights ?? {}).map(([configId, weight]) => [configId, String(weight)])
        )
      );
      setFailoverTargetIds(
        profile.failoverConfigIds.filter(
          (configId) => configId !== profile.configId && configs.some((config) => config.id === configId)
        )
      );

      if (configs.some((config) => config.id === profile.configId)) {
        setSelectedProxyConfigId(profile.configId);
        onSelectConfigRef.current(profile.configId);
      }
    },
    [configs]
  );

  const reloadProfiles = useCallback(() => {
    if (!profileStore) {
      return;
    }

    setProfiles(profileStore.listProfiles());
  }, [profileStore]);

  useEffect(() => {
    if (!profileStore) {
      return;
    }

    const nextProfiles = profileStore.listProfiles();
    const activeProfile =
      nextProfiles.find((profile) => profile.id === profileStore.getActiveProfileId()) ?? nextProfiles[0];

    setProfiles(nextProfiles);

    if (activeProfile) {
      applyProfile(activeProfile);
    }
  }, [applyProfile, profileStore, profileStoreVersion]);

  const refreshStatus = useCallback(async () => {
    if (!transport) {
      setStatus(emptyRouteProxyStatus);
      setRequestLogs([]);
      return;
    }

    const [nextStatus, nextRequestLogs] = await Promise.all([transport.getStatus(), transport.getRequestLogs()]);

    setStatus(nextStatus);
    setRequestLogs(nextRequestLogs);
  }, [transport]);

  const refreshDiagnostics = useCallback(async () => {
    if (!transport) {
      setDiagnosticsManifest(emptyRouteProxyDiagnosticsManifest);
      setDiagnosticEntries(emptyRouteProxyDiagnosticEntries);
      setDiagnosticHealthEntries(emptyRouteProxyDiagnosticEntries);
      return;
    }

    const eventType = diagnosticEventFilter === "all" ? undefined : diagnosticEventFilter;
    const [nextManifest, nextEntries, nextHealthEntries] = await Promise.all([
      transport.getDiagnosticsManifest(),
      transport.readDiagnostics({
        eventType,
        limit: 8
      }),
      transport.readDiagnostics({
        eventType: "target-health",
        limit: 6
      })
    ]);

    setDiagnosticsManifest(nextManifest);
    setDiagnosticEntries(nextEntries);
    setDiagnosticHealthEntries(nextHealthEntries);
  }, [diagnosticEventFilter, transport]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshDiagnostics()]);
  }, [refreshDiagnostics, refreshStatus]);

  useEffect(() => {
    let isMounted = true;

    if (!transport) {
      setStatus(emptyRouteProxyStatus);
      setRequestLogs([]);
      setDiagnosticsManifest(emptyRouteProxyDiagnosticsManifest);
      setDiagnosticEntries(emptyRouteProxyDiagnosticEntries);
      return () => {
        isMounted = false;
      };
    }

    void transport
      .getDefaultConfig()
      .then((defaultConfig) => {
        if (!isMounted || profileAppliedRef.current) {
          return;
        }

        setListenAddress(defaultConfig.listenAddress);
        setListenPort(String(defaultConfig.listenPort));
      })
      .catch(() => undefined);
    void refreshAll();

    return () => {
      isMounted = false;
    };
  }, [refreshAll, transport]);

  useEffect(() => {
    if (!transport || !status.running) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 2500);

    return () => window.clearInterval(timer);
  }, [refreshStatus, status.running, transport]);

  const handleSelectConfig = (event: ChangeEvent<HTMLSelectElement>) => {
    const configId = event.target.value;

    setSelectedProxyConfigId(configId);
    onSelectConfig(configId);
  };

  const handleSelectProfile = (event: ChangeEvent<HTMLSelectElement>) => {
    const profileId = event.target.value;

    if (!profileId) {
      setSelectedProfileId("");
      setProfileName("");
      setFailoverTargetIds([]);
      setFailureThreshold(String(defaultRouteProxyFailureThreshold));
      setCooldownSeconds(formatCooldownSeconds(defaultRouteProxyCooldownMs));
      setRoutingMode(defaultRouteProxyRoutingMode);
      setTargetWeightValues({});
      profileStore?.setActiveProfileId("");
      return;
    }

    const nextProfile = profiles.find((profile) => profile.id === profileId);

    if (!nextProfile) {
      return;
    }

    profileStore?.setActiveProfileId(nextProfile.id);
    applyProfile(nextProfile);
  };

  const addFailoverTarget = () => {
    if (!pendingFailoverTargetId) {
      return;
    }

    setFailoverTargetIds((currentIds) =>
      currentIds.includes(pendingFailoverTargetId) ? currentIds : [...currentIds, pendingFailoverTargetId]
    );
  };

  const removeFailoverTarget = (configId: string) => {
    setFailoverTargetIds((currentIds) => currentIds.filter((item) => item !== configId));
  };

  const updateTargetWeightValue = (configId: string, value: string) => {
    setTargetWeightValues((currentValues) => ({
      ...currentValues,
      [configId]: value
    }));
  };

  const setTemporaryActionStatus = (message: string) => {
    setActionStatus(message);
    window.setTimeout(() => {
      setActionStatus((currentMessage) => (currentMessage === message ? "" : currentMessage));
    }, 2400);
  };

  const startProxy = async () => {
    if (!transport || !selectedConfig || !selectedProvider || configProblem) {
      setTemporaryActionStatus(configProblem || "当前环境不支持路由代理");
      return;
    }

    if (failoverPolicyProblem) {
      setTemporaryActionStatus(failoverPolicyProblem);
      return;
    }

    if (targetWeightProblem) {
      setTemporaryActionStatus(targetWeightProblem);
      return;
    }

    setIsBusy(true);

    try {
      const primaryTarget = routeProxyTargets[0] ?? createRouteProxyTarget(selectedConfig, selectedProvider);
      const nextStatus = await transport.start({
        cooldownMs: normalizedCooldownMs,
        failureThreshold: normalizedFailureThreshold,
        listenAddress,
        listenPort: normalizedListenPort,
        profileId: selectedProfileId,
        routingMode,
        target: primaryTarget,
        targets: routeProxyTargets,
        timeoutMs: 120_000
      });

      setStatus(nextStatus);
      setTemporaryActionStatus("路由代理已启动");
    } catch (error) {
      setTemporaryActionStatus(error instanceof Error ? error.message : "启动失败");
    } finally {
      setIsBusy(false);
    }
  };

  const stopProxy = async () => {
    if (!transport) {
      return;
    }

    setIsBusy(true);

    try {
      setStatus(await transport.stop());
      setTemporaryActionStatus("路由代理已停止");
    } catch (error) {
      setTemporaryActionStatus(error instanceof Error ? error.message : "停止失败");
    } finally {
      setIsBusy(false);
    }
  };

  const copyLocalBaseUrl = async () => {
    try {
      await copyText(localBaseUrl);
      setTemporaryActionStatus("已复制本地 Base URL");
    } catch {
      setTemporaryActionStatus("复制失败");
    }
  };

  const copyStreamingExample = async () => {
    try {
      await copyText(streamingExample);
      setTemporaryActionStatus("已复制流式示例");
    } catch {
      setTemporaryActionStatus("复制失败");
    }
  };

  const copyClientAdapterSnippet = async () => {
    try {
      await copyText(selectedClientAdapterSnippet.content);
      setTemporaryActionStatus("已复制客户端适配配置");
    } catch {
      setTemporaryActionStatus("复制失败");
    }
  };

  const saveProfile = () => {
    if (!profileStore || !selectedProxyConfigId) {
      setTemporaryActionStatus("当前环境不支持保存代理方案");
      return;
    }

    if (failoverPolicyProblem) {
      setTemporaryActionStatus(failoverPolicyProblem);
      return;
    }

    if (targetWeightProblem) {
      setTemporaryActionStatus(targetWeightProblem);
      return;
    }

    const now = new Date().toISOString();
    const existingProfile = selectedProfile;
    const targetWeights = Object.fromEntries(
      routeProxyTargetIds
        .map((configId) => [configId, getTargetWeight(configId)] as const)
        .filter(([, weight]) => weight !== defaultRouteProxyTargetWeight)
    );
    const savedProfile = profileStore.saveProfile({
      configId: selectedProxyConfigId,
      cooldownMs: normalizedCooldownMs,
      createdAt: existingProfile?.createdAt || now,
      failoverConfigIds: failoverTargetIds,
      failureThreshold: normalizedFailureThreshold,
      id: existingProfile?.id || createRouteProxyProfileId(),
      listenAddress: listenAddress.trim() || fallbackRouteProxyDefaultConfig.listenAddress,
      listenPort: normalizedListenPort,
      name: profileName.trim() || `${selectedConfig?.name || "路由代理"} 方案`,
      routingMode,
      targetWeights,
      updatedAt: now
    });

    reloadProfiles();
    setSelectedProfileId(savedProfile.id);
    setProfileName(savedProfile.name);
    setTemporaryActionStatus("已保存代理方案");
  };

  const deleteProfile = () => {
    if (!profileStore || !selectedProfileId) {
      return;
    }

    profileStore.deleteProfile(selectedProfileId);
    reloadProfiles();
    setSelectedProfileId("");
    setProfileName("");
    setFailoverTargetIds([]);
    setFailureThreshold(String(defaultRouteProxyFailureThreshold));
    setCooldownSeconds(formatCooldownSeconds(defaultRouteProxyCooldownMs));
    setRoutingMode(defaultRouteProxyRoutingMode);
    setTargetWeightValues({});
    setTemporaryActionStatus("已删除代理方案");
  };

  const clearRequestLogs = async () => {
    if (!transport) {
      return;
    }

    try {
      setRequestLogs(await transport.clearRequestLogs());
      setTemporaryActionStatus("已清空请求日志");
    } catch (error) {
      setTemporaryActionStatus(error instanceof Error ? error.message : "清空日志失败");
    }
  };

  const enableDurableDiagnostics = async () => {
    if (!transport) {
      return;
    }

    try {
      const nextManifest = await transport.enableDiagnostics();
      const eventType = diagnosticEventFilter === "all" ? undefined : diagnosticEventFilter;
      const [nextEntries, nextHealthEntries] = await Promise.all([
        transport.readDiagnostics({
          eventType,
          limit: 8
        }),
        transport.readDiagnostics({
          eventType: "target-health",
          limit: 6
        })
      ]);

      setDiagnosticsManifest(nextManifest);
      setDiagnosticEntries(nextEntries);
      setDiagnosticHealthEntries(nextHealthEntries);
      setTemporaryActionStatus("已启用持久诊断");
    } catch (error) {
      setTemporaryActionStatus(error instanceof Error ? error.message : "启用诊断失败");
    }
  };

  const disableDurableDiagnostics = async () => {
    if (!transport) {
      return;
    }

    try {
      setDiagnosticsManifest(await transport.disableDiagnostics());
      setTemporaryActionStatus("已停用持久诊断");
    } catch (error) {
      setTemporaryActionStatus(error instanceof Error ? error.message : "停用诊断失败");
    }
  };

  const clearDurableDiagnostics = async () => {
    if (!transport) {
      return;
    }

    try {
      const result = await transport.clearDiagnostics();

      setDiagnosticsManifest(result.manifest);
      setDiagnosticEntries(result.entries);
      setDiagnosticHealthEntries(result.entries.filter((entry) => entry.eventType === "target-health"));
      setTemporaryActionStatus("已清除持久诊断");
    } catch (error) {
      setTemporaryActionStatus(error instanceof Error ? error.message : "清除诊断失败");
    }
  };

  const activeTargetText = status.running
    ? `${status.targetName} -> ${status.targetBaseUrl}`
    : selectedConfig
      ? `${selectedConfig.name} -> ${selectedConfig.baseUrl || "未填写 Base URL"}`
      : "未选择配置";
  const diagnosticHealthSummary = useMemo(
    () => summarizeRouteProxyHealthHistory(diagnosticHealthEntries),
    [diagnosticHealthEntries]
  );
  const getDiagnosticTargetLabel = useCallback(
    (targetConfigId: string) => (configNameById.get(targetConfigId) ?? targetConfigId) || "无目标",
    [configNameById]
  );

  return (
    <div className="routeProxyModule">
      <div className="routeProxyGrid">
        <section className="widePanel routeProxyControlPanel" aria-label="路由代理配置">
          <div className="panelTitle">
            <div className="titleWithIcon">
              <Route size={18} />
              <div>
                <h2>路由代理</h2>
                <p>本地 HTTP 入口会转发到选中的 API 配置</p>
              </div>
            </div>
            <span className={`routeProxyState ${status.running ? "running" : ""}`}>
              {status.running ? "运行中" : "已停止"}
            </span>
          </div>

          <div className="routeProxyForm">
            <div className="routeProxyProfileGrid">
              <label className="routeProxyField">
                <span>代理方案</span>
                <select disabled={status.running} value={selectedProfileId} onChange={handleSelectProfile}>
                  <option value="">临时方案</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="routeProxyField">
                <span>方案名称</span>
                <input
                  disabled={status.running}
                  placeholder="例如：本地开发代理"
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                />
              </label>
            </div>

            <div className="actionStrip routeProxyProfileActions">
              <button
                className="secondaryButton"
                disabled={!profileStore || !selectedProxyConfigId || status.running}
                type="button"
                onClick={saveProfile}
              >
                <Save size={16} />
                保存方案
              </button>
              <button
                className="secondaryButton dangerButton"
                disabled={!profileStore || !selectedProfileId || status.running}
                type="button"
                onClick={deleteProfile}
              >
                <Trash2 size={16} />
                删除方案
              </button>
            </div>

            <label className="routeProxyField">
              <span>代理配置</span>
              <select value={selectedProxyConfigId} onChange={handleSelectConfig}>
                {configs.map((config) => (
                  <option key={config.id} value={config.id}>
                    {`${config.name} / ${getProviderDisplayName(config.providerId)}`}
                  </option>
                ))}
              </select>
            </label>

            <div className="routeProxyFailoverPanel">
              <div className="routeProxyFailoverHeader">
                <span>故障切换目标</span>
                <em>{routeProxyTargets.length} 个目标</em>
              </div>
              <div className="routeProxyRoutingMode" role="group" aria-label="路由策略">
                {routeProxyRoutingModeOptions.map((option) => (
                  <button
                    className={routingMode === option.value ? "active" : ""}
                    disabled={status.running}
                    key={option.value}
                    type="button"
                    onClick={() => setRoutingMode(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="routeProxyFailoverPicker">
                <select
                  disabled={status.running || availableFailoverConfigs.length === 0}
                  value={pendingFailoverTargetId}
                  onChange={(event) => setPendingFailoverTargetId(event.target.value)}
                >
                  {availableFailoverConfigs.length > 0 ? (
                    availableFailoverConfigs.map((config) => (
                      <option key={config.id} value={config.id}>
                        {`${config.name} / ${getProviderDisplayName(config.providerId)}`}
                      </option>
                    ))
                  ) : (
                    <option value="">暂无可用备用目标</option>
                  )}
                </select>
                <button
                  className="secondaryButton"
                  disabled={status.running || !pendingFailoverTargetId}
                  type="button"
                  onClick={addFailoverTarget}
                >
                  <Plus size={16} />
                  添加备用
                </button>
              </div>
              <div className="routeProxyFailoverList">
                {selectedConfig ? (
                  <div className="routeProxyFailoverItem primary">
                    <span>主</span>
                    <strong>{selectedConfig.name}</strong>
                    <em>{getProviderDisplayName(selectedConfig.providerId)}</em>
                    <label className="routeProxyWeightField">
                      <span>权重</span>
                      <input
                        aria-label={`${selectedConfig.name} 权重`}
                        disabled={status.running || routingMode !== "weighted"}
                        inputMode="numeric"
                        max={maxRouteProxyTargetWeight}
                        min={minRouteProxyTargetWeight}
                        value={getTargetWeightInput(selectedConfig.id)}
                        onChange={(event) => updateTargetWeightValue(selectedConfig.id, event.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
                {failoverConfigs.map((config, index) => (
                  <div className="routeProxyFailoverItem" key={config.id}>
                    <span>{index + 2}</span>
                    <strong>{config.name}</strong>
                    <em>{getProviderDisplayName(config.providerId)}</em>
                    <label className="routeProxyWeightField">
                      <span>权重</span>
                      <input
                        aria-label={`${config.name} 权重`}
                        disabled={status.running || routingMode !== "weighted"}
                        inputMode="numeric"
                        max={maxRouteProxyTargetWeight}
                        min={minRouteProxyTargetWeight}
                        value={getTargetWeightInput(config.id)}
                        onChange={(event) => updateTargetWeightValue(config.id, event.target.value)}
                      />
                    </label>
                    <button
                      aria-label={`移除 ${config.name}`}
                      className="iconButton compactIconButton"
                      disabled={status.running}
                      type="button"
                      onClick={() => removeFailoverTarget(config.id)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="routeProxyPolicyGrid">
                <label className="routeProxyField">
                  <span>失败阈值</span>
                  <input
                    disabled={status.running}
                    inputMode="numeric"
                    value={failureThreshold}
                    onChange={(event) => setFailureThreshold(event.target.value)}
                  />
                </label>
                <label className="routeProxyField">
                  <span>冷却秒数</span>
                  <input
                    disabled={status.running}
                    inputMode="numeric"
                    value={cooldownSeconds}
                    onChange={(event) => setCooldownSeconds(event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="routeProxyInlineFields">
              <label className="routeProxyField">
                <span>监听地址</span>
                <input
                  disabled={status.running}
                  value={listenAddress}
                  onChange={(event) => setListenAddress(event.target.value)}
                />
              </label>
              <label className="routeProxyField">
                <span>端口</span>
                <input
                  disabled={status.running}
                  inputMode="numeric"
                  value={listenPort}
                  onChange={(event) => setListenPort(event.target.value)}
                />
              </label>
            </div>

            <dl className="infoList routeProxyTargetList">
              <RouteProxyInfoRow label="本地入口" value={proxyOrigin} />
              <RouteProxyInfoRow label="本地 Base URL" value={localBaseUrl} />
              <RouteProxyInfoRow label="当前目标" value={activeTargetText} />
              <RouteProxyInfoRow
                label="路由策略"
                value={routingMode === "weighted" ? "权重轮询" : "故障切换"}
              />
              <RouteProxyInfoRow label="失败阈值" value={`${effectiveFailureThreshold} 次`} />
              <RouteProxyInfoRow label="冷却时间" value={`${formatCooldownSeconds(effectiveCooldownMs)} 秒`} />
              <RouteProxyInfoRow
                label="环境"
                value={selectedConfig ? environmentLabels[selectedConfig.environment] : "无"}
              />
            </dl>

            <div className="actionStrip routeProxyActions">
              <button className="primaryButton" disabled={!canStart || status.running} type="button" onClick={startProxy}>
                <Play size={18} />
                启动代理
              </button>
              <button
                className="secondaryButton"
                disabled={!transport || !status.running || isBusy}
                type="button"
                onClick={stopProxy}
              >
                <Square size={17} />
                停止
              </button>
              <button className="secondaryButton" disabled={!transport} type="button" onClick={refreshAll}>
                <RefreshCw size={17} />
                刷新
              </button>
              <button className="secondaryButton" disabled={!effectiveTargetBaseUrl} type="button" onClick={copyLocalBaseUrl}>
                <Clipboard size={17} />
                复制 Base URL
              </button>
            </div>

            {transport ? null : <div className="routeProxyNotice">当前环境不支持 Electron 路由代理。</div>}
            {configProblem ? <div className="routeProxyNotice warning">{configProblem}</div> : null}
            {failoverPolicyProblem ? <div className="routeProxyNotice warning">{failoverPolicyProblem}</div> : null}
            {targetWeightProblem ? <div className="routeProxyNotice warning">{targetWeightProblem}</div> : null}
            {actionStatus ? <div className="routeProxyNotice">{actionStatus}</div> : null}
          </div>
        </section>

        <section className="widePanel routeProxyStatusPanel" aria-label="路由代理状态">
          <div className="panelTitle">
            <div>
              <h2>运行状态</h2>
              <p>本地代理请求统计</p>
            </div>
            <span>{status.running ? formatUptime(status.uptimeSeconds) : "未运行"}</span>
          </div>

          <div className="routeProxyMetricGrid">
            <div className="routeProxyMetric">
              <span>总请求</span>
              <strong>{status.totalRequests}</strong>
            </div>
            <div className="routeProxyMetric">
              <span>成功</span>
              <strong>{status.successRequests}</strong>
            </div>
            <div className="routeProxyMetric">
              <span>失败</span>
              <strong>{status.failedRequests}</strong>
            </div>
            <div className="routeProxyMetric">
              <span>成功率</span>
              <strong>{status.successRate}%</strong>
            </div>
          </div>

          <dl className="infoList routeProxyStatusList">
            <RouteProxyInfoRow label="活动连接" value={status.activeConnections} />
            <RouteProxyInfoRow label="启动时间" value={formatDateTime(status.startedAt)} />
            <RouteProxyInfoRow label="最近请求" value={formatDateTime(status.lastRequestAt)} />
            <RouteProxyInfoRow label="最近错误" value={status.lastError || "无"} />
          </dl>

          {status.targetHealth.length > 0 ? (
            <div className="routeProxyHealthPanel">
              <div className="routeProxyRequestLogHeader">
                <span>目标健康</span>
                <em>{status.targetCount} 个目标</em>
              </div>
              <div className="routeProxyHealthList">
                {status.targetHealth.map((target) => (
                  <div className={`routeProxyHealthItem ${target.state}`} key={target.configId}>
                    <strong>{target.name}</strong>
                    <span>{target.state === "available" ? "可用" : "冷却中"}</span>
                    <em>{target.failureCount > 0 ? `${target.failureCount} 次失败` : "无失败"}</em>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="routeProxyDiagnosticsPanel">
            <div className="routeProxyRequestLogHeader">
              <span>持久诊断</span>
              <em className={`routeProxyDiagnosticsState ${diagnosticsManifest.enabled ? "enabled" : ""}`}>
                {diagnosticsManifest.enabled ? "已启用" : "未启用"}
              </em>
            </div>
            <div className="routeProxyDiagnosticsMeta">
              <span>{formatDiagnosticsRetention(diagnosticsManifest)}</span>
              <span>{`更新 ${formatDateTime(diagnosticsManifest.updatedAt)}`}</span>
            </div>
            <div className="actionStrip routeProxyDiagnosticsActions">
              <button
                className="secondaryButton"
                disabled={!transport || diagnosticsManifest.enabled}
                type="button"
                onClick={enableDurableDiagnostics}
              >
                <Power size={15} />
                启用
              </button>
              <button
                className="secondaryButton"
                disabled={!transport || !diagnosticsManifest.enabled}
                type="button"
                onClick={disableDurableDiagnostics}
              >
                <PowerOff size={15} />
                停用
              </button>
              <button
                className="secondaryButton dangerButton"
                disabled={!transport || (!diagnosticsManifest.enabled && diagnosticEntries.length === 0)}
                type="button"
                onClick={clearDurableDiagnostics}
              >
                <Trash2 size={15} />
                清除
              </button>
            </div>
            <div className="routeProxyDiagnosticsFilter" role="group" aria-label="诊断类型">
              {routeProxyDiagnosticEventFilters.map((filter) => (
                <button
                  className={diagnosticEventFilter === filter.value ? "active" : ""}
                  disabled={!transport}
                  key={filter.value}
                  type="button"
                  onClick={() => setDiagnosticEventFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="routeProxyHealthHistoryPanel" aria-label="目标健康历史">
              <div className="routeProxyRequestLogHeader">
                <span>健康历史</span>
                <em>{diagnosticHealthSummary.total > 0 ? `最近 ${diagnosticHealthSummary.total} 条` : "暂无记录"}</em>
              </div>
              {diagnosticHealthSummary.total > 0 ? (
                <div className="routeProxyHealthHistorySummary">
                  <span>{`冷却 ${diagnosticHealthSummary.cooldownCount}`}</span>
                  <span>{`恢复 ${diagnosticHealthSummary.recoveryCount}`}</span>
                  <span>{`最新 ${formatDateTime(diagnosticHealthSummary.latestAt)}`}</span>
                </div>
              ) : null}
              {diagnosticHealthEntries.length > 0 ? (
                <div className="routeProxyHealthHistoryList">
                  {diagnosticHealthEntries.map((entry) => (
                    <div className={`routeProxyHealthHistoryItem ${entry.targetHealthState}`} key={entry.id}>
                      <div>
                        <strong>{getDiagnosticTitle(entry)}</strong>
                        <span>{getDiagnosticTargetLabel(entry.targetConfigId)}</span>
                      </div>
                      <em>{formatDateTime(entry.startedAt)}</em>
                      {entry.errorMessage ? <small>{entry.errorMessage}</small> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="routeProxyRequestLogEmpty">暂无目标健康历史</div>
              )}
            </div>
            {diagnosticEntries.length > 0 ? (
              <div className="routeProxyRequestLogList routeProxyDiagnosticsList">
                {diagnosticEntries.map((entry) => (
                  <div className={getDiagnosticItemClassName(entry)} key={entry.id}>
                    <div className="routeProxyRequestLogTop">
                      <strong>{getDiagnosticMethodLabel(entry)}</strong>
                      <span>{getDiagnosticTitle(entry)}</span>
                      <em>{getDiagnosticStatusLabel(entry)}</em>
                    </div>
                    <div className="routeProxyRequestLogMeta">
                      <span>{getDiagnosticTargetLabel(entry.targetConfigId)}</span>
                      <span>{getDiagnosticEventMetaLabel(entry)}</span>
                      <span>{formatLatencyMs(entry.latencyMs)}</span>
                      <span>{formatDateTime(entry.startedAt)}</span>
                    </div>
                    {entry.errorMessage ? <div className="routeProxyRequestLogError">{entry.errorMessage}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="routeProxyRequestLogEmpty">暂无持久诊断</div>
            )}
          </div>

          <div className="routeProxyRequestLogPanel">
            <div className="routeProxyRequestLogHeader">
              <span>请求日志</span>
              <button
                className="secondaryButton"
                disabled={!transport || requestLogs.length === 0}
                type="button"
                onClick={clearRequestLogs}
              >
                清空日志
              </button>
            </div>
            {requestLogs.length > 0 ? (
              <div className="routeProxyRequestLogList">
                {requestLogs.slice(0, 8).map((log) => (
                  <div className={`routeProxyRequestLogItem ${log.ok ? "ok" : "failed"}`} key={log.id}>
                    <div className="routeProxyRequestLogTop">
                      <strong>{log.method}</strong>
                      <span>{log.path}</span>
                      <em>{log.statusCode || "-"}</em>
                    </div>
                    <div className="routeProxyRequestLogMeta">
                      <span>{log.targetName || "无目标"}</span>
                      <span>{`第 ${log.attempt} 次`}</span>
                      <span>{formatLatencyMs(log.latencyMs)}</span>
                      <span>{formatDateTime(log.startedAt)}</span>
                    </div>
                    {log.error ? <div className="routeProxyRequestLogError">{log.error}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="routeProxyRequestLogEmpty">暂无请求日志</div>
            )}
          </div>
        </section>

        <section className="widePanel routeProxyUsagePanel" aria-label="路由代理用法">
          <div className="panelTitle">
            <div>
              <h2>接入方式</h2>
              <p>将客户端 Base URL 指向本地代理</p>
            </div>
          </div>
          <pre className="routeProxyCode">{`BASE_URL=${routeProxyExamples.baseUrl}

GET ${routeProxyExamples.modelListUrl}
POST ${routeProxyExamples.chatCompletionsUrl}`}</pre>
          <div className="routeProxyUsageText">
            保存的上游 Base URL 如果带有 /v1，本地请求中的 /v1 会自动对齐，不会重复拼接。流式响应需要按 SSE 增量读取，收到 [DONE] 后停止读取。
          </div>
          <div className="routeProxyUsageBlock">
            <div className="routeProxyUsageBlockHeader">
              <span>客户端适配</span>
              <button className="secondaryButton" type="button" onClick={copyClientAdapterSnippet}>
                <Clipboard size={15} />
                复制配置
              </button>
            </div>
            <div className="routeProxyAdapterTabs" role="tablist" aria-label="客户端适配">
              {clientAdapterSnippets.map((snippet) => (
                <button
                  className={snippet.target === selectedClientAdapterTarget ? "active" : ""}
                  key={snippet.target}
                  type="button"
                  onClick={() => setSelectedClientAdapterTarget(snippet.target)}
                >
                  {snippet.title}
                </button>
              ))}
            </div>
            <div className="routeProxyAdapterMeta">
              <strong>{selectedClientAdapterSnippet.fileName}</strong>
              <span>{selectedClientAdapterSnippet.description}</span>
            </div>
            <pre className="routeProxyCode routeProxyCodeCompact">{selectedClientAdapterSnippet.content}</pre>
          </div>
          <div className="routeProxyUsageBlock">
            <div className="routeProxyUsageBlockHeader">
              <span>流式调用示例</span>
              <button className="secondaryButton" type="button" onClick={copyStreamingExample}>
                <Clipboard size={15} />
                复制示例
              </button>
            </div>
            <pre className="routeProxyCode routeProxyCodeCompact">{streamingExample}</pre>
          </div>
        </section>
      </div>
    </div>
  );
}
