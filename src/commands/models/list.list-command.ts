import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "../../agents/model-selection.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import {
  appendCatalogSupplementRows,
  appendConfiguredProviderRows,
  appendConfiguredRows,
  appendDiscoveredRows,
  appendProviderCatalogRows,
  loadConfiguredModelMetadata,
  loadListModelRegistry,
} from "./list.rows.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const providerFilter = (() => {
    const raw = opts.provider?.trim();
    if (!raw) {
      return undefined;
    }
    if (/\s/u.test(raw)) {
      runtime.error(
        `Invalid provider filter "${raw}". Use a provider id such as "moonshot", not a display label.`,
      );
      process.exitCode = 1;
      return null;
    }
    const parsed = parseModelRef(`${raw}/_`, DEFAULT_PROVIDER, DISPLAY_MODEL_PARSE_OPTIONS);
    return parsed?.provider ?? normalizeLowercaseStringOrEmpty(raw);
  })();
  if (providerFilter === null) {
    return;
  }
  const { ensureAuthProfileStore, resolveOpenClawAgentDir } = await import("./list.runtime.js");
  const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const authStore = ensureAuthProfileStore();
  const agentDir = resolveOpenClawAgentDir();

  let modelRegistry: ModelRegistry | undefined;
  let registryModels: Awaited<ReturnType<typeof loadListModelRegistry>>["models"] = [];
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  const useProviderCatalogFastPath = Boolean(opts.all && providerFilter === "codex");
  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const configuredProviderFilter =
    !opts.all && !providerFilter
      ? (() => {
          const providers = new Set(entries.map((entry) => entry.ref.provider));
          return providers.size === 1 ? providers.values().next().value : undefined;
        })()
      : undefined;
  try {
    if (!useProviderCatalogFastPath) {
      if (opts.all && !providerFilter) {
        // Unfiltered --all can be assembled from the built-in catalog and lightweight provider
        // catalogs without creating the expensive Pi model registry.
      } else {
        const registryOptions = {
          ...(!opts.all ? { loadAllModels: false } : {}),
          ...(providerFilter || configuredProviderFilter
            ? { providerFilter: providerFilter ?? configuredProviderFilter }
            : {}),
          ...(opts.all && providerFilter ? { normalizeResolvedModels: false } : {}),
        };
        const loaded = await loadListModelRegistry(cfg, registryOptions);
        modelRegistry = loaded.registry;
        registryModels = loaded.models;
        discoveredKeys = loaded.discoveredKeys;
        availableKeys = loaded.availableKeys;
        availabilityErrorMessage = loaded.availabilityErrorMessage;
      }
    }
  } catch (err) {
    runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
    process.exitCode = 1;
    return;
  }
  if (availabilityErrorMessage !== undefined) {
    runtime.error(
      `Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`,
    );
  }

  const rows: ModelRow[] = [];
  const rowContext = {
    cfg,
    agentDir,
    authStore,
    availableKeys,
    configuredByKey,
    discoveredKeys,
    filter: {
      provider: providerFilter,
      local: opts.local,
    },
    skipRuntimeModelSuppression: useProviderCatalogFastPath,
  };

  if (opts.all) {
    let seenKeys = appendDiscoveredRows({
      rows,
      models: registryModels,
      context: rowContext,
    });

    if (modelRegistry) {
      appendConfiguredProviderRows({
        rows,
        context: rowContext,
        seenKeys,
      });
    }

    if (modelRegistry || !providerFilter) {
      await appendCatalogSupplementRows({
        rows,
        modelRegistry,
        context: rowContext,
        seenKeys,
      });
    } else if (useProviderCatalogFastPath) {
      await appendProviderCatalogRows({
        rows,
        context: rowContext,
        seenKeys,
      });
    }

    if (!providerFilter && rows.length === 0) {
      let loaded: Awaited<ReturnType<typeof loadListModelRegistry>>;
      try {
        loaded = await loadListModelRegistry(cfg);
      } catch (err) {
        runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
        process.exitCode = 1;
        return;
      }
      if (loaded.availabilityErrorMessage !== undefined) {
        runtime.error(
          `Model availability lookup failed; falling back to auth heuristics for discovered models: ${loaded.availabilityErrorMessage}`,
        );
      }
      rowContext.availableKeys = loaded.availableKeys;
      rowContext.discoveredKeys = loaded.discoveredKeys;
      seenKeys = appendDiscoveredRows({
        rows,
        models: loaded.models,
        context: rowContext,
      });
      appendConfiguredProviderRows({
        rows,
        context: rowContext,
        seenKeys,
      });
    }
  } else {
    const registry = modelRegistry;
    if (!registry) {
      runtime.error("Model registry unavailable.");
      process.exitCode = 1;
      return;
    }
    const metadataByKey = await loadConfiguredModelMetadata({
      agentDir,
      cfg,
      entries,
      providerFilter: providerFilter ?? configuredProviderFilter,
    });
    appendConfiguredRows({
      rows,
      entries,
      modelRegistry: registry,
      context: rowContext,
      metadataByKey,
    });
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}
