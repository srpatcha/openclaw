import fs from "node:fs/promises";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { ModelCatalogEntry, ModelInputType } from "../../agents/model-catalog.js";
import {
  createBuiltInModelSuppressor,
  type BuiltInModelSuppressor,
  shouldSuppressBuiltInModel,
} from "../../agents/model-suppression.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ListRowModel } from "./list.model-row.js";
import { loadModelRegistry, toModelRow } from "./list.registry.js";
import {
  augmentModelCatalogWithProviderPlugins,
  loadBuiltInCatalogModelsForList,
  loadModelCatalog,
  loadProviderCatalogModelsForList,
  resolveModelWithRegistry,
} from "./list.runtime.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";
import { isLocalBaseUrl, modelKey } from "./shared.js";

type ConfiguredByKey = Map<string, ConfiguredEntry>;

type RowFilter = {
  provider?: string;
  local?: boolean;
};

type RowBuilderContext = {
  cfg: OpenClawConfig;
  agentDir: string;
  authStore: AuthProfileStore;
  availableKeys?: Set<string>;
  configuredByKey: ConfiguredByKey;
  discoveredKeys: Set<string>;
  filter: RowFilter;
  skipRuntimeModelSuppression?: boolean;
  suppressBuiltInModel?: BuiltInModelSuppressor;
};

function matchesRowFilter(filter: RowFilter, model: { provider: string; baseUrl?: string }) {
  if (filter.provider && normalizeProviderId(model.provider) !== filter.provider) {
    return false;
  }
  if (filter.local && !isLocalBaseUrl(model.baseUrl ?? "")) {
    return false;
  }
  return true;
}

function buildRow(params: {
  model: ListRowModel;
  key: string;
  context: RowBuilderContext;
  allowProviderAvailabilityFallback?: boolean;
}): ModelRow {
  const configured = params.context.configuredByKey.get(params.key);
  return toModelRow({
    model: params.model,
    key: params.key,
    tags: configured ? Array.from(configured.tags) : [],
    aliases: configured?.aliases ?? [],
    availableKeys: params.context.availableKeys,
    cfg: params.context.cfg,
    authStore: params.context.authStore,
    allowProviderAvailabilityFallback: params.allowProviderAvailabilityFallback ?? false,
  });
}

function shouldSuppressListModel(params: {
  model: { provider: string; id: string; baseUrl?: string };
  context: RowBuilderContext;
}): boolean {
  if (params.context.skipRuntimeModelSuppression) {
    return false;
  }
  if (params.context.suppressBuiltInModel) {
    return params.context.suppressBuiltInModel(params.model);
  }
  return shouldSuppressBuiltInModel({
    provider: params.model.provider,
    id: params.model.id,
    baseUrl: params.model.baseUrl,
    config: params.context.cfg,
  });
}

function ensureBuiltInModelSuppressor(context: RowBuilderContext): BuiltInModelSuppressor {
  context.suppressBuiltInModel ??= createBuiltInModelSuppressor({
    config: context.cfg,
    providerFilter: context.filter.provider,
  });
  return context.suppressBuiltInModel;
}

function shouldAllowProviderAvailabilityFallback(context: RowBuilderContext, key: string): boolean {
  return context.availableKeys === undefined && !context.discoveredKeys.has(key);
}

