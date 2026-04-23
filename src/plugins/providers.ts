import { normalizeProviderId } from "../agents/provider-id.js";
import { withBundledPluginVitestCompat } from "./bundled-compat.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { resolveProviderContractPluginIdsForProviderAlias } from "./contracts/registry.js";
import type { PluginLoadOptions } from "./loader.js";
import {
  isActivatedManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
import {
  loadPluginManifestRegistry,
  resolveManifestContractPluginIds,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";

type ProviderManifestLoadParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
};
type NormalizedPluginsConfig = ReturnType<typeof normalizePluginsConfig>;

function loadProviderManifestRegistry(params: ProviderManifestLoadParams): PluginManifestRegistry {
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

function loadScopedProviderManifestRegistry(
  params: ProviderManifestLoadParams & { onlyPluginIds?: readonly string[] },
): {
  registry: PluginManifestRegistry;
  onlyPluginIdSet: ReturnType<typeof createPluginIdScopeSet>;
} {
  return {
    registry: loadProviderManifestRegistry(params),
    onlyPluginIdSet: createPluginIdScopeSet(params.onlyPluginIds),
  };
}

function listManifestPluginIds(
  registry: PluginManifestRegistry,
  predicate: (plugin: PluginManifestRecord) => boolean,
): string[] {
  return registry.plugins
    .filter(predicate)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveProviderOwnerPluginIds(
  params: ProviderManifestLoadParams & {
    pluginIds: readonly string[];
    isEligible: (
      plugin: PluginManifestRecord,
      normalizedConfig: NormalizedPluginsConfig,
    ) => boolean;
  },
): string[] {
  if (params.pluginIds.length === 0) {
    return [];
  }
  const pluginIdSet = new Set(params.pluginIds);
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) => pluginIdSet.has(plugin.id) && params.isEligible(plugin, normalizedConfig),
  );
}

export function withBundledProviderVitestCompat(params: {
  config: PluginLoadOptions["config"];
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
}): PluginLoadOptions["config"] {
  return withBundledPluginVitestCompat(params);
}

export function resolveBundledProviderCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
}): string[] {
  const { registry, onlyPluginIdSet } = loadScopedProviderManifestRegistry(params);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      plugin.origin === "bundled" &&
      plugin.providers.length > 0 &&
      (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)),
  );
}

export function resolveEnabledProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
}): string[] {
  const { registry, onlyPluginIdSet } = loadScopedProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      plugin.providers.length > 0 &&
      (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
      resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
      }).activated,
  );
}

export function resolveExternalAuthProfileProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveManifestContractPluginIds({
    contract: "externalAuthProviders",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

/**
 * @deprecated Compatibility path for third-party provider plugins that predate
 * `contracts.externalAuthProviders`. Keep bundled plugins off this path and
 * remove it with the runtime warning after the external plugin migration window.
 */
export function resolveExternalAuthProfileCompatFallbackPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  declaredPluginIds?: ReadonlySet<string>;
}): string[] {
  // Deprecated compatibility fallback for provider plugins that still implement
  // resolveExternalOAuthProfiles or omit contracts.externalAuthProviders. Remove
  // this with the warning path in provider-runtime after the migration window.
  const declaredPluginIds =
    params.declaredPluginIds ?? new Set(resolveExternalAuthProfileProviderPluginIds(params));
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      plugin.origin !== "bundled" &&
      plugin.providers.length > 0 &&
      !declaredPluginIds.has(plugin.id) &&
      isProviderPluginEligibleForRuntimeOwnerActivation({
        plugin,
        normalizedConfig,
        rootConfig: params.config,
      }),
  );
}

function pluginDeclaresModelCatalogProvider(
  plugin: PluginManifestRecord,
  provider: string,
): boolean {
  const normalized = normalizeProviderId(provider);
  if (!normalized) {
    return false;
  }
  return (plugin.modelCatalog?.providers ?? []).some(
    (candidate) => normalizeProviderId(candidate) === normalized,
  );
}

function pluginDeclaresAnyModelCatalogProvider(plugin: PluginManifestRecord): boolean {
  return (plugin.modelCatalog?.providers?.length ?? 0) > 0;
}

function isBundledOrActivatedPlugin(
  plugin: PluginManifestRecord,
  normalizedConfig: NormalizedPluginsConfig,
  rootConfig?: PluginLoadOptions["config"],
): boolean {
  if (plugin.origin === "bundled") {
    return true;
  }
  return resolveEffectivePluginActivationState({
    id: plugin.id,
    origin: plugin.origin,
    config: normalizedConfig,
    rootConfig,
    enabledByDefault: plugin.enabledByDefault,
  }).activated;
}

function isActivatedPlugin(
  plugin: PluginManifestRecord,
  normalizedConfig: NormalizedPluginsConfig,
  rootConfig?: PluginLoadOptions["config"],
): boolean {
  return resolveEffectivePluginActivationState({
    id: plugin.id,
    origin: plugin.origin,
    config: normalizedConfig,
    rootConfig,
    enabledByDefault: plugin.enabledByDefault,
  }).activated;
}

