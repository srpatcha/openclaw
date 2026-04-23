import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { shouldSuppressBuiltInModel } from "../../agents/model-suppression.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../../plugins/synthetic-auth.runtime.js";
import {
  formatErrorWithStack,
  MODEL_AVAILABILITY_UNAVAILABLE_CODE,
  shouldFallbackToAuthHeuristics,
} from "./list.errors.js";
import { toModelRow as toModelRowBase } from "./list.model-row.js";
import {
  discoverAuthStorage,
  discoverModels,
  hasUsableCustomProviderApiKey,
  listProfilesForProvider,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
  resolveOpenClawAgentDir,
} from "./list.runtime.js";
import type { ModelRow } from "./list.types.js";
import { modelKey } from "./shared.js";

const hasAuthForProvider = (
  provider: string,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
) => {
  if (!cfg || !authStore) {
    return false;
  }
  if (listProfilesForProvider(authStore, provider).length > 0) {
    return true;
  }
  if (provider === "amazon-bedrock" && resolveAwsSdkEnvVarName()) {
    return true;
  }
  if (resolveEnvApiKey(provider)) {
    return true;
  }
  if (hasUsableCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  if (resolveRuntimeSyntheticAuthProviderRefs().includes(provider)) {
    return true;
  }
  return false;
};

const authAvailabilityCache = new WeakMap<
  AuthProfileStore,
  WeakMap<OpenClawConfig, Map<string, boolean>>
>();

function hasCachedAuthForProvider(params: {
  provider: string;
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
}): boolean {
  let byConfig = authAvailabilityCache.get(params.authStore);
  if (!byConfig) {
    byConfig = new WeakMap();
    authAvailabilityCache.set(params.authStore, byConfig);
  }
  let byProvider = byConfig.get(params.cfg);
  if (!byProvider) {
    byProvider = new Map();
    byConfig.set(params.cfg, byProvider);
  }
  const provider = params.provider;
  const cached = byProvider.get(provider);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = hasAuthForProvider(provider, params.cfg, params.authStore);
  byProvider.set(provider, resolved);
  return resolved;
}

function createAvailabilityUnavailableError(message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = MODEL_AVAILABILITY_UNAVAILABLE_CODE;
  return err;
}

function normalizeAvailabilityError(err: unknown): Error {
  if (shouldFallbackToAuthHeuristics(err) && err instanceof Error) {
    return err;
  }
  return createAvailabilityUnavailableError(
    `Model availability unavailable: getAvailable() failed.\n${formatErrorWithStack(err)}`,
  );
}

function validateAvailableModels(availableModels: unknown): Model<Api>[] {
  if (!Array.isArray(availableModels)) {
    throw createAvailabilityUnavailableError(
      "Model availability unavailable: getAvailable() returned a non-array value.",
    );
  }

  for (const model of availableModels) {
    if (
      !model ||
      typeof model !== "object" ||
      typeof (model as { provider?: unknown }).provider !== "string" ||
      typeof (model as { id?: unknown }).id !== "string"
    ) {
      throw createAvailabilityUnavailableError(
        "Model availability unavailable: getAvailable() returned invalid model entries.",
      );
    }
  }

  return availableModels as Model<Api>[];
}

function loadAvailableModels(registry: ModelRegistry, cfg: OpenClawConfig): Model<Api>[] {
  let availableModels: unknown;
  try {
    availableModels = registry.getAvailable();
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
  try {
    return validateAvailableModels(availableModels).filter(
      (model) =>
        !shouldSuppressBuiltInModel({
          provider: model.provider,
          id: model.id,
          baseUrl: model.baseUrl,
          config: cfg,
        }),
    );
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
}

export async function loadModelRegistry(
  cfg: OpenClawConfig,
  opts?: {
    loadAvailability?: boolean;
    loadAllModels?: boolean;
    providerFilter?: string;
    normalizeResolvedModels?: boolean;
  },
) {
  const agentDir = resolveOpenClawAgentDir();
  const authStorage = discoverAuthStorage(agentDir, {
    externalProfiles: false,
    providerFilter: opts?.providerFilter,
    readOnly: true,
  });
  const registry = discoverModels(authStorage, agentDir, {
    providerFilter: opts?.providerFilter,
    normalizeResolvedModels: opts?.normalizeResolvedModels,
  });
  const models =
    opts?.loadAllModels === false
      ? []
      : registry.getAll().filter(
          (model) =>
            !shouldSuppressBuiltInModel({
              provider: model.provider,
              id: model.id,
              baseUrl: model.baseUrl,
              config: cfg,
            }),
        );
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;

  try {
    if (opts?.loadAvailability === false) {
      availableKeys = undefined;
    } else {
      const availableModels = loadAvailableModels(registry, cfg);
      availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));
    }
  } catch (err) {
    if (!shouldFallbackToAuthHeuristics(err)) {
      throw err;
    }

    // Some providers can report model-level availability as unavailable.
    // Fall back to provider-level auth heuristics when availability is undefined.
    availableKeys = undefined;
    if (!availabilityErrorMessage) {
      availabilityErrorMessage = formatErrorWithStack(err);
    }
  }
  return { registry, models, availableKeys, availabilityErrorMessage };
}

export function toModelRow(params: Parameters<typeof toModelRowBase>[0]): ModelRow {
  return toModelRowBase({
    ...params,
    hasAuthForProvider: ({ provider, cfg, authStore }) =>
      hasCachedAuthForProvider({ provider, cfg, authStore }),
  });
}