function isLegacyFoundryVisionModelCandidate(params: {
  provider?: string;
  modelId?: string;
  modelName?: string;
}): boolean {
  if (normalizeProviderId(params.provider ?? "") !== "microsoft-foundry") {
    return false;
  }
  return [params.modelId, params.modelName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .some(
      (candidate) =>
        candidate.startsWith("gpt-") ||
        candidate.startsWith("o1") ||
        candidate.startsWith("o3") ||
        candidate.startsWith("o4") ||
        candidate === "computer-use-preview",
    );
}

function resolveConfiguredModelInput(params: {
  provider: string;
  model: ModelDefinitionConfig;
}): Array<"text" | "image"> {
  const configuredInput = Array.isArray(params.model.input) ? params.model.input : [];
  const input = configuredInput.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  if (
    input.length > 0 &&
    !input.includes("image") &&
    isLegacyFoundryVisionModelCandidate({
      provider: params.provider,
      modelId: params.model.id,
      modelName: params.model.name,
    })
  ) {
    return ["text", "image"];
  }
  return input.length > 0 ? input : ["text"];
}

function toConfiguredProviderListModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelDefinitionConfig;
}): ListRowModel {
  return {
    provider: params.provider,
    id: params.model.id,
    name: params.model.name ?? params.model.id,
    baseUrl: params.model.baseUrl ?? params.providerConfig.baseUrl,
    input: resolveConfiguredModelInput({ provider: params.provider, model: params.model }),
    contextWindow:
      params.model.contextWindow ??
      params.providerConfig.models?.[0]?.contextWindow ??
      DEFAULT_CONTEXT_TOKENS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toConfiguredProviderListModelFromUnknown(params: {
  provider: string;
  providerConfig: unknown;
  model: unknown;
}): ListRowModel | undefined {
  if (!isRecord(params.providerConfig) || !isRecord(params.model)) {
    return undefined;
  }
  if (typeof params.model.id !== "string") {
    return undefined;
  }
  return toConfiguredProviderListModel({
    provider: params.provider,
    providerConfig: params.providerConfig as ModelProviderConfig,
    model: {
      ...params.model,
      name: typeof params.model.name === "string" ? params.model.name : params.model.id,
    } as ModelDefinitionConfig,
  });
}

function toCatalogListModel(entry: {
  id: string;
  name?: string;
  provider: string;
  baseUrl?: string;
  contextWindow?: number | null;
  input?: string[];
}): ListRowModel {
  const input = (entry.input ?? ["text"]).filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    input: input.length > 0 ? input : ["text"],
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
  };
}

async function readModelsJsonModels(params: {
  agentDir: string;
  providerFilter?: string;
}): Promise<Map<string, ListRowModel>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(params.agentDir, "models.json"), "utf8"));
  } catch {
    return new Map();
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    return new Map();
  }
  const models = new Map<string, ListRowModel>();
  for (const [provider, providerConfig] of Object.entries(parsed.providers)) {
    if (params.providerFilter && normalizeProviderId(provider) !== params.providerFilter) {
      continue;
    }
    if (!isRecord(providerConfig) || !Array.isArray(providerConfig.models)) {
      continue;
    }
    for (const model of providerConfig.models) {
      const resolved = toConfiguredProviderListModelFromUnknown({
        provider,
        providerConfig,
        model,
      });
      if (!resolved) {
        continue;
      }
      models.set(modelKey(resolved.provider, resolved.id), resolved);
    }
  }
  return models;
}

export async function loadConfiguredModelMetadata(params: {
  agentDir: string;
  cfg: OpenClawConfig;
  entries: ConfiguredEntry[];
  providerFilter?: string;
}): Promise<Map<string, ListRowModel>> {
  const models = await readModelsJsonModels({
    agentDir: params.agentDir,
    providerFilter: params.providerFilter,
  });
  const missingCatalogEntry = params.entries.some((entry) => {
    if (
      resolveConfiguredProviderModelFromConfig({
        cfg: params.cfg,
        provider: entry.ref.provider,
        modelId: entry.ref.model,
      })
    ) {
      return false;
    }
    return !models.has(modelKey(entry.ref.provider, entry.ref.model));
  });
  if (!missingCatalogEntry) {
    return models;
  }
  for (const entry of await loadBuiltInCatalogModelsForList({
    providerFilter: params.providerFilter,
  })) {
    const model = toCatalogListModel(entry);
    models.set(modelKey(model.provider, model.id), model);
  }
  const stillMissingCatalogEntry = params.entries.some((entry) => {
    if (
      resolveConfiguredProviderModelFromConfig({
        cfg: params.cfg,
        provider: entry.ref.provider,
        modelId: entry.ref.model,
      })
    ) {
      return false;
    }
    return !models.has(modelKey(entry.ref.provider, entry.ref.model));
  });
  if (!stillMissingCatalogEntry) {
    return models;
  }
  for (const entry of await loadModelCatalog({
    config: params.cfg,
    includeProviderPlugins: false,
    providerFilter: params.providerFilter,
  })) {
    const model = toCatalogListModel(entry);
    models.set(modelKey(model.provider, model.id), model);
  }
  return models;
}

