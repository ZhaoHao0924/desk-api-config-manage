import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProviders } from "./data/sampleData";
import {
  configMatchesProviderFilter,
  createConfigTemplateExport,
  createConnectionTestBatchPlan,
  createEnvSnippet,
  createFetchedProviderModels,
  createProviderFilterItems,
  createProviderSelectOptions,
  createRouteProxyProfileFromTemplate,
  formatBatchConnectionTestSummary,
  getBaseUrlAfterProviderChange,
  getDefaultModelAfterFetch,
  getEnabledConnectionTestTargets,
  getFetchedModelSelectValue,
  getLatestProviderModelFetchedAt,
  formatLocalDateTime,
  getProviderDisplayName,
  getProviderFilterLabel,
  getProviderSelectValue,
  isConfigDatabaseStorageEvent,
  openAiCompatibleProviderFilterId,
  pickCreateProvider,
  readRouteProxyProfileTemplates,
  runConnectionTestBatchPlan,
  shouldShowEndpointMode,
  writeClipboardText
} from "./App";

describe("App state helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the active provider filter when creating a config", () => {
    expect(pickCreateProvider(defaultProviders, "gemini").id).toBe(openAiCompatibleProviderFilterId);
  });

  it("falls back to built-in providers when loaded providers are empty", () => {
    expect(pickCreateProvider([], "all").id).toBe(defaultProviders[0].id);
    expect(pickCreateProvider([], "antigravity").id).toBe(openAiCompatibleProviderFilterId);
  });

  it("uses the first OpenAI-compatible provider when creating from the aggregate filter", () => {
    expect(pickCreateProvider(defaultProviders, openAiCompatibleProviderFilterId).id).toBe(
      openAiCompatibleProviderFilterId
    );
  });

  it("uses one built-in OpenAI-compatible provider id", () => {
    expect(defaultProviders.map((provider) => provider.id)).toEqual(["anthropic", openAiCompatibleProviderFilterId]);
    expect(defaultProviders.find((provider) => provider.id === openAiCompatibleProviderFilterId)?.type).toBe("openai");
    expect(defaultProviders.some((provider) => provider.id === "openai")).toBe(false);
    expect(defaultProviders.some((provider) => provider.id === "gemini")).toBe(false);
    expect(defaultProviders.some((provider) => provider.id === "grok")).toBe(false);
  });

  it("updates the Base URL when switching away from the previous provider default", () => {
    const anthropicProvider = defaultProviders.find((provider) => provider.id === "anthropic")!;
    const openAiProvider = defaultProviders.find((provider) => provider.id === openAiCompatibleProviderFilterId)!;

    expect(
      getBaseUrlAfterProviderChange("https://api.anthropic.com/v1", anthropicProvider, openAiProvider)
    ).toBe("https://api.openai.com/v1");
  });

  it("preserves a custom Base URL when switching providers", () => {
    const anthropicProvider = defaultProviders.find((provider) => provider.id === "anthropic")!;
    const openAiProvider = defaultProviders.find((provider) => provider.id === openAiCompatibleProviderFilterId)!;

    expect(
      getBaseUrlAfterProviderChange("https://gateway.example.com/anthropic", anthropicProvider, openAiProvider)
    ).toBe("https://gateway.example.com/anthropic");
  });

  it("shows endpoint mode only for OpenAI-compatible providers", () => {
    expect(shouldShowEndpointMode(defaultProviders.find((provider) => provider.id === openAiCompatibleProviderFilterId))).toBe(
      true
    );
    expect(shouldShowEndpointMode(defaultProviders.find((provider) => provider.id === "anthropic"))).toBe(false);
    expect(shouldShowEndpointMode(undefined)).toBe(false);
  });

  it("aggregates OpenAI-compatible providers into one sidebar filter", () => {
    const configs = [
      {
        id: "cfg-anthropic",
        name: "Anthropic",
        providerId: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyPreview: "missing",
        hasApiKey: false,
        defaultModel: "claude-sonnet-4-5",
        endpointMode: "auto" as const,
        environment: "development" as const,
        tags: [],
        notes: "",
        isEnabled: true,
        lastTestStatus: "untested" as const,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      {
        id: "cfg-openai",
        name: "OpenAI",
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyPreview: "missing",
        hasApiKey: false,
        defaultModel: "gpt-4.1-mini",
        endpointMode: "auto" as const,
        environment: "development" as const,
        tags: [],
        notes: "",
        isEnabled: true,
        lastTestStatus: "untested" as const,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      {
        id: "cfg-gemini",
        name: "Gemini",
        providerId: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKeyPreview: "missing",
        hasApiKey: false,
        defaultModel: "gemini-2.5-flash",
        endpointMode: "auto" as const,
        environment: "development" as const,
        tags: [],
        notes: "",
        isEnabled: true,
        lastTestStatus: "untested" as const,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      {
        id: "cfg-grok",
        name: "Grok",
        providerId: "grok",
        baseUrl: "https://api.x.ai/v1",
        apiKeyPreview: "missing",
        hasApiKey: false,
        defaultModel: "grok-4",
        endpointMode: "auto" as const,
        environment: "development" as const,
        tags: [],
        notes: "",
        isEnabled: true,
        lastTestStatus: "untested" as const,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      }
    ];

    const filterItems = createProviderFilterItems(configs, defaultProviders);

    expect(filterItems).toEqual([
      { id: "anthropic", label: "Anthropic", count: 1 },
      { id: openAiCompatibleProviderFilterId, label: "OpenAI-compatible", count: 3 }
    ]);
    expect(filterItems.map((item) => item.id)).not.toContain("gemini");
    expect(filterItems.map((item) => item.id)).not.toContain("antigravity");
    expect(filterItems.map((item) => item.id)).not.toContain("grok");
    expect(getProviderFilterLabel(openAiCompatibleProviderFilterId, defaultProviders)).toBe("OpenAI-compatible");
    expect(configMatchesProviderFilter(configs[2], openAiCompatibleProviderFilterId, defaultProviders)).toBe(true);
    expect(configMatchesProviderFilter(configs[0], openAiCompatibleProviderFilterId, defaultProviders)).toBe(false);
  });

  it("aggregates OpenAI-compatible providers in create and edit provider selects", () => {
    const selectOptions = createProviderSelectOptions(defaultProviders);

    expect(selectOptions).toEqual([
      { value: "anthropic", label: "Anthropic" },
      { value: openAiCompatibleProviderFilterId, label: "OpenAI-compatible" }
    ]);
    expect(selectOptions.map((option) => option.label)).not.toContain("Gemini");
    expect(selectOptions.map((option) => option.label)).not.toContain("Antigravity");
    expect(selectOptions.map((option) => option.label)).not.toContain("Grok");
    expect(getProviderSelectValue("gemini", defaultProviders)).toBe(openAiCompatibleProviderFilterId);
    expect(getProviderSelectValue("grok", defaultProviders)).toBe(openAiCompatibleProviderFilterId);
    expect(getProviderSelectValue("anthropic", defaultProviders)).toBe("anthropic");
  });

  it("displays OpenAI-compatible as the provider type label for OpenAI-compatible configs", () => {
    expect(getProviderDisplayName(openAiCompatibleProviderFilterId, defaultProviders)).toBe("OpenAI-compatible");
    expect(getProviderDisplayName("openai", defaultProviders)).toBe("OpenAI-compatible");
    expect(getProviderDisplayName("gemini", defaultProviders)).toBe("OpenAI-compatible");
    expect(getProviderDisplayName("grok", defaultProviders)).toBe("OpenAI-compatible");
    expect(getProviderDisplayName("anthropic", defaultProviders)).toBe("Anthropic");
  });

  it("selects the fetched model that matches the manual input", () => {
    expect(getFetchedModelSelectValue(["gpt-4.1", "gpt-4.1-mini"], "gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(getFetchedModelSelectValue(["gpt-4.1", "gpt-4.1-mini"], "custom-model")).toBe("");
  });

  it("fills the first fetched model only when the default model input is empty", () => {
    expect(getDefaultModelAfterFetch("", ["gpt-4.1", "gpt-4.1-mini"])).toBe("gpt-4.1");
    expect(getDefaultModelAfterFetch("   ", ["gpt-4.1", "gpt-4.1-mini"])).toBe("gpt-4.1");
    expect(getDefaultModelAfterFetch("custom-model", ["gpt-4.1", "gpt-4.1-mini"])).toBe("custom-model");
    expect(getDefaultModelAfterFetch("", [])).toBe("");
  });

  it("maps fetched provider model ids into catalog models", () => {
    const fetchedAt = "2026-07-05T03:30:00.000Z";
    const models = createFetchedProviderModels(
      defaultProviders[1],
      [" gpt-4.1-mini ", "GPT-4.1-MINI", "", "z-ai/glm-5.2"],
      fetchedAt
    );
    const [model, secondModel] = models;

    expect(models).toHaveLength(2);
    expect(model).toMatchObject({
      id: "live-openai-compatible-gpt-4-1-mini",
      providerId: openAiCompatibleProviderFilterId,
      modelId: "gpt-4.1-mini",
      displayName: "gpt-4.1-mini",
      capabilities: ["chat"],
      fetchedAt,
      status: "available"
    });
    expect(secondModel).toMatchObject({
      id: "live-openai-compatible-z-ai-glm-5-2",
      providerId: openAiCompatibleProviderFilterId,
      modelId: "z-ai/glm-5.2",
      displayName: "z-ai/glm-5.2"
    });
  });

  it("finds the latest fetched provider model timestamp", () => {
    expect(
      getLatestProviderModelFetchedAt([
        { ...createFetchedProviderModels(defaultProviders[1], ["a"], "2026-07-05T02:00:00.000Z")[0] },
        { ...createFetchedProviderModels(defaultProviders[1], ["b"], "2026-07-05T04:00:00.000Z")[0] },
        { ...createFetchedProviderModels(defaultProviders[1], ["c"])[0], fetchedAt: undefined }
      ])
    ).toBe("2026-07-05T04:00:00.000Z");
  });

  it("formats ISO timestamps with the local timezone for display", () => {
    const value = "2026-07-05T00:00:00.000Z";

    expect(formatLocalDateTime(value)).toBe(
      new Date(value).toLocaleString("zh-CN", {
        hour12: false
      })
    );
    expect(formatLocalDateTime(value)).not.toBe(value);
    expect(formatLocalDateTime("")).toBe("");
  });

  it("selects only enabled configs for batch connection testing", () => {
    const enabledConfig = {
      id: "cfg-enabled",
      name: "Enabled",
      providerId: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKeyPreview: "missing",
      hasApiKey: false,
      defaultModel: "gpt-4.1-mini",
      endpointMode: "auto" as const,
      environment: "development" as const,
      tags: [],
      notes: "",
      isEnabled: true,
      lastTestStatus: "untested" as const,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const disabledConfig = {
      ...enabledConfig,
      id: "cfg-disabled",
      isEnabled: false
    };

    expect(getEnabledConnectionTestTargets([disabledConfig, enabledConfig])).toEqual([enabledConfig]);
  });

  it("plans batch connection tests for enabled configs with known providers", () => {
    const enabledConfig = {
      id: "cfg-enabled",
      name: "Enabled",
      providerId: openAiCompatibleProviderFilterId,
      baseUrl: "https://api.example.com/v1",
      apiKeyPreview: "missing",
      hasApiKey: false,
      defaultModel: "gpt-4.1-mini",
      endpointMode: "auto" as const,
      environment: "development" as const,
      tags: [],
      notes: "",
      isEnabled: true,
      lastTestStatus: "untested" as const,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const disabledConfig = {
      ...enabledConfig,
      id: "cfg-disabled",
      isEnabled: false
    };
    const missingProviderConfig = {
      ...enabledConfig,
      id: "cfg-missing-provider",
      providerId: "missing-provider"
    };

    const plan = createConnectionTestBatchPlan([disabledConfig, missingProviderConfig, enabledConfig], defaultProviders);

    expect(plan.targets.map((target) => target.config.id)).toEqual(["cfg-enabled"]);
    expect(plan.targets.map((target) => target.provider.id)).toEqual([openAiCompatibleProviderFilterId]);
    expect(plan.skippedCount).toBe(1);
  });

  it("stops batch connection test execution before the next target starts", async () => {
    const firstConfig = {
      id: "cfg-first",
      name: "First",
      providerId: openAiCompatibleProviderFilterId,
      baseUrl: "https://api.example.com/v1",
      apiKeyPreview: "missing",
      hasApiKey: false,
      defaultModel: "gpt-4.1-mini",
      endpointMode: "auto" as const,
      environment: "development" as const,
      tags: [],
      notes: "",
      isEnabled: true,
      lastTestStatus: "untested" as const,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const secondConfig = {
      ...firstConfig,
      id: "cfg-second",
      name: "Second"
    };
    const plan = createConnectionTestBatchPlan([firstConfig, secondConfig], defaultProviders);
    const startedConfigIds: string[] = [];
    let isCanceled = false;

    const result = await runConnectionTestBatchPlan(plan, {
      isCanceled: () => isCanceled,
      onTargetStart: ({ config }) => {
        startedConfigIds.push(config.id);
      },
      runTarget: async () => {
        isCanceled = true;
        return "success";
      }
    });

    expect(startedConfigIds).toEqual(["cfg-first"]);
    expect(result).toEqual({
      failedCount: 0,
      isCanceled: true,
      skippedCount: 0,
      successCount: 1,
      totalCount: 2
    });
  });

  it("does not run a batch target when cancellation is requested during target start", async () => {
    const config = {
      id: "cfg-cancel-during-start",
      name: "Cancel During Start",
      providerId: openAiCompatibleProviderFilterId,
      baseUrl: "https://api.example.com/v1",
      apiKeyPreview: "missing",
      hasApiKey: false,
      defaultModel: "gpt-4.1-mini",
      endpointMode: "auto" as const,
      environment: "development" as const,
      tags: [],
      notes: "",
      isEnabled: true,
      lastTestStatus: "untested" as const,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const plan = createConnectionTestBatchPlan([config], defaultProviders);
    const runTarget = vi.fn(async () => "success" as const);
    let isCanceled = false;

    const result = await runConnectionTestBatchPlan(plan, {
      isCanceled: () => isCanceled,
      onTargetStart: () => {
        isCanceled = true;
      },
      runTarget
    });

    expect(runTarget).not.toHaveBeenCalled();
    expect(result).toEqual({
      failedCount: 0,
      isCanceled: true,
      skippedCount: 0,
      successCount: 0,
      totalCount: 1
    });
  });

  it("continues batch connection test execution after one target fails", async () => {
    const firstConfig = {
      id: "cfg-first",
      name: "First",
      providerId: openAiCompatibleProviderFilterId,
      baseUrl: "https://api.example.com/v1",
      apiKeyPreview: "missing",
      hasApiKey: false,
      defaultModel: "gpt-4.1-mini",
      endpointMode: "auto" as const,
      environment: "development" as const,
      tags: [],
      notes: "",
      isEnabled: true,
      lastTestStatus: "untested" as const,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const secondConfig = {
      ...firstConfig,
      id: "cfg-second",
      name: "Second"
    };
    const plan = createConnectionTestBatchPlan([firstConfig, secondConfig], defaultProviders);
    const startedConfigIds: string[] = [];
    const completedConfigIds: string[] = [];

    const result = await runConnectionTestBatchPlan(plan, {
      isCanceled: () => false,
      onTargetComplete: ({ config }) => {
        completedConfigIds.push(config.id);
      },
      onTargetStart: ({ config }) => {
        startedConfigIds.push(config.id);
      },
      runTarget: async ({ config }) => {
        if (config.id === "cfg-first") {
          throw new Error("failed target");
        }

        return "success";
      }
    });

    expect(startedConfigIds).toEqual(["cfg-first", "cfg-second"]);
    expect(completedConfigIds).toEqual(["cfg-first", "cfg-second"]);
    expect(result).toEqual({
      failedCount: 1,
      isCanceled: false,
      skippedCount: 0,
      successCount: 1,
      totalCount: 2
    });
  });

  it("formats batch connection test summaries", () => {
    expect(
      formatBatchConnectionTestSummary({
        failedCount: 1,
        isCanceled: false,
        successCount: 2,
        totalCount: 3
      })
    ).toBe("批量测试完成：成功 2，失败 1");

    expect(
      formatBatchConnectionTestSummary({
        failedCount: 1,
        isCanceled: true,
        successCount: 1,
        totalCount: 4
      })
    ).toBe("已停止：完成 2/4，成功 1，失败 1");

    expect(
      formatBatchConnectionTestSummary({
        failedCount: 1,
        isCanceled: false,
        skippedCount: 2,
        successCount: 2,
        totalCount: 5
      })
    ).toBe("批量测试完成：成功 2，失败 1，跳过 2");

    expect(
      formatBatchConnectionTestSummary({
        failedCount: 1,
        isCanceled: true,
        skippedCount: 1,
        successCount: 1,
        totalCount: 4
      })
    ).toBe("已停止：完成 3/4，成功 1，失败 1，跳过 1");
  });

  it("recognizes storage events for the local config database only", () => {
    expect(isConfigDatabaseStorageEvent("desk-api-config-manager.database.v1")).toBe(true);
    expect(isConfigDatabaseStorageEvent("other-key")).toBe(false);
    expect(isConfigDatabaseStorageEvent(null)).toBe(false);
  });

  it("exports configuration templates without secret fields", () => {
    const snapshot = createConfigTemplateExport(
      [
        {
          id: "cfg-secret",
          name: "Secret Config",
          providerId: "openai",
          baseUrl: "https://api.example.com/v1",
          encryptedApiKey: "encrypted-secret",
          apiKeyPreview: "sk-test...1234",
          hasApiKey: true,
          defaultModel: "gpt-4.1-mini",
          endpointMode: "responses",
          environment: "development",
          tags: ["dev"],
          notes: "note",
          isEnabled: true,
          lastTestStatus: "success",
          lastTestAt: "2026-07-04T00:00:00.000Z",
          latencyMs: 42,
          createdAt: "2026-07-04T00:00:00.000Z",
          updatedAt: "2026-07-04T00:00:00.000Z"
        }
      ],
      "2026-07-04T00:00:00.000Z",
      [
        {
          configId: "cfg-secret",
          cooldownMs: 45_000,
          createdAt: "2026-07-04T00:00:00.000Z",
          failoverConfigIds: ["cfg-missing"],
          failureThreshold: 2,
          id: "profile-secret",
          listenAddress: "127.0.0.1",
          listenPort: 15_900,
          name: "Local profile",
          routingMode: "weighted",
          targetWeights: {
            "cfg-secret": 2
          },
          updatedAt: "2026-07-04T00:00:00.000Z"
        }
      ]
    );
    const rawSnapshot = JSON.stringify(snapshot);

    expect(snapshot.configs[0]).toEqual({
      sourceId: "cfg-secret",
      name: "Secret Config",
      providerId: openAiCompatibleProviderFilterId,
      baseUrl: "https://api.example.com/v1",
      defaultModel: "gpt-4.1-mini",
      endpointMode: "responses",
      environment: "development",
      tags: ["dev"],
      notes: "note",
      isEnabled: true
    });
    expect(snapshot.routeProxyProfiles).toEqual([
      {
        name: "Local profile",
        configTemplateId: "cfg-secret",
        failoverConfigTemplateIds: [],
        listenAddress: "127.0.0.1",
        listenPort: 15_900,
        failureThreshold: 2,
        cooldownMs: 45_000,
        routingMode: "weighted",
        targetWeights: {
          "cfg-secret": 2
        }
      }
    ]);
    expect(rawSnapshot).not.toContain("encrypted-secret");
    expect(rawSnapshot).not.toContain("sk-test");
    expect(rawSnapshot).not.toContain("apiKeyPreview");
    expect(rawSnapshot).not.toContain("profile-secret");
  });

  it("reads route proxy profile templates only from exported snapshots", () => {
    const profileTemplates = [{ name: "Local profile" }];

    expect(readRouteProxyProfileTemplates({ routeProxyProfiles: profileTemplates })).toEqual(profileTemplates);
    expect(readRouteProxyProfileTemplates([{ routeProxyProfiles: profileTemplates }])).toEqual([]);
    expect(readRouteProxyProfileTemplates({ routeProxyProfiles: "invalid" })).toEqual([]);
    expect(readRouteProxyProfileTemplates({})).toEqual([]);
  });

  it("creates route proxy profiles from imported template references", () => {
    const createdAt = "2026-07-05T08:00:00.000Z";
    const profile = createRouteProxyProfileFromTemplate(
      {
        name: "Imported proxy",
        configTemplateId: "source-primary",
        failoverConfigTemplateIds: ["source-backup", "missing", "source-primary", "source-backup"],
        listenAddress: "127.0.0.1",
        listenPort: 15_999,
        failureThreshold: 3,
        cooldownMs: 45_000,
        routingMode: "weighted",
        targetWeights: {
          "source-backup": 4,
          "source-primary": 2
        }
      },
      (configTemplateId) =>
        (
          {
            "source-primary": "cfg-primary",
            "source-backup": "cfg-backup"
          } satisfies Record<string, string>
        )[configTemplateId] ?? "",
      createdAt
    );

    expect(profile).toMatchObject({
      configId: "cfg-primary",
      cooldownMs: 45_000,
      createdAt,
      failoverConfigIds: ["cfg-backup"],
      failureThreshold: 3,
      listenAddress: "127.0.0.1",
      listenPort: 15_999,
      name: "Imported proxy",
      routingMode: "weighted",
      targetWeights: {
        "cfg-backup": 4,
        "cfg-primary": 2
      },
      updatedAt: createdAt
    });
    expect(profile?.id).toMatch(/^route-proxy-\d+-[a-z0-9]+$/);
  });

  it("supports legacy route proxy profile config id fields during import", () => {
    const profile = createRouteProxyProfileFromTemplate(
      {
        configId: "existing-primary",
        failoverConfigIds: ["existing-backup"]
      },
      (configTemplateId) =>
        (
          {
            "existing-primary": "existing-primary",
            "existing-backup": "existing-backup"
          } satisfies Record<string, string>
        )[configTemplateId] ?? "",
      "2026-07-05T08:00:00.000Z"
    );

    expect(profile).toMatchObject({
      configId: "existing-primary",
      failoverConfigIds: ["existing-backup"],
      name: "导入的代理方案",
      routingMode: "ordered",
      targetWeights: {}
    });
  });

  it("skips route proxy profile templates without a resolvable primary target", () => {
    expect(
      createRouteProxyProfileFromTemplate(
        {
          name: "Invalid proxy",
          configTemplateId: "missing"
        },
        () => "",
        "2026-07-05T08:00:00.000Z"
      )
    ).toBeUndefined();
  });

  it("creates masked env snippets for selected configs", () => {
    const snippet = createEnvSnippet({
      id: "cfg-env",
      name: "Env Config",
      providerId: openAiCompatibleProviderFilterId,
      baseUrl: "https://api.example.com/v1",
      encryptedApiKey: "encrypted-secret",
      apiKeyPreview: "sk-test...1234",
      hasApiKey: true,
      defaultModel: "gpt-4.1-mini",
      endpointMode: "auto",
      environment: "development",
      tags: [],
      notes: "",
      isEnabled: true,
      lastTestStatus: "untested",
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    });

    expect(snippet).toBe(
      "LLM_API_KEY=sk-test...1234\nLLM_BASE_URL=https://api.example.com/v1\nLLM_MODEL=gpt-4.1-mini"
    );
    expect(snippet).not.toContain("encrypted-secret");
  });

  it("uses the desktop clipboard bridge when available", async () => {
    const desktopWriteText = vi.fn(async () => ({ ok: true }));
    const browserWriteText = vi.fn(async () => undefined);

    vi.stubGlobal("window", {
      deskApi: {
        clipboard: {
          writeText: desktopWriteText
        }
      }
    });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: browserWriteText
      }
    });

    await writeClipboardText("snippet");

    expect(desktopWriteText).toHaveBeenCalledWith("snippet");
    expect(browserWriteText).not.toHaveBeenCalled();
  });

  it("falls back to the browser clipboard when the desktop bridge is unavailable", async () => {
    const browserWriteText = vi.fn(async () => undefined);

    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: browserWriteText
      }
    });

    await writeClipboardText("snippet");

    expect(browserWriteText).toHaveBeenCalledWith("snippet");
  });

  it("falls back to the browser clipboard when the desktop bridge rejects", async () => {
    const desktopWriteText = vi.fn(async () => {
      throw new Error("Missing IPC handler");
    });
    const browserWriteText = vi.fn(async () => undefined);

    vi.stubGlobal("window", {
      deskApi: {
        clipboard: {
          writeText: desktopWriteText
        }
      }
    });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: browserWriteText
      }
    });

    await writeClipboardText("snippet");

    expect(desktopWriteText).toHaveBeenCalledWith("snippet");
    expect(browserWriteText).toHaveBeenCalledWith("snippet");
  });

  it("uses the legacy desktop clipboard bridge when browser copy is blocked", async () => {
    const desktopWriteText = vi.fn(async () => {
      throw new Error("Missing IPC handler");
    });
    const browserWriteText = vi.fn(async () => {
      throw new Error("Document is not focused");
    });
    const legacyCopyToClipboard = vi.fn(async () => ({ clearAfterMs: 300_000 }));

    vi.stubGlobal("window", {
      deskApi: {
        secrets: {
          copyToClipboard: legacyCopyToClipboard
        },
        clipboard: {
          writeText: desktopWriteText
        }
      }
    });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: browserWriteText
      }
    });

    await writeClipboardText("snippet");

    expect(desktopWriteText).toHaveBeenCalledWith("snippet");
    expect(browserWriteText).toHaveBeenCalledWith("snippet");
    expect(legacyCopyToClipboard).toHaveBeenCalledWith("snippet", {
      clearAfterMs: 300_000
    });
  });
});
