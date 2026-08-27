import path from "path";
import { AuthService } from "../services/auth-service.js";
import { BackupService } from "../services/backup-service.js";
import { CaptureService } from "../services/capture-service.js";
import { MouseHookManager } from "../input/mouse-hook.js";
import { CredentialService } from "../services/credential-service.js";
import { ConnectorCredentialService } from "../services/connector-credential-service.js";
import { ConnectorOAuthService } from "../services/connector-oauth-service.js";
import { ConnectorConnectService } from "../services/connector-connect-service.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import { readConfiguredCanvasShareBaseUrl, resolveSharedCanvasPayload, } from "../services/canvas-share-service.js";
import { isCanvasShareUrl } from "@stella/contracts/canvas-share";
import { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import { getDevServerUrl } from "../dev-url.js";
import { resolveRendererRoot } from "../renderer-location.js";
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
            options.getMobileBroadcast()?.("localChat:updated", payload ?? null);
        },

        onTaskDecorationUpdated: (payload) => {
            options.getMobileBroadcast()?.("localChat:taskDecorationUpdated", payload);
        },
    });
    externalLinkService.setDevBuild(config.useDevServer);
    if (config.useDevServer) {
        externalLinkService.trustDevServerBaseUrl(getDevServerUrl());
    }
    else {
        externalLinkService.trustFileRendererRoot(resolveRendererRoot(config.electronDir));
    }

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

    const authService = new AuthService({
        authProtocol: config.authProtocol,
        isDev: config.isDev,
        projectDir: path.resolve(config.electronDir, "..", ".."),
        sessionPartition: config.sessionPartition,
        runnerTarget: lifecycle,
        onAuthCallback: (url) => {
            if (!connectorCredentialService?.handleExternalOAuthCallback(url)) {
                console.warn("[security] Rejected unhandled protocol callback URL.");
            }
        },
        onSecondInstanceFocus: () => {
            state.windowManager?.getFullWindow()?.focus();
        },
    });
    const credentialService = new CredentialService({
        windowManagerTarget: lifecycle,
        getBroadcastToMobile: () => options.getMobileBroadcast(),
    });
    const connectorOAuthService = new ConnectorOAuthService();
    connectorCredentialService = new ConnectorCredentialService({
        windowManagerTarget: lifecycle,
        getStellaAppDir: () => lifecycle.getStellaDataDir(),
        getConvexAuthToken: () => authService.getConvexAuthToken(),
        getConvexSiteUrl: () => authService.getConvexSiteUrl(),
    });
    const connectorConnectService = new ConnectorConnectService({
        windowManagerTarget: lifecycle,
        getStellaAppDir: () => lifecycle.getStellaDataDir(),
        connectorCredentialService,
        getConvexAuthToken: () => authService.getConvexAuthToken(),
        getConvexSiteUrl: () => authService.getConvexSiteUrl(),
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
    const backupService = new BackupService({
        stellaAppDir: config.stellaAppDir,
        getStellaAppDir: () => state.stellaDataDirPath,
        getRunner: () => lifecycle.getRunner(),
        getAuthToken: () => authService.getAuthToken(),
        getConvexSiteUrl: () => authService.getConvexSiteUrl(),
        getDeviceId: () => state.deviceId,
        processRuntime: state.processRuntime,
    });
    const globalInputHook = new MouseHookManager();
    return {
        authService,
        backupService,
        captureService,
        globalInputHook,
        credentialService,
        connectorCredentialService,
        connectorOAuthService,
        connectorConnectService,
        externalLinkService,
        localChatHistoryService,
        securityPolicyService,
        uiStateService,
    };
};