function resolveConfiguredProviderModelFromConfig(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): ListRowModel | undefined {
  const providerConfig = params.cfg.models?.providers?.[params.provider];
  const configuredModel = providerConfig?.models?.find((model) => model.id === params.modelId);
  if (!providerConfig || !configuredModel) {
    return undefined;
  }
  return toConfiguredProviderListModel({
    provider: params.provider,
    providerConfig,
    model: configuredModel,
  });
}

function resolveConfiguredListModel(params: {
  provider: string;
  modelId: string;
  metadataByKey: Map<string, ListRowModel>;
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
}): ListRowModel | undefined {
  const configuredModel = resolveConfiguredProviderModelFromConfig({
    cfg: params.context.cfg,
    provider: params.provider,
    modelId: params.modelId,
  });
  if (configuredModel) {
    return configuredModel;
  }

  const metadataModel = params.metadataByKey.get(modelKey(params.provider, params.modelId));
  if (metadataModel) {
    return metadataModel;
  }

  return resolveModelWithRegistry({
    provider: params.provider,
    modelId: params.modelId,
    modelRegistry: params.modelRegistry,
    cfg: params.context.cfg,
    agentDir: params.context.agentDir,
  });
}

export async function loadListModelRegistry(
  cfg: OpenClawConfig,
  opts?: Parameters<typeof loadModelRegistry>[1],
) {
  const loaded = await loadModelRegistry(cfg, opts);
  return {
    ...loaded,
    discoveredKeys: new Set(loaded.models.map((model) => modelKey(model.provider, model.id))),
  };
}

export function appendDiscoveredRows(params: {
  rows: ModelRow[];
  models: Model<Api>[];
  context: RowBuilderContext;
}): Set<string> {
  ensureBuiltInModelSuppressor(params.context);
  const seenKeys = new Set<string>();
  const sorted = [...params.models].toSorted((a, b) => {
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) {
      return providerCompare;
    }
    return a.id.localeCompare(b.id);
  });

  for (const model of sorted) {
    if (shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    if (!matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    const key = modelKey(model.provider, model.id);
    params.rows.push(
      buildRow({
        model,
        key,
        context: params.context,
      }),
    );
    seenKeys.add(key);
  }

  return seenKeys;
}

export function appendConfiguredProviderRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): void {
  for (const [provider, providerConfig] of Object.entries(
    params.context.cfg.models?.providers ?? {},
  )) {
    for (const configuredModel of providerConfig.models ?? []) {
      const key = modelKey(provider, configuredModel.id);
      if (params.seenKeys.has(key)) {
        continue;
      }
      const model = toConfiguredProviderListModel({
        provider,
        providerConfig,
        model: configuredModel,
      });
      if (!matchesRowFilter(params.context.filter, model)) {
        continue;
      }
      params.rows.push(
        buildRow({
          model,
          key,
          context: params.context,
          allowProviderAvailabilityFallback: shouldAllowProviderAvailabilityFallback(
            params.context,
            key,
          ),
        }),
      );
      params.seenKeys.add(key);
    }
  }
}

