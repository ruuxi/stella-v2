export const createSharedWebPreferences = ({ preloadPath, sessionPartition, backgroundThrottling, }) => ({
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    partition: sessionPartition,
    webviewTag: false,

    backgroundThrottling: backgroundThrottling ?? true,
});
