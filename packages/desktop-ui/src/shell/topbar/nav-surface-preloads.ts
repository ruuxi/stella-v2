type PreloadKey =
  | "auth"
  | "billing"
  | "connect"
  | "models-picker"
  | "settings";

const preloaded = new Set<PreloadKey>();

const runOnce = (key: PreloadKey, load: () => Promise<unknown>) => {
  if (preloaded.has(key)) return;
  preloaded.add(key);
  void load().catch(() => {
    preloaded.delete(key);
  });
};

export const preloadAuthDialog = () =>
  runOnce("auth", () => import("@/global/auth/AuthDialog"));

export const preloadBillingScreen = () =>
  runOnce("billing", () => import("@/global/billing/BillingScreen"));

export const preloadConnectDialog = () =>
  runOnce("connect", () => import("@/global/integrations/ConnectDialog"));

export const preloadModelsPicker = () =>
  runOnce("models-picker", async () => {
    const mod = await import("@/global/settings/AgentModelPicker");
    mod.warmAgentModelPickerCache();
    const { preloadModelCatalogCache } = await import(
      "@/global/settings/hooks/use-model-catalog"
    );
    preloadModelCatalogCache();
  });

export const preloadSettingsScreen = () => {
  runOnce("settings", () => import("@/global/settings/SettingsView"));
};

export const preloadNavSurfaceRoute = (appId: string) => {
  if (appId === "settings") {
    preloadSettingsScreen();
  }
};
