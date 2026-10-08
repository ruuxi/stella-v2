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
import { ClaudeLocalAccounts } from "../services/claude-local-accounts.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import { readConfiguredCanvasShareBaseUrl, resolveSharedCanvasPayload, } from "../services/canvas-share-service.js";
import { isCanvasShareUrl } from "@stella/contracts/canvas-share";
import { IPC_AUTH_SESSION_INVALIDATED } from "@stella/contracts/desktop/ipc-channels";
import { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import { RENDERER_ORIGIN } from "../source/origin.js";
import { initMainProcessTelemetry } from "../observability/main-telemetry.js";
export const createBootstrapServices = (options) => {
    const { config, lifecycle, state } = options;
    const uiStateService = new UiStateService();
    const externalLinkService = new ExternalLinkService();
    const localChatHistoryService = new LocalChatHistoryService({
        stellaAppDir: config.stellaDataDirPath,
        onUpdated: (payload) => {
            for (const window of options.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send("localChat:updated", payload ?? null);
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
            if (!payload)
                return;
            for (const window of options.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send("display:update", payload);
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
                    window.webContents.send("claudeAccounts:changed", {});
                }
            }
        },
    });
    app.on("browser-window-focus", () => claudeLocalAccounts.noteWindowFocus());
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
        externalLinkService,
        localChatHistoryService,
        securityPolicyService,
        telemetry,
        uiStateService,
    };
};