function isModelCatalogManifestEligible(
  plugin: PluginManifestRecord,
  normalizedConfig: NormalizedPluginsConfig,
  rootConfig?: PluginLoadOptions["config"],
): boolean {
  return isBundledOrActivatedPlugin(plugin, normalizedConfig, rootConfig);
}

export function resolveDeclaredModelCatalogPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      (plugin.modelCatalog?.providers?.length ?? 0) > 0 &&
      isModelCatalogManifestEligible(plugin, normalizedConfig, params.config),
  );
}

export function resolveDeclaredModelCatalogPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return [];
  }
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      pluginDeclaresModelCatalogProvider(plugin, provider) &&
      isModelCatalogManifestEligible(plugin, normalizedConfig, params.config),
  );
}

export function resolveProviderDiscoveryEntryPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return [];
  }
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      Boolean(plugin.providerDiscoverySource) &&
      plugin.providers.some((candidate) => normalizeProviderId(candidate) === provider) &&
      pluginDeclaresModelCatalogProvider(plugin, provider) &&
      isBundledOrActivatedPlugin(plugin, normalizedConfig, params.config),
  );
}

export function resolveProviderDiscoveryEntryPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      Boolean(plugin.providerDiscoverySource) &&
      plugin.providers.length > 0 &&
      pluginDeclaresAnyModelCatalogProvider(plugin) &&
      isActivatedPlugin(plugin, normalizedConfig, params.config),
  );
}

export function resolveDiscoveredProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  const { registry, onlyPluginIdSet } = loadScopedProviderManifestRegistry(params);
  const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(registry, (plugin) => {
    if (!(plugin.providers.length > 0 && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)))) {
      return false;
    }
    return isProviderPluginEligibleForSetupDiscovery({
      plugin,
      shouldFilterUntrustedWorkspacePlugins,
      normalizedConfig,
      rootConfig: params.config,
    });
  });
}