async function appendAugmentedCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  const entries: ModelCatalogEntry[] = params.rows
    .filter((row) => !row.missing)
    .map((row) => {
      const [provider, ...idParts] = row.key.split("/");
      const input: ModelInputType[] =
        row.input === "-"
          ? ["text"]
          : row.input
              .split("+")
              .filter(
                (item): item is ModelInputType =>
                  item === "text" || item === "image" || item === "document",
              );
      return {
        provider,
        id: idParts.join("/"),
        name: row.name,
        contextWindow: row.contextWindow ?? undefined,
        input,
      };
    });
  const supplemental = await augmentModelCatalogWithProviderPlugins({
    config: params.context.cfg,
    env: process.env,
    providerFilter: params.context.filter.provider,
    context: {
      config: params.context.cfg,
      agentDir: params.context.agentDir,
      env: process.env,
      entries,
    },
  });
  for (const entry of supplemental) {
    const key = modelKey(entry.provider, entry.id);
    if (params.seenKeys.has(key)) {
      continue;
    }
    const model = toCatalogListModel(entry);
    if (!matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    if (shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    params.rows.push(
      buildRow({
        model,
        key,
        context: params.context,
        allowProviderAvailabilityFallback: shouldAllowProviderAvailabilityFallback(
          params.context,
          key,
        ),
      }),
    );
    params.seenKeys.add(key);
  }
}

export async function appendCatalogSupplementRows(params: {
  rows: ModelRow[];
  modelRegistry?: ModelRegistry;
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  ensureBuiltInModelSuppressor(params.context);
  if (params.context.discoveredKeys.size > 0 || params.seenKeys.size === 0) {
    const catalog = !params.modelRegistry
      ? [
          ...(await loadBuiltInCatalogModelsForList({
            providerFilter: params.context.filter.provider,
          })),
          ...(
            await readModelsJsonModels({
              agentDir: params.context.agentDir,
              providerFilter: params.context.filter.provider,
            })
          ).values(),
        ]
      : await loadModelCatalog({
          config: params.context.cfg,
          externalProfiles: false,
          includeProviderPlugins: false,
          providerFilter: params.context.filter.provider,
        });
    for (const entry of catalog) {
      if (
        params.context.filter.provider &&
        normalizeProviderId(entry.provider) !== params.context.filter.provider
      ) {
        continue;
      }
      const key = modelKey(entry.provider, entry.id);
      if (params.seenKeys.has(key)) {
        continue;
      }
      const model = !params.modelRegistry
        ? toCatalogListModel(entry)
        : resolveModelWithRegistry({
            provider: entry.provider,
            modelId: entry.id,
            modelRegistry: params.modelRegistry,
            cfg: params.context.cfg,
          });
      if (!model || !matchesRowFilter(params.context.filter, model)) {
        continue;
      }
      if (shouldSuppressListModel({ model, context: params.context })) {
        continue;
      }
      params.rows.push(
        buildRow({
          model,
          key,
          context: params.context,
          allowProviderAvailabilityFallback:
            params.context.availableKeys === undefined && !params.context.discoveredKeys.has(key),
        }),
      );
      params.seenKeys.add(key);
    }
  }

  if (params.context.filter.local) {
    return;
  }

  await appendProviderCatalogRows({
    rows: params.rows,
    context: params.context,
    seenKeys: params.seenKeys,
  });
  await appendAugmentedCatalogRows(params);
}

export async function appendProviderCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  const models = await loadProviderCatalogModelsForList({
    cfg: params.context.cfg,
    agentDir: params.context.agentDir,
    providerFilter: params.context.filter.provider,
  });
  for (const model of models) {
    if (!matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    if (shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    const key = modelKey(model.provider, model.id);
    if (params.seenKeys.has(key)) {
      continue;
    }
    params.rows.push(
      buildRow({
        model,
        key,
        context: params.context,
        allowProviderAvailabilityFallback: shouldAllowProviderAvailabilityFallback(
          params.context,
          key,
        ),
      }),
    );
    params.seenKeys.add(key);
  }
}

export function appendConfiguredRows(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
  metadataByKey?: Map<string, ListRowModel>;
}) {
  ensureBuiltInModelSuppressor(params.context);
  const metadataByKey = params.metadataByKey ?? new Map<string, ListRowModel>();
  for (const entry of params.entries) {
    if (
      params.context.filter.provider &&
      normalizeProviderId(entry.ref.provider) !== params.context.filter.provider
    ) {
      continue;
    }
    const model = resolveConfiguredListModel({
      provider: entry.ref.provider,
      modelId: entry.ref.model,
      metadataByKey,
      modelRegistry: params.modelRegistry,
      context: params.context,
    });
    if (params.context.filter.local && model && !isLocalBaseUrl(model.baseUrl ?? "")) {
      continue;
    }
    if (params.context.filter.local && !model) {
      continue;
    }
    if (model && shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    params.rows.push(
      toModelRow({
        model,
        key: entry.key,
        tags: Array.from(entry.tags),
        aliases: entry.aliases,
        availableKeys: params.context.availableKeys,
        cfg: params.context.cfg,
        authStore: params.context.authStore,
        allowProviderAvailabilityFallback: model
          ? shouldAllowProviderAvailabilityFallback(
              params.context,
              modelKey(model.provider, model.id),
            )
          : false,
      }),
    );
  }
}
