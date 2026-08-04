export const CHAT_DISPLAY_TAB_ID = "chat";
export const HOME_DISPLAY_TAB_ID = "home";
export const STORE_DISPLAY_TAB_ID = "store:side-panel";
export const TRASH_DISPLAY_TAB_ID = "trash:deferred-delete";
let adapter = null;
export const registerWorkspaceDefaultTabs = (nextAdapter) => {
    adapter = nextAdapter;
};
const getAdapter = () => {
    if (!adapter) {
        throw new Error("Workspace default tabs adapter has not been registered.");
    }
    return adapter;
};
export function openChatDisplayTab(openRequest = null, opts) {
    getAdapter().openChatDisplayTab(openRequest, opts);
}
export function openHomeDisplayTab() {
    getAdapter().openHomeDisplayTab();
}
export function ensureChatDisplayTab() {
    getAdapter().ensureChatDisplayTab();
}
export function openStoreDisplayTab() {
    getAdapter().openStoreDisplayTab();
}
export function openTrashDisplayTab() {
    getAdapter().openTrashDisplayTab();
}
export function openEngineDisplayTab() {
    getAdapter().openEngineDisplayTab();
}
