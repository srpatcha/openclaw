import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  resolveProviderBuiltInModelSuppression,
  resolveProviderBuiltInModelSuppressionPlugins,
} from "../plugins/provider-runtime.js";
import {
  resolveDeclaredModelCatalogPluginIds,
  resolveDeclaredModelCatalogPluginIdsForProvider,
  resolveModelCatalogCompatFallbackPluginIds,
} from "../plugins/providers.js";
import type { ProviderBuiltInModelSuppressionContext, ProviderPlugin } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./provider-id.js";

export type BuiltInModelSuppressor = (params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
}) => boolean;

type SuppressionHintField = "runtimeSuppressionHints" | "staticSuppressions";

type SuppressionHintMaps = {
  staticSuppressions: Map<string, Set<string>>;
  runtimeHints: Map<string, Set<string>>;
  compatFallbackPluginIds: Set<string>;
  compatFallbackProviders: Set<string>;
};

function matchesProviderId(plugin: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(plugin.id) === normalized) {
    return true;
  }
  return [...(plugin.aliases ?? []), ...(plugin.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function addSuppressionHints(params: {
  hints: Map<string, Set<string>>;
  providerFilter: string;
  entries?: Record<string, string[]>;
}): void {
  for (const [provider, models] of Object.entries(params.entries ?? {})) {
    const providerId = normalizeProviderId(provider);
    if (!providerId || (params.providerFilter && providerId !== params.providerFilter)) {
      continue;
    }
    let providerHints = params.hints.get(providerId);
    if (!providerHints) {
      providerHints = new Set();
      params.hints.set(providerId, providerHints);
    }
    for (const model of models) {
      const modelId = normalizeLowercaseStringOrEmpty(model);
      if (modelId) {
        providerHints.add(modelId);
      }
    }
  }
}

function resolveDeclaredPluginIds(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerFilter?: string;
}): Set<string> {
  const providerFilter = params?.providerFilter ? normalizeProviderId(params.providerFilter) : "";
  return new Set(
    providerFilter
      ? resolveDeclaredModelCatalogPluginIdsForProvider({
          config: params?.config,
          workspaceDir: params?.workspaceDir,
          env: params?.env,
          provider: providerFilter,
        })
      : resolveDeclaredModelCatalogPluginIds({
          config: params?.config,
          workspaceDir: params?.workspaceDir,
          env: params?.env,
        }),
  );
}

function buildSuppressionHints(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerFilter?: string;
}): SuppressionHintMaps {
  const providerFilter = params?.providerFilter ? normalizeProviderId(params.providerFilter) : "";
  const declaredPluginIds = resolveDeclaredPluginIds(params);
  const compatFallbackPluginIds = new Set(
    resolveModelCatalogCompatFallbackPluginIds({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
      declaredPluginIds,
      ...(providerFilter ? { provider: providerFilter } : {}),
    }),
  );
  const maps: Record<SuppressionHintField, Map<string, Set<string>>> = {
    staticSuppressions: new Map(),
    runtimeSuppressionHints: new Map(),
  };
  const compatFallbackProviders = new Set<string>();
  if (declaredPluginIds.size === 0 && compatFallbackPluginIds.size === 0) {
    return {
      staticSuppressions: maps.staticSuppressions,
      runtimeHints: maps.runtimeSuppressionHints,
      compatFallbackPluginIds,
      compatFallbackProviders,
    };
  }
  const registry = loadPluginManifestRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });
  for (const plugin of registry.plugins) {
    if (compatFallbackPluginIds.has(plugin.id)) {
      for (const provider of plugin.providers) {
        const providerId = normalizeProviderId(provider);
        if (providerId) {
          compatFallbackProviders.add(providerId);
        }
      }
    }
    if (!declaredPluginIds.has(plugin.id)) {
      continue;
    }
    addSuppressionHints({
      hints: maps.staticSuppressions,
      providerFilter,
      entries: plugin.modelCatalog?.staticSuppressions,
    });
    addSuppressionHints({
      hints: maps.runtimeSuppressionHints,
      providerFilter,
      entries: plugin.modelCatalog?.runtimeSuppressionHints,
    });
  }
  return {
    staticSuppressions: maps.staticSuppressions,
    runtimeHints: maps.runtimeSuppressionHints,
    compatFallbackPluginIds,
    compatFallbackProviders,
  };
}

function matchesSuppressionHint(
  hints: Map<string, Set<string>>,
  model: { provider?: string | null; id?: string | null },
): boolean {
  const provider = normalizeProviderId(model.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(model.id);
  if (!provider || !modelId) {
    return false;
  }
  return hints.get(provider)?.has(modelId) ?? false;
}

function resolveBuiltInModelSuppression(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}) {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  return resolveProviderBuiltInModelSuppression({
    ...(params.config ? { config: params.config } : {}),
    env: process.env,
    context: {
      ...(params.config ? { config: params.config } : {}),
      env: process.env,
      provider,
      modelId,
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    },
  });
}

function toSuppressionContext(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ProviderBuiltInModelSuppressionContext | undefined {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  return {
    ...(params.config ? { config: params.config } : {}),
    env: params.env,
    provider,
    modelId,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
  };
}

export function shouldSuppressBuiltInModel(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}) {
  return resolveBuiltInModelSuppression(params)?.suppress ?? false;
}

export function createBuiltInModelSuppressor(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerFilter?: string;
}): BuiltInModelSuppressor {
  const env = params?.env ?? process.env;
  const { staticSuppressions, runtimeHints, compatFallbackPluginIds, compatFallbackProviders } =
    buildSuppressionHints({
      ...params,
      env,
    });
  if (
    staticSuppressions.size === 0 &&
    runtimeHints.size === 0 &&
    compatFallbackPluginIds.size === 0
  ) {
    return () => false;
  }
  let runtimePlugins: ProviderPlugin[] | undefined;
  let compatFallbackPlugins: ProviderPlugin[] | undefined;
  const loadRuntimePlugins = () =>
    (runtimePlugins ??= resolveProviderBuiltInModelSuppressionPlugins({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env,
      providerFilter: params?.providerFilter,
    }));
  const loadCompatFallbackPlugins = () =>
    (compatFallbackPlugins ??= loadRuntimePlugins().filter((plugin) =>
      compatFallbackPluginIds.has(plugin.pluginId ?? plugin.id),
    ));
  return (model) => {
    if (matchesSuppressionHint(staticSuppressions, model)) {
      return true;
    }
    const matchesRuntimeHint = matchesSuppressionHint(runtimeHints, model);
    const provider = normalizeProviderId(model.provider ?? "");
    const canUseCompatFallback =
      Boolean(provider) &&
      compatFallbackPluginIds.size > 0 &&
      compatFallbackProviders.has(provider);
    if (!matchesRuntimeHint && !canUseCompatFallback) {
      return false;
    }
    const plugins = matchesRuntimeHint ? loadRuntimePlugins() : loadCompatFallbackPlugins();
    if (plugins.length === 0) {
      return false;
    }
    const context = toSuppressionContext({
      ...model,
      config: params?.config,
      env,
    });
    if (!context) {
      return false;
    }
    for (const plugin of plugins) {
      if (!matchesProviderId(plugin, context.provider)) {
        continue;
      }
      if (plugin.suppressBuiltInModel?.(context)?.suppress) {
        return true;
      }
    }
    return false;
  };
}

export function buildSuppressedBuiltInModelError(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}): string | undefined {
  return resolveBuiltInModelSuppression(params)?.errorMessage;
}
