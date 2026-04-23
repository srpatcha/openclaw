import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadProviderCatalogModelsForList,
  resolveProviderCatalogPluginIdsForFilter,
} from "./list.provider-catalog.js";

const providerDiscoveryMocks = vi.hoisted(() => ({
  resolveProviderStaticCatalogPluginIds: vi.fn(),
  resolveProviderStaticCatalogPluginIdsForProvider: vi.fn(),
  resolvePluginDiscoveryProviders: vi.fn(),
}));

vi.mock("../../plugins/providers.js", () => ({
  resolveProviderStaticCatalogPluginIds:
    providerDiscoveryMocks.resolveProviderStaticCatalogPluginIds,
  resolveProviderStaticCatalogPluginIdsForProvider:
    providerDiscoveryMocks.resolveProviderStaticCatalogPluginIdsForProvider,
}));

vi.mock("../../plugins/provider-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/provider-discovery.js")>();
  return {
    ...actual,
    resolvePluginDiscoveryProviders: providerDiscoveryMocks.resolvePluginDiscoveryProviders,
  };
});

const baseParams = {
  cfg: {
    plugins: {
      entries: {
        chutes: { enabled: true },
        moonshot: { enabled: true },
      },
    },
  },
  agentDir: "/tmp/openclaw-provider-catalog-test",
  env: {
    ...process.env,
    CHUTES_API_KEY: "",
    MOONSHOT_API_KEY: "",
  },
};

const chutesProvider = {
  id: "chutes",
  pluginId: "chutes",
  label: "Chutes",
  auth: [],
  staticCatalog: {
    run: async () => ({
      provider: { baseUrl: "https://chutes.example/v1", models: [] },
    }),
  },
};

const moonshotProvider = {
  id: "moonshot",
  pluginId: "moonshot",
  label: "Moonshot",
  auth: [],
  staticCatalog: {
    run: async () => ({
      provider: {
        baseUrl: "https://api.moonshot.ai/v1",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    }),
  },
};

const openaiProvider = {
  id: "openai",
  pluginId: "openai",
  label: "OpenAI",
  aliases: ["azure-openai-responses"],
  auth: [],
  staticCatalog: {
    run: async () => ({
      provider: { baseUrl: "https://api.openai.com/v1", models: [] },
    }),
  },
};

const defaultProviders = [chutesProvider, moonshotProvider, openaiProvider];

describe("loadProviderCatalogModelsForList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerDiscoveryMocks.resolveProviderStaticCatalogPluginIds.mockReturnValue([
      "moonshot",
      "openai",
    ]);
    providerDiscoveryMocks.resolveProviderStaticCatalogPluginIdsForProvider.mockImplementation(
      ({ provider }: { provider: string }) =>
        provider === "azure-openai-responses"
          ? ["openai"]
          : defaultProviders.some((entry) => entry.id === provider)
            ? [provider]
            : undefined,
    );
    providerDiscoveryMocks.resolvePluginDiscoveryProviders.mockImplementation(
      async ({ onlyPluginIds }: { onlyPluginIds?: string[] }) =>
        defaultProviders.filter((provider) => onlyPluginIds?.includes(provider.pluginId)),
    );
  });

  it("does not use live provider discovery for display-only rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    await loadProviderCatalogModelsForList({
      ...baseParams,
      providerFilter: "chutes",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes unauthenticated Moonshot static catalog rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    const rows = await loadProviderCatalogModelsForList({
      ...baseParams,
      providerFilter: "moonshot",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.map((row) => `${row.provider}/${row.id}`)).toEqual(
      expect.arrayContaining(["moonshot/kimi-k2.6"]),
    );
  });

  it("recognizes static catalog aliases before the unknown-provider short-circuit", async () => {
    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "azure-openai-responses",
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("scopes unfiltered static catalogs to declared static catalog providers", async () => {
    const rows = await loadProviderCatalogModelsForList({
      ...baseParams,
    });

    expect(providerDiscoveryMocks.resolvePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["moonshot", "openai"],
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(rows.map((row) => `${row.provider}/${row.id}`)).toEqual(["moonshot/kimi-k2.6"]);
  });

  it("keeps unknown provider filters eligible for early empty results", async () => {
    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "unknown-provider-for-catalog-test",
      }),
    ).resolves.toBeUndefined();
  });
});
