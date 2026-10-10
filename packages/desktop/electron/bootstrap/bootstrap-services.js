import path from "path";
import { app } from "electron";
import { AuthService } from "../services/auth-service.js";
import { CaptureService } from "../services/capture-service.js";
import { MouseHookManager } from "../input/mouse-hook.js";
import { UserAskService } from "../services/user-ask-service.js";
import { ConnectorCredentialService } from "../services/connector-credential-service.js";
import { ConnectorOAuthService } from "../services/connector-oauth-service.js";
import { ConnectorConnectService } from "../services/connector-connect-service.js";
import { EngineAccountAccess } from "../services/engine-account-access.js";
import { MemorySyncService } from "../services/memory-sync/memory-sync-service.js";
import { ClaudeLocalAccounts } from "../services/claude-local-accounts.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import { readConfiguredCanvasShareBaseUrl, resolveSharedCanvasPayload, } from "../services/canvas-share-service.js";
import { isCanvasShareUrl } from "@stella/contracts/canvas-share";
import {
  IPC_AUTH_SESSION_INVALIDATED,
  IPC_MEMORY_SYNC_STATUS,
  IPC_LOCAL_CHAT_UPDATED,
  IPC_DISPLAY_UPDATE,
  IPC_CLAUDE_ACCOUNTS_CHANGED,
} from "@stella/contracts/desktop/ipc-channels";
import { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import { RENDERER_ORIGIN } from "../source/origin.js";
import { initMainProcessTelemetry } from "../observability/main-telemetry.js";
import { getMainLogger } from "../observability/main-logger.js";
export const createBootstrapServices = (options) => {
    const { config, lifecycle, state } = options;
    const uiStateService = new UiStateService();
    const externalLinkService = new ExternalLinkService();
    const localChatHistoryService = new LocalChatHistoryService({
        stellaAppDir: config.stellaDataDirPath,
        onUpdated: (payload) => {
            for (const window of options.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_LOCAL_CHAT_UPDATED, payload ?? null);
                }
            }
        },
    });
    externalLinkService.setDevBuild(config.isDeveloperInstance);
    externalLinkService.trustRendererOrigin(RENDERER_ORIGIN);
    // A canvas-share link (`<CANVAS_SHARE_BASE_URL>/c/<slug>`) clicked/opened
    // inside Stella is fetched + materialized in main and pushed to the Canvas
    // panel via the existing `display:update` path, instead of bouncing out to
    // the system browser. Returns true so the external-link funnel skips the
    // browser open. No-ops when the share domain has not been configured.
    // A link that can't be rendered here (a private canvas, which opens only
    // with its owner's grant, or the share domain unreachable) goes to the
    // system browser after all, so the click is never swallowed.
    externalLinkService.setCanvasShareHandler((url) => {
        const baseUrl = readConfiguredCanvasShareBaseUrl();
        if (!baseUrl || !isCanvasShareUrl(url, baseUrl))
            return false;
        void resolveSharedCanvasPayload({
            url,
            baseUrl,
            stellaDataDir: config.stellaDataDirPath,
        })
            .then((payload) => {
            if (!payload) {
                externalLinkService.openSafeExternalUrl(url);
                return;
            }
            for (const window of options.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_DISPLAY_UPDATE, payload);
                }
            }
        })
            .catch(() => { });
        return true;
    });
    const securityPolicyService = new SecurityPolicyService({
        windowManagerTarget: lifecycle,
    });
    let connectorCredentialService = null;
    // NOTE: setPreventComputerSleep is applied post-appReady in
    // registerBootstrapIpcHandlers (ipc.ts) so the first preferences.json read
    // and the power toggle don't run on the synchronous pre-paint path.
    const authService = new AuthService({
        authProtocol: config.authProtocol,
        projectDir: path.resolve(config.electronDir, "..", ".."),
        sessionPartition: config.sessionPartition,
        runnerTarget: lifecycle,
        onAuthCallback: (url) => {
            // The only deep link that still reaches here is an external
            // connector OAuth callback (`stella://oauth/callback/...`). App
            // sign-in is claimed over HTTPS, not handed back by deep link.
            if (connectorCredentialService?.handleExternalOAuthCallback(url)) {
                return;
            }
            console.warn("[security] Rejected unhandled protocol callback URL.");
        },
        onSecondInstanceFocus: () => {
            state.windowManager?.getFullWindow()?.focus();
        },
        onSessionInvalidated: () => {
            for (const window of options.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_AUTH_SESSION_INVALIDATED, null);
                }
            }
        },
    });
    const telemetry = initMainProcessTelemetry({
        stellaDataDirPath: config.stellaDataDirPath,
        environment: config.telemetryEnvironment,
        getAuthToken: () => authService.getAuthToken(),
    });
    const userAskService = new UserAskService({
        getAllWindows: () => options.getAllWindows(),
        getStellaAppDir: () => lifecycle.getStellaDataDir(),
        getDeviceId: () => state.deviceId,
        getRunner: () => lifecycle.getRunner(),
        getInAppBrowserService: () => state.inAppBrowserService,
        getBackendUrl: () => authService.getBackendUrl(),
        getAuthToken: () => authService.getAuthToken(),
        notificationContext: { state },
    });
    const engineAccountAccess = new EngineAccountAccess({
        getBackendUrl: () => authService.getBackendUrl(),
        getAuthToken: () => authService.getAuthToken(),
    });
    // Claude Code logins on this computer (the CLI's own; Stella holds no
    // Claude credential). Re-read when a window gets focus, never polled.
    const claudeLocalAccounts = new ClaudeLocalAccounts({
        stellaDataDir: config.stellaDataDirPath,
        engineAccounts: engineAccountAccess,
        loadDeviceId: async () => (await options.loadDeviceId?.()) ?? null,
        onChanged: () => {
            for (const window of options.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_CLAUDE_ACCOUNTS_CHANGED, {});
                }
            }
        },
    });
    // Memory files kept the same here and in the cloud, both ways. Started by
    // the session token (host-runner's onAuthTokenChanged).
    const memorySync = new MemorySyncService({
        stellaDataDir: config.stellaDataDirPath,
        getBackendUrl: () => authService.getBackendUrl(),
        getAuthToken: () => authService.getAuthToken(),
        hasConnectedAccount: () => authService.getHostHasConnectedAccount(),
        // Memory edited on both sides goes to a background agent to merge,
        // the way app-source briefs do: no user message is synthesized.
        dispatchAgentBrief: async (brief) => {
            const runner = lifecycle.getRunner();
            const conversationId = uiStateService.state.conversationId;
            if (!runner || !conversationId) {
                throw new Error("Stella isn't ready to start an agent yet.");
            }
            await runner.createBackgroundAgent({
                conversationId,
                description: brief.description,
                prompt: brief.prompt,
                agentType: "general",
            });
        },
        broadcast: (status) => {
            for (const window of options.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_MEMORY_SYNC_STATUS, status);
                }
            }
        },
        log: (event, data) => getMainLogger()?.process(event, data),
    });
    app.on("browser-window-focus", () => {
        claudeLocalAccounts.noteWindowFocus();
        memorySync.noteWindowFocus();
    });
    const connectorOAuthService = new ConnectorOAuthService();
    connectorCredentialService = new ConnectorCredentialService({
        windowManagerTarget: lifecycle,
        getStellaAppDir: () => lifecycle.getStellaDataDir(),
        getAuthToken: () => authService.getAuthToken(),
        getBackendUrl: () => authService.getBackendUrl(),
    });
    const connectorConnectService = new ConnectorConnectService({
        windowManagerTarget: lifecycle,
        getStellaAppDir: () => lifecycle.getStellaDataDir(),
        connectorCredentialService,
        getAuthToken: () => authService.getAuthToken(),
        getBackendUrl: () => authService.getBackendUrl(),
    });
    const captureService = new CaptureService({
        window: {
            getAllWindows: () => options.getAllWindows(),
        },
        overlay: {
            startRegionCapture: () => state.overlayController?.startRegionCapture(),
            endRegionCapture: () => state.overlayController?.endRegionCapture(),
            suspendRegionCaptureForScreenshot: () => state.overlayController?.suspendRegionCaptureForScreenshot(),
            restoreRegionCaptureAfterScreenshot: () => state.overlayController?.restoreRegionCaptureAfterScreenshot(),
            getOverlayBounds: () => state.overlayController?.getWindow()?.getBounds() ?? null,
        },
        updateUiState: (partial) => uiStateService.update(partial),
    });
    const globalInputHook = new MouseHookManager();
    return {
        authService,
        captureService,
        globalInputHook,
        userAskService,
        connectorCredentialService,
        connectorOAuthService,
        connectorConnectService,
        engineAccountAccess,
        claudeLocalAccounts,
        memorySync,
        externalLinkService,
        localChatHistoryService,
        securityPolicyService,
        telemetry,
        uiStateService,
    };
};
