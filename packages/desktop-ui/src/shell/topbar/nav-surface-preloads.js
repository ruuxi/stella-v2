const preloaded = new Set();
const runOnce = (key, load) => {
    if (preloaded.has(key))
        return;
    preloaded.add(key);
    void load().catch(() => {
        preloaded.delete(key);
    });
};
export const preloadAuthDialog = () => runOnce("auth", () => import("@/global/auth/AuthDialog"));
export const preloadBillingScreen = () => runOnce("billing", () => import("@/global/billing/BillingScreen"));
export const preloadConnectDialog = () => runOnce("connect", () => import("@/global/integrations/ConnectDialog"));
export const preloadModelsPicker = () => runOnce("models-picker", async () => {
    const mod = await import("@/global/settings/AgentModelPicker");
    mod.warmAgentModelPickerCache();
    const { preloadModelCatalogCache } = await import("@/global/settings/hooks/use-model-catalog");
    preloadModelCatalogCache();
});
// Warm the Settings screen before opening its sidebar section.
export const preloadSettingsScreen = () => {
    runOnce("settings", () => import("@/global/settings/SettingsView"));
};
export const preloadSocialApp = () => runOnce("social", () => import("@/app/social/App"));
export const preloadSocialChatPane = () => runOnce("social-chat-pane", () => import("@/app/social/SocialChatPane"));
export const preloadSocialFriendsDialog = () => runOnce("social-friends-dialog", () => import("@/app/social/FriendsDialog"));
export const preloadSocialCommunitiesDialog = () => runOnce("social-communities-dialog", () => import("@/app/social/CommunitiesDialog"));
export const preloadSocialNewChatDialog = () => runOnce("social-new-chat-dialog", () => import("@/app/social/NewChatDialog"));
export const preloadStoreApp = () => runOnce("store", () => import("@/app/store/App"));
export const preloadNavSurfaceRoute = (appId) => {
    if (appId === "store") {
        preloadStoreApp();
    }
    else if (appId === "social") {
        preloadSocialApp();
    }
    else if (appId === "settings") {
        preloadSettingsScreen();
    }
};
