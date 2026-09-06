import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerRuntimeAvailabilityBridge } from "../ipc/runtime-availability-bridge.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerInAppBrowserHandlers, IN_APP_BROWSER_CHANNELS, } from "../ipc/in-app-browser-handlers.js";
import { registerDiscoveryHandlers } from "../ipc/discovery-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerCloudHomeSyncHandlers } from "../ipc/cloud-home-sync-handlers.js";
import { registerMeetingCaptureHandlers } from "../ipc/meeting-capture-handlers.js";
import { registerDisplayHandlers } from "../ipc/display-handlers.js";
import { registerHomeHandlers } from "../ipc/home-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerMobileHelloHandlers } from "../ipc/mobile-hello-handlers.js";
import { registerNativeIntegrationHandlers } from "../ipc/native-integration-handlers.js";
import { registerOnboardingHandlers } from "../ipc/onboarding-handlers.js";
import { ipcMain, shell } from "electron";
import { toggleRealtimeVoice, } from "../services/realtime-voice-control.js";
import { WakewordService } from "../services/wakeword-service.js";
import { loadLocalPreferences, saveLocalPreferences, } from "@stella/runtime/kernel/preferences/local-preferences";
import { IPC_PREFERENCES_GET_WAKE_WORD, IPC_PREFERENCES_SET_WAKE_WORD, } from "@stella/contracts/desktop/ipc-channels";
import { registerOfficePreviewHandlers } from "../ipc/office-preview-handlers.js";
import { registerFashionHandlers } from "../ipc/fashion-handlers.js";
import { registerScheduleHandlers } from "../ipc/schedule-handlers.js";
import { registerThemeHandlers } from "../ipc/theme-handlers.js";
import { registerWebsiteHandlers } from "../ipc/website-handlers.js";
import { registerSystemHandlers, setPreventComputerSleep, } from "../ipc/system-handlers.js";
import { registerExternalOpenerHandlers } from "../ipc/external-opener-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerUiStateKvHandlers } from "../ipc/ui-state-handlers.js";
import { registerUpdatesHandlers } from "../ipc/updates-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { registerDictationHandlers } from "../ipc/dictation-handlers.js";
import { registerCompanionHandlers } from "../ipc/companion-handlers.js";
import { startCapturingHandlers } from "../services/mobile-bridge/handler-registry.js";
import { getAllWindows, getMobileBroadcast, } from "./context.js";
import { startMobileBridge, startStellaBrowserBridge, stopMobileBridge, } from "./aux-runtime.js";
import { isBrowserBridgeEagerStartWorthwhile, isStellaBrowserBridgeBinaryInstalled, isStellaExtensionInstalled, } from "../services/stella-browser-bridge-service.js";
import { InAppBrowserService } from "../services/in-app-browser-service.js";
import { InAppBrowserCdpAdapter } from "../services/in-app-browser-cdp-adapter.js";
import { InAppBrowserBootstrapServer } from "../services/in-app-browser-bootstrap-server.js";
import { STELLA_BROWSER_EXTENSION_STORE_URL } from "@stella/contracts/browser-extension";
import { scheduleGlobalInputHooksAfterAppReady } from "./global-input-hooks.js";
import { randomUUID } from "crypto";
import { startOfficePreviewBridge } from "./office-preview-bridge.js";
import { loadStellaDeviceId, loadStellaDeviceSigner } from "./host-runner.js";
const DEFAULT_STELLA_WEB_URL = "https://stella.sh";
// Delay native-service startup ~4s past app-ready so the bridge/office-preview
// spawns stay off the first-paint (TTI) path. Previously Windows-only; now
// applied on all platforms.
const POST_READY_NATIVE_DELAY_MS = 4_000;
const readStellaWebBaseUrl = () => {
    const raw = (process.env.STELLA_WEB_URL ??
        process.env.VITE_STELLA_WEB_URL ??
        DEFAULT_STELLA_WEB_URL).trim() || DEFAULT_STELLA_WEB_URL;
    try {
        return new URL(raw).origin;
    }
    catch {
        return DEFAULT_STELLA_WEB_URL;
    }
};
export const registerBootstrapIpcHandlers = (context, resetFlows) => {
    // Capture all ipcMain.handle registrations for the mobile bridge
    const stopCapturing = startCapturingHandlers();
    const lazyMobileBroadcast = () => getMobileBroadcast(context);
    const { config, lifecycle, services, state } = context;
    if (!state.inAppBrowserService) {
        state.inAppBrowserService = new InAppBrowserService({
            stellaDataDir: state.stellaDataDirPath ?? config.stellaDataDirPath,
            getWindow: () => state.windowManager?.getFullWindow() ?? null,
            ensureBrowserBridgeStarted: () => startStellaBrowserBridge(context),
            openExtensionStore: () => shell.openExternal(STELLA_BROWSER_EXTENSION_STORE_URL),
            getBrowserSetupStatus: () => ({
                bridgeBinaryInstalled: isStellaBrowserBridgeBinaryInstalled(),
                extensionInstalled: isStellaExtensionInstalled(),
            }),
            getBrowserBridgeStatus: () => state.stellaBrowserBridgeService?.getStatus?.(),
            getExtensionStatus: async () => {
                const resource = state.stellaBrowserBridgeService;
                if (!resource?.getExtensionStatus)
                    return false;
                return await resource.getExtensionStatus();
            },
            exportAllCookies: async () => {
                const resource = state.stellaBrowserBridgeService;
                if (!resource?.exportAllCookies) {
                    throw new Error("Browser bridge service is not running.");
                }
                return await resource.exportAllCookies();
            },
            exportCookiesForUrls: async (urls) => {
                const resource = state.stellaBrowserBridgeService;
                if (!resource?.exportCookiesForUrls) {
                    throw new Error("Browser bridge service is not running.");
                }
                return await resource.exportCookiesForUrls(urls);
            },
            subscribeCookieEvents: (onEvent) => {
                const resource = state.stellaBrowserBridgeService;
                if (!resource?.subscribeCookieEvents) {
                    return () => {};
                }
                return resource.subscribeCookieEvents(onEvent);
            },
            connectionTimeoutMs: 4 * 60 * 1000,
            connectionPollMs: 1000,
            automaticConnectionTimeoutMs: 15 * 1000,
            onStateChanged: (browserState) => {
                for (const window of getAllWindows(context)) {
                    if (!window.isDestroyed()) {
                        window.webContents.send(IN_APP_BROWSER_CHANNELS.state, browserState);
                    }
                }
            },
        });
    }
    if (!state.inAppBrowserCdpAdapter) {
        state.inAppBrowserCdpAdapter = new InAppBrowserCdpAdapter(state.inAppBrowserService);
    }
    const ensureInAppBrowserAgentRouting = async (capability) => {
        if (!capability) {
            await state.inAppBrowserCdpAdapter.start();
            return;
        }
        const resource = state.stellaBrowserBridgeService;
        if (!resource?.connectAgentCdp) {
            throw new Error("Browser bridge service is not running.");
        }
        const route = await state.inAppBrowserCdpAdapter.createOwnerCapability(capability.sessionId);
        return await resource.connectAgentCdp({
            ownerId: capability.sessionId,
            turnId: capability.turnId,
            ownerLeaseId: capability.ownerLeaseId,
            ownerLeaseIssuedAt: capability.ownerLeaseIssuedAt,
            ...(capability.recover ? { recover: true } : {}),
        }, route.cdpUrl);
    };
    const ensureInAppBrowserReady = async (capability) => {
        const browserState = await state.inAppBrowserService.connect();
        if (browserState.connection !== "connected") {
            throw new Error(browserState.error ??
                "Connect the Stella browser extension before using Stella Browser.");
        }
        return await ensureInAppBrowserAgentRouting(capability);
    };
    if (!state.inAppBrowserBootstrapServer) {
        state.inAppBrowserBootstrapServer = new InAppBrowserBootstrapServer({
            token: randomUUID(),
            ensureReady: ensureInAppBrowserReady,
        });
        void state.inAppBrowserBootstrapServer.start().catch((error) => {
            console.error("[in-app-browser] Failed to start lazy initialization server:", error);
        });
    }
    state.inAppBrowserHandlersDispose = registerInAppBrowserHandlers({
        service: state.inAppBrowserService,
        ensureAgentRouting: ensureInAppBrowserAgentRouting,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    let postReadyNativeServicesScheduled = false;
    const schedulePostReadyNativeServices = () => {
        if (postReadyNativeServicesScheduled) {
            return;
        }
        postReadyNativeServicesScheduled = true;
        // Keep native-service startup off the TTI path on every platform. Windows
        // already deferred ~4s post-paint; apply the same delay on macOS/Linux so
        // the bridge spawn never competes with first paint.
        state.processRuntime.setManagedTimeout(() => {
            postReadyNativeServicesScheduled = false;
            if (!state.appReady || state.isQuitting) {
                return;
            }
            // Only spawn the browser-bridge daemon when a cheap precondition says the
            // user actually uses browser automation (host already registered, or the
            // extension is installed). Spawning unconditionally launched an extra
            // Electron-as-Node process that, for users without the extension, just
            // retried with backoff before failing — pure startup cost. Users who DO
            // have the extension still get the bridge; first-time setup picks it up on
            // the next launch once the extension/host registration is detected.
            if (isBrowserBridgeEagerStartWorthwhile()) {
                startStellaBrowserBridge(context);
            }
            if (!state.officePreviewBridgeStop) {
                state.officePreviewBridgeStop = startOfficePreviewBridge(context);
            }
        }, POST_READY_NATIVE_DELAY_MS);
    };
    registerUiHandlers({
        uiState: services.uiStateService.state,
        windowManager: state.windowManager,
        updateUiState: (partial) => services.uiStateService.update(partial),
        broadcastUiState: () => services.uiStateService.broadcast(),
        setAppReady: (ready) => {
            state.appReady = ready;
            if (ready) {
                // Apply the preventComputerSleep power toggle here rather than during
                // synchronous bootstrap — it's not needed for the window to appear and
                // forces the first preferences.json read off the pre-paint path.
                setPreventComputerSleep(loadLocalPreferences(config.stellaDataDirPath).preventComputerSleep);
                scheduleGlobalInputHooksAfterAppReady(context);
                schedulePostReadyNativeServices();
            }
        },
        deactivateVoiceModes: () => services.uiStateService.deactivateVoiceModes(),
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    state.uiStateKvStore = registerUiStateKvHandlers({
        stellaDataDirPath: state.stellaDataDirPath ?? config.stellaDataDirPath,
        getAllWindows: () => getAllWindows(context),
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
        getBroadcastToMobile: lazyMobileBroadcast,
    });
    registerCaptureHandlers({
        captureService: services.captureService,
        windowManager: state.windowManager,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerHomeHandlers({
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerCloudHomeSyncHandlers({
        getStellaDataDir: lifecycle.getStellaDataDir,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerMeetingCaptureHandlers({
        getStellaDataDir: lifecycle.getStellaDataDir,
        getController: () => state.meetingCaptureController,
        setController: (controller) => {
            state.meetingCaptureController = controller;
        },
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerExternalOpenerHandlers({
        externalLinkService: services.externalLinkService,
    });
    registerSystemHandlers({
        getDeviceId: () => state.deviceId,
        loadDeviceId: () => loadStellaDeviceId(context),
        loadDeviceSigner: () => loadStellaDeviceSigner(context),
        authService: services.authService,
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
        getStellaAppDir: lifecycle.getStellaDataDir,
        getStellaInstallDir: lifecycle.getStellaAppDir,
        externalLinkService: services.externalLinkService,
        ensurePrivilegedActionApproval: (action, message, detail, event) => services.securityPolicyService.ensureApproval(action, message, detail, event),
        hardResetLocalState: resetFlows.hardResetLocalState,
        resetLocalMessages: resetFlows.resetLocalMessages,
        submitCredential: (payload) => services.credentialService.submitCredential(payload),
        cancelCredential: (payload) => services.credentialService.cancelCredential(payload),
        submitConnectorCredential: (payload) => services.connectorCredentialService.submitCredential(payload),
        cancelConnectorCredential: (payload) => services.connectorCredentialService.cancelCredential(payload),
        respondConnectorConnect: (payload) => services.connectorConnectService.respond(payload),
        getBroadcastToMobile: lazyMobileBroadcast,
        startPhoneAccessSession: () => {
            startMobileBridge(context);
            return { ok: true };
        },
        stopPhoneAccessSession: async () => {
            await stopMobileBridge(context);
            return { ok: true };
        },
        onPermissionGranted: (kind) => {
            if (kind === "accessibility") {
                scheduleGlobalInputHooksAfterAppReady(context);
            }
        },
        stopGlobalInputHooksForPermissionReset: () => {
            services.globalInputHook.stop();
            state.globalInputHooksStarted = false;
            state.globalInputHooksStartScheduled = false;
        },
        ensureGlobalInputHooksOnMac: () => {
            scheduleGlobalInputHooksAfterAppReady(context);
        },
    });
    registerScheduleHandlers({
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerBrowserHandlers({
        getStellaAppDir: lifecycle.getStellaAppDir,
        getStellaDataDir: lifecycle.getStellaDataDir,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
        // On-demand fallback to the eager startup gate: if the extension wasn't
        // detected at launch (installed mid-session, or in a custom user-data-dir),
        // the first browser-session fetch still starts the bridge. Idempotent —
        // reuses the existing resource if already running.
        ensureBrowserBridgeStarted: () => startStellaBrowserBridge(context),
    });
    registerDiscoveryHandlers({
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerOnboardingHandlers({
        authService: services.authService,
        getDeviceId: () => state.deviceId,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerOfficePreviewHandlers({
        getConvexAuthToken: () => services.authService.getAuthToken(),
        getStellaAppDir: lifecycle.getStellaAppDir,
        getStellaDataDir: lifecycle.getStellaDataDir,
        localChatHistoryService: services.localChatHistoryService,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerDisplayHandlers({
        getConvexAuthToken: () => services.authService.getAuthToken(),
        getStellaAppDir: lifecycle.getStellaAppDir,
        getStellaDataDir: lifecycle.getStellaDataDir,
        localChatHistoryService: services.localChatHistoryService,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerAgentHandlers({
        getStellaHostRunner: lifecycle.getRunner,
        getAppSessionStartedAt: () => state.appSessionStartedAt,
        isHostAuthAuthenticated: () => services.authService.getHostAuthAuthenticated(),
        getActiveCloudConversationCacheAuthority: () => services.localChatHistoryService.getActiveCloudConversationCacheAuthority(),
        uiState: services.uiStateService.state,
        stellaAppDir: config.stellaAppDir,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
        getBroadcastToMobile: lazyMobileBroadcast,
    });
    registerRuntimeAvailabilityBridge({
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    });
    registerLocalChatHandlers({
        localChatHistoryService: services.localChatHistoryService,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerMobileHelloHandlers({
        getActiveConversationId: () => services.uiStateService.state.conversationId,
        getUiStateSnapshot: () => state.uiStateKvStore?.snapshot() ?? {},
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerThemeHandlers({
        getStellaDataDir: lifecycle.getStellaDataDir,
    });
    registerWebsiteHandlers({
        getWebsiteBaseUrl: readStellaWebBaseUrl,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerFashionHandlers({
        getStellaAppDir: lifecycle.getStellaAppDir,
        getStellaDataDir: lifecycle.getStellaDataDir,
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerNativeIntegrationHandlers({
        getStellaAppDir: lifecycle.getStellaDataDir,
        requestExternalOAuthApproval: (payload) => services.connectorOAuthService.requestExternalOAuthApproval(payload),
        getConvexAuthToken: () => services.authService.getConvexAuthToken(),
        getConvexSiteUrl: () => services.authService.getConvexSiteUrl(),
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerUpdatesHandlers({
        getAllWindows: () => getAllWindows(context),
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
        // Fires the instant a restart-to-install is accepted, before the
        // updater starts quitting. electron-updater/Squirrel closes every
        // window and then waits for this process to exit before it swaps the
        // bundle in and relaunches. The always-on-top overlay window vetoes
        // its own `close` unless `isQuitting` is set, so if that sweep runs
        // before `before-quit-for-update` lands it can strand a hidden,
        // still-live app that never relaunches. Arm the quit flag and
        // force-destroy the window now — `destroy()` tears the
        // BrowserWindow down without emitting `close`, so nothing can veto it.
        onBeforeRestart: () => {
            state.isQuitting = true;
            try {
                state.overlayController?.destroy();
            }
            catch (error) {
                console.error("Failed to destroy overlay window for update restart.", error);
            }
        },
    });
    const toggleRealtimeVoiceImpl = () => toggleRealtimeVoice({
        uiStateService: services.uiStateService,
    });
    let wakeword = null;
    let wakewordPausedForVoice = services.uiStateService.state.isVoiceRtcActive;
    let wakewordPausedForDictation = false;
    const syncWakewordPause = () => {
        wakeword?.setPaused(wakewordPausedForVoice || wakewordPausedForDictation);
    };
    registerVoiceHandlers({
        uiState: services.uiStateService.state,
        getAppReady: () => state.appReady,
        windowManager: state.windowManager,
        broadcastUiState: () => services.uiStateService.broadcast(),
        toggleRealtimeVoice: toggleRealtimeVoiceImpl,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
        getBroadcastToMobile: lazyMobileBroadcast,
        getOverlayController: () => state.overlayController ?? null,
        stellaAppDir: state.stellaAppDir,
        stellaDataDirPath: state.stellaDataDirPath,
    });
    const dictationTap = registerDictationHandlers({
        windowManager: state.windowManager,
        getCompanionController: () => state.companionController ?? null,
        getStellaDataDir: lifecycle.getStellaDataDir,
        onDictationActiveChanged: (active) => {
            wakewordPausedForDictation = active;
            syncWakewordPause();
        },
    });
    services.globalInputHook.setDictationTapHandlers(dictationTap);
    registerCompanionHandlers({
        getCompanionController: () => state.companionController ?? null,
        windowManager: state.windowManager,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    // ── Wake-word listener ──────────────────────────────────────────────
    // Spawns the native `wakeword_listener` helper. On a "Hey Stella"
    // detection it activates the realtime voice agent. Mic buttons stay dictation-only — voice is
    // wake-word-gated. Auto-pauses while a voice session is active so
    // the assistant cannot trigger itself.
    services.uiStateService.onVoiceActiveChanged((active) => {
        wakewordPausedForVoice = active;
        syncWakewordPause();
    });
    syncWakewordPause();
    // Defer both the preferences.json read AND the enable/spawn off the pre-paint
    // IPC-registration path. The synchronous statSync+readFileSync that fed the
    // listener threshold used to run before first paint; loading prefs here keeps
    // that disk read off the TTI path. The threshold is only consumed by
    // WakewordService at spawn time, so constructing the service here loses
    // nothing. For "Hey Stella" users `setEnabled(true)` synchronously spawns the
    // native wakeword_listener helper (ONNX model load + mic open), which we don't
    // want blocking first paint either. setEnabled is idempotent and
    // timing-tolerant.
    state.processRuntime.setManagedTimeout(() => {
        const stellaDataDir = lifecycle.getStellaDataDir();
        const wakePrefs = stellaDataDir
            ? loadLocalPreferences(stellaDataDir)
            : { wakeWordEnabled: false, wakeWordThreshold: 0.6 };
        wakeword = new WakewordService({
            threshold: wakePrefs.wakeWordThreshold,
            onWake: (event) => {
                if (services.uiStateService.state.isVoiceRtcActive)
                    return;
                console.log(`[wakeword] detected "${event.model}" (score=${event.score.toFixed(3)})`);
                toggleRealtimeVoiceImpl();
            },
        });
        // Inherit any pause state accumulated (voice/dictation) during the deferral
        // gap before applying the persisted enabled preference.
        syncWakewordPause();
        wakeword.setEnabled(wakePrefs.wakeWordEnabled);
    }, 0);
    state.processRuntime.registerCleanup("will-quit", "wakeword-service", () => {
        wakeword?.dispose();
    });
    ipcMain.handle(IPC_PREFERENCES_GET_WAKE_WORD, (event) => {
        if (!services.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_WAKE_WORD)) {
            throw new Error("Blocked untrusted preferences:getWakeWord request.");
        }
        const root = lifecycle.getStellaDataDir();
        if (!root)
            return false;
        return loadLocalPreferences(root).wakeWordEnabled;
    });
    ipcMain.handle(IPC_PREFERENCES_SET_WAKE_WORD, (event, enabled) => {
        if (!services.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_SET_WAKE_WORD)) {
            throw new Error("Blocked untrusted preferences:setWakeWord request.");
        }
        const next = enabled === true;
        const root = lifecycle.getStellaDataDir();
        if (root) {
            const prefs = loadLocalPreferences(root);
            prefs.wakeWordEnabled = next;
            saveLocalPreferences(root, prefs);
        }
        // Null-safe: the listener is now constructed in a deferred post-registration
        // task. The persisted preference above is the source of truth, so a toggle
        // that lands before construction is honored when the deferred setEnabled
        // runs; `?.` only guards the (renderer-not-yet-painted) startup race.
        wakeword?.setEnabled(next);
        return { enabled: next };
    });
    stopCapturing();
};
