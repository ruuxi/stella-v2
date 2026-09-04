export const createSharedWebPreferences = ({ preloadPath, sessionPartition, backgroundThrottling, }) => ({
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    partition: sessionPartition,
    webviewTag: false,
    // Perf: make Chromium's background-throttling intent explicit instead of
    // relying on the framework default. Callers that need an always-live
    // renderer (overlay) passes `false`; the full shell gets `true` so a
    // backgrounded shell yields CPU.
    backgroundThrottling: backgroundThrottling ?? true,
});
