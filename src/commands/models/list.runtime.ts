export { loadAuthProfileStoreForSecretsRuntime as ensureAuthProfileStore } from "../../agents/auth-profiles/store.js";
export { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
export { listProfilesForProvider } from "../../agents/auth-profiles.js";
export {
  hasUsableCustomProviderApiKey,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
export { loadModelCatalog } from "../../agents/model-catalog.js";
export { augmentModelCatalogWithProviderPlugins } from "../../plugins/provider-runtime.runtime.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
export { resolveModelWithRegistry } from "../../agents/pi-embedded-runner/model.js";
export { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import type { ListRowModel } from "./list.model-row.js";
export { loadProviderCatalogModelsForList } from "./list.provider-catalog.js";

export async function loadBuiltInCatalogModelsForList(params?: {
  providerFilter?: string;
}): Promise<ListRowModel[]> {
  const { getModels, getProviders } = await import("@mariozechner/pi-ai");
  const providerFilter = params?.providerFilter ? normalizeProviderId(params.providerFilter) : "";
  const rows: ListRowModel[] = [];
  for (const provider of getProviders()) {
    if (providerFilter && normalizeProviderId(provider) !== providerFilter) {
      continue;
    }
    for (const model of getModels(provider)) {
      rows.push({
        provider: model.provider,
        id: model.id,
        name: model.name,
        baseUrl: model.baseUrl,
        input: model.input,
        contextWindow: model.contextWindow,
      });
    }
  }
  return rows;
}
