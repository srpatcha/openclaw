import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildKilocodeProvider } from "./provider-catalog.js";

const PROVIDER_ID = "kilocode";

export const kilocodeProviderDiscovery: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "Kilo Gateway",
  docsPath: "/providers/kilocode",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildKilocodeProvider(),
    }),
  },
};

export default kilocodeProviderDiscovery;