function isProviderPluginEligibleForSetupDiscovery(params: {
  plugin: PluginManifestRecord;
  shouldFilterUntrustedWorkspacePlugins: boolean;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: PluginLoadOptions["config"];
}): boolean {
  if (!params.shouldFilterUntrustedWorkspacePlugins || params.plugin.origin !== "workspace") {
    return true;
  }
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

export function resolveDiscoverableProviderOwnerPluginIds(params: {
  pluginIds: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
  return resolveProviderOwnerPluginIds({
    ...params,
    isEligible: (plugin, normalizedConfig) =>
      isProviderPluginEligibleForSetupDiscovery({
        plugin,
        shouldFilterUntrustedWorkspacePlugins,
        normalizedConfig,
        rootConfig: params.config,
      }),
  });
}

function isProviderPluginEligibleForRuntimeOwnerActivation(params: {
  plugin: PluginManifestRecord;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: PluginLoadOptions["config"];
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (params.plugin.origin !== "workspace") {
    return true;
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

export function resolveActivatableProviderOwnerPluginIds(params: {
  pluginIds: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  return resolveProviderOwnerPluginIds({
    ...params,
    isEligible: (plugin, normalizedConfig) =>
      isProviderPluginEligibleForRuntimeOwnerActivation({
        plugin,
        normalizedConfig,
        rootConfig: params.config,
      }),
  });
}

export const __testing = {
  resolveActivatableProviderOwnerPluginIds,
  resolveEnabledProviderPluginIds,
  resolveExternalAuthProfileCompatFallbackPluginIds,
  resolveExternalAuthProfileProviderPluginIds,
  resolveDiscoveredProviderPluginIds,
  resolveDiscoverableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  withBundledProviderVitestCompat,
} as const;

type ModelSupportMatchKind = "pattern" | "prefix";

function resolveManifestRegistry(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry {
  return params.manifestRegistry ?? loadProviderManifestRegistry(params);
}

function stripModelProfileSuffix(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");
  return at <= 0 ? trimmed : trimmed.slice(0, at).trim();
}

function splitExplicitModelRef(rawModel: string): { provider?: string; modelId: string } | null {
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const modelId = stripModelProfileSuffix(trimmed);
    return modelId ? { modelId } : null;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  const modelId = stripModelProfileSuffix(trimmed.slice(slash + 1));
  if (!provider || !modelId) {
    return null;
  }
  return { provider, modelId };
}

function resolveModelSupportMatchKind(
  plugin: PluginManifestRecord,
  modelId: string,
): ModelSupportMatchKind | undefined {
  const patterns = plugin.modelSupport?.modelPatterns ?? [];
  for (const patternSource of patterns) {
    try {
      if (new RegExp(patternSource, "u").test(modelId)) {
        return "pattern";
      }
    } catch {
      continue;
    }
  }
  const prefixes = plugin.modelSupport?.modelPrefixes ?? [];
  for (const prefix of prefixes) {
    if (modelId.startsWith(prefix)) {
      return "prefix";
    }
  }
  return undefined;
}

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function resolvePreferredManifestPluginIds(
  registry: PluginManifestRegistry,
  matchedPluginIds: readonly string[],
): string[] | undefined {
  if (matchedPluginIds.length === 0) {
    return undefined;
  }
  const uniquePluginIds = dedupeSortedPluginIds(matchedPluginIds);
  if (uniquePluginIds.length <= 1) {
    return uniquePluginIds;
  }
  const nonBundledPluginIds = uniquePluginIds.filter((pluginId) => {
    const plugin = registry.plugins.find((entry) => entry.id === pluginId);
    return plugin?.origin !== "bundled";
  });
  if (nonBundledPluginIds.length === 1) {
    return nonBundledPluginIds;
  }
  if (nonBundledPluginIds.length > 1) {
    return undefined;
  }
  return undefined;
}

export function resolveOwningPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }

  const registry = resolveManifestRegistry(params);
  const pluginIds = registry.plugins
    .filter(
      (plugin) =>
        plugin.providers.some(
          (providerId) => normalizeProviderId(providerId) === normalizedProvider,
        ) ||
        plugin.cliBackends.some(
          (backendId) => normalizeProviderId(backendId) === normalizedProvider,
        ),
    )
    .map((plugin) => plugin.id);

  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveOwningPluginIdsForModelRef(params: {
  model: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] | undefined {
  const parsed = splitExplicitModelRef(params.model);
  if (!parsed) {
    return undefined;
  }

  if (parsed.provider) {
    return resolveOwningPluginIdsForProvider({
      provider: parsed.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      manifestRegistry: params.manifestRegistry,
    });
  }

  const registry = resolveManifestRegistry(params);
  const matchedByPattern = registry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "pattern")
    .map((plugin) => plugin.id);
  const preferredPatternPluginIds = resolvePreferredManifestPluginIds(registry, matchedByPattern);
  if (preferredPatternPluginIds) {
    return preferredPatternPluginIds;
  }

  const matchedByPrefix = registry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "prefix")
    .map((plugin) => plugin.id);
  return resolvePreferredManifestPluginIds(registry, matchedByPrefix);
}

export function resolveOwningPluginIdsForModelRefs(params: {
  models: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  const registry = resolveManifestRegistry(params);
  return dedupeSortedPluginIds(
    params.models.flatMap(
      (model) =>
        resolveOwningPluginIdsForModelRef({
          model,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          manifestRegistry: registry,
        }) ?? [],
    ),
  );
}

export function resolveNonBundledProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      plugin.origin !== "bundled" &&
      plugin.providers.length > 0 &&
      resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: params.config,
      }).activated,
  );
}

/**
 * @deprecated Compatibility path for third-party provider plugins that predate
 * `modelCatalog.providers`. Keep bundled plugins off this path and remove it
 * after the external plugin migration window.
 */
export function resolveModelCatalogCompatFallbackPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  declaredPluginIds?: ReadonlySet<string>;
  provider?: string;
}): string[] {
  const declaredPluginIds = params.declaredPluginIds ?? new Set<string>();
  const provider = params.provider ? normalizeProviderId(params.provider) : "";
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return listManifestPluginIds(
    registry,
    (plugin) =>
      plugin.origin !== "bundled" &&
      plugin.providers.length > 0 &&
      (!provider ||
        plugin.providers.some((candidate) => normalizeProviderId(candidate) === provider)) &&
      !declaredPluginIds.has(plugin.id) &&
      resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
      }).activated,
  );
}

export function resolveCatalogHookProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const declaredPluginIds = resolveDeclaredModelCatalogPluginIds(params);
  const declaredPluginIdSet = new Set(declaredPluginIds);
  const compatPluginIds = resolveModelCatalogCompatFallbackPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    declaredPluginIds: declaredPluginIdSet,
  });
  return [...new Set([...declaredPluginIds, ...compatPluginIds])].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function resolveModelCatalogPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return undefined;
  }
  const declaredPluginIds = resolveDeclaredModelCatalogPluginIdsForProvider({
    ...params,
    provider,
  });
  const registry = loadProviderManifestRegistry(params);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  const compatPluginIds = listManifestPluginIds(
    registry,
    (plugin) =>
      plugin.origin !== "bundled" &&
      plugin.providers.some((candidate) => normalizeProviderId(candidate) === provider) &&
      resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
      }).activated,
  );
  const merged = dedupeSortedPluginIds([...declaredPluginIds, ...compatPluginIds]);
  return merged.length > 0 ? merged : undefined;
}

export function resolveProviderStaticCatalogPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] | undefined {
  const pluginIds = resolveDiscoverableProviderOwnerPluginIds({
    pluginIds: dedupeSortedPluginIds([
      ...(resolveOwningPluginIdsForProvider(params) ?? []),
      ...(resolveProviderContractPluginIdsForProviderAlias(params.provider) ?? []),
    ]),
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveProviderStaticCatalogPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveDiscoveredProviderPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
}
