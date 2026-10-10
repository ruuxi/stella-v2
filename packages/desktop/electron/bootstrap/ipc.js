import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerRuntimeAvailabilityBridge } from "../ipc/runtime-availability-bridge.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerInAppBrowserHandlers } from "../ipc/in-app-browser-handlers.js";
import { registerDiscoveryHandlers } from "../ipc/discovery-handlers.js";
import { registerRemoteExecutionConsentHandlers } from "../ipc/remote-execution-consent-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerCloudHomeSyncHandlers } from "../ipc/cloud-home-sync-handlers.js";
import { registerMemorySyncHandlers } from "../ipc/memory-sync-handlers.js";
import { registerMeetingCaptureHandlers } from "../ipc/meeting-capture-handlers.js";
import { registerDisplayHandlers } from "../ipc/display-handlers.js";
import { registerHomeHandlers } from "../ipc/home-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerNativeIntegrationHandlers } from "../ipc/native-integration-handlers.js";
import { registerOnboardingHandlers } from "../ipc/onboarding-handlers.js";
import { app, BrowserWindow, shell } from "electron";
import { toggleRealtimeVoice, } from "../services/realtime-voice-control.js";
import { WakewordService } from "../services/wakeword-service.js";
import { loadLocalPreferences, saveLocalPreferences, } from "@stella/runtime/kernel/preferences/local-preferences";
import { IPC_APP_SOURCE_STATE, IPC_BROWSER_VIEW_STATE, IPC_PREFERENCES_GET_WAKE_WORD, IPC_PREFERENCES_SET_WAKE_WORD, } from "@stella/contracts/desktop/ipc-channels";
import { registerOfficePreviewHandlers } from "../ipc/office-preview-handlers.js";
import { registerChatEvidenceHandlers } from "../ipc/chat-evidence-handlers.js";
import { createCloudConversationFileGrants } from "../services/cloud-conversation-file-grants.js";
import { createDeviceFileLocator } from "../services/device-file-locator.js";
import { setDeviceMediaSource } from "../source/media-protocol.js";
import { registerScheduleHandlers } from "../ipc/schedule-handlers.js";
import { registerThemeHandlers } from "../ipc/theme-handlers.js";
import { registerWebsiteHandlers } from "../ipc/website-handlers.js";
import { registerSystemHandlers, setPreventComputerSleep, } from "../ipc/system-handlers.js";
import { registerExternalOpenerHandlers } from "../ipc/external-opener-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerUiStateKvHandlers } from "../ipc/ui-state-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { registerDictationHandlers } from "../ipc/dictation-handlers.js";
import { registerCompanionHandlers } from "../ipc/companion-handlers.js";
import { getAllWindows, } from "./context.js";
import { startStellaBrowserBridge, } from "./aux-runtime.js";
import { getBrowserBridgeNamespace } from "../services/stella-browser-bridge-namespace.js";
import { isBrowserBridgeEagerStartWorthwhile, isStellaBrowserBridgeBinaryInstalled, isStellaExtensionInstalled, } from "../services/stella-browser-bridge-service.js";
import { InAppBrowserService } from "../services/in-app-browser-service.js";
import { InAppBrowserCdpAdapter } from "../services/in-app-browser-cdp-adapter.js";
import { InAppBrowserBootstrapServer } from "../services/in-app-browser-bootstrap-server.js";
import { STELLA_BROWSER_EXTENSION_STORE_URL } from "@stella/contracts/browser-extension";
import { scheduleGlobalInputHooksAfterAppReady } from "./global-input-hooks.js";
import { randomUUID } from "crypto";
import { startOfficePreviewBridge } from "./office-preview-bridge.js";
import { loadStellaDeviceId, loadStellaDeviceSigner } from "./host-runner.js";
import path from "path";
import { BROWSER_BRIDGE_MISSING_ERROR } from "../utils/register-stella-native-messaging-host.js";
import { registerAppSourceHandlers } from "../ipc/app-source-handlers.js";
import { AppSourceService } from "../services/app-source/app-source-service.js";
import { UpdateTransition } from "../services/app-source/update-transition.js";
import { t } from "../services/i18n-service.js";
import { buildAndUploadWebRenderer } from "../services/app-source/web-renderer.js";
import { assertHeadSigned, signHead } from "../launcher-client.js";
import { getMainLogger } from "../observability/main-logger.js";
import { openDraftPreview } from "../services/app-source/draft-preview.js";
import { holdForRelaunch, relaunchApp } from "../launcher-client.js";
import {
  handleIpc,
} from "../ipc/typed-ipc.js";
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
            getBrowserBridgeNamespace: () => getBrowserBridgeNamespace(),
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
            // Agents check UI drafts in the running app, which always runs from
            // source.
            openPreview: (name) => openDraftPreview({
                name,
                stellaAppDir: state.stellaAppDir ?? config.stellaAppDir,
                stellaDataDir: state.stellaDataDirPath ?? config.stellaDataDirPath,
                preloadPath: path.join(config.electronDir, "preload.js"),
            }),
            connectionTimeoutMs: 4 * 60 * 1000,
            connectionPollMs: 1000,
            automaticConnectionTimeoutMs: 15 * 1000,
            onStateChanged: (browserState) => {
                for (const window of getAllWindows(context)) {
                    if (!window.isDestroyed()) {
                        window.webContents.send(IPC_BROWSER_VIEW_STATE, browserState);
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
    // Agent routing does not wait for the extension: draft previews need none,
    // and web tabs still require it when they are created (see
    // InAppBrowserService.createDebuggerTarget). The connect attempt starts
    // here so cookie seeding overlaps the routing setup.
    const ensureInAppBrowserReady = async (capability) => {
        if (!isStellaBrowserBridgeBinaryInstalled()) {
            throw new Error(BROWSER_BRIDGE_MISSING_ERROR);
        }
        void state.inAppBrowserService.connect().catch(() => { });
        startStellaBrowserBridge(context);
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
    registerMemorySyncHandlers({
        service: services.memorySync,
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
        engineAccountAccess: services.engineAccountAccess,
        claudeLocalAccounts: services.claudeLocalAccounts,
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
        getStellaAppDir: lifecycle.getStellaDataDir,
        getStellaInstallDir: lifecycle.getStellaAppDir,
        externalLinkService: services.externalLinkService,
        ensurePrivilegedActionApproval: (action, message, detail, event) => services.securityPolicyService.ensureApproval(action, message, detail, event),
        hardResetLocalState: resetFlows.hardResetLocalState,
        resetLocalMessages: resetFlows.resetLocalMessages,
        listUserAsks: () => services.userAskService.listOpenAsks(),
        answerUserAsk: (payload) => services.userAskService.answer(payload),
        cancelUserAsk: (payload) => services.userAskService.cancel(payload),
        overrideUserAskSensitive: (payload) => services.userAskService.overrideSensitive(payload),
        getUserAskPolicy: () => services.userAskService.getPolicy(),
        setUserAskPolicy: (payload) => services.userAskService.setPolicy(payload),
        submitConnectorCredential: (payload) => services.connectorCredentialService.submitCredential(payload),
        cancelConnectorCredential: (payload) => services.connectorCredentialService.cancelCredential(payload),
        respondConnectorConnect: (payload) => services.connectorConnectService.respond(payload),
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
        getStellaHostRunner: lifecycle.getRunner,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerRemoteExecutionConsentHandlers({
        getStellaHostRunner: lifecycle.getRunner,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    // A paired phone's file and preview requests are held to files Stella
    // produced or displayed in the conversation it names, per the cloud
    // journal, in any of this owner's conversations.
    const cloudFileGrants = createCloudConversationFileGrants({
        getBackendUrl: () => services.authService.getBackendUrl(),
        getAuthToken: () => services.authService.getAuthToken(),
    });
    // A conversation's pi transcript names the files Stella linked there.
    const piLinkedFiles = async (conversationId) => (await lifecycle.getRunner()?.piChat({ op: "files", conversationId }))?.paths ?? [];
    const deviceFileLocator = createDeviceFileLocator({
        getBackendUrl: () => services.authService.getBackendUrl(),
        getAuthToken: () => services.authService.getAuthToken(),
    });
    const deviceFiles = {
        locator: deviceFileLocator,
        getDeviceId: () => state.deviceId,
    };
    setDeviceMediaSource(deviceFiles);
    const officePreview = registerOfficePreviewHandlers({
        cloudFileGrants,
        piLinkedFiles,
        deviceFiles,
        getAuthToken: () => services.authService.getAuthToken(),
        getStellaAppDir: lifecycle.getStellaAppDir,
        getStellaDataDir: lifecycle.getStellaDataDir,
        localChatHistoryService: services.localChatHistoryService,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerChatEvidenceHandlers({
        getStellaDataDir: lifecycle.getStellaDataDir,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    const display = registerDisplayHandlers({
        cloudFileGrants,
        piLinkedFiles,
        deviceFileLocator,
        getDeviceId: () => state.deviceId,
        getAuthToken: () => services.authService.getAuthToken(),
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
        getStellaDataDir: lifecycle.getStellaDataDir,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerRuntimeAvailabilityBridge({
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    });
    registerLocalChatHandlers({
        localChatHistoryService: services.localChatHistoryService,
        getStellaHostRunner: lifecycle.getRunner,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerThemeHandlers({
        getStellaDataDir: lifecycle.getStellaDataDir,
    });
    registerWebsiteHandlers({
        getWebsiteBaseUrl: readStellaWebBaseUrl,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    registerNativeIntegrationHandlers({
        getStellaAppDir: lifecycle.getStellaDataDir,
        requestExternalOAuthApproval: (payload) => services.connectorOAuthService.requestExternalOAuthApproval(payload),
        getAuthToken: () => services.authService.getAuthToken(),
        getBackendUrl: () => services.authService.getBackendUrl(),
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
    });
    // Drafts, undo and fork sync for the app's own checkout. Every install is
    // a checkout, so this is unconditional. Deferred startup starts it.
    if (!state.appSourceService) {
        // How a change shows on screen: a picture transition for renderer
        // changes, a frosted hold across a relaunch.
        const updateTransition = state.updateTransition ?? new UpdateTransition({
            getWindow: () => state.windowManager?.getFullWindow() ?? null,
            partition: config.sessionPartition,
            holdDir: app.getPath("userData"),
            holdLabel: () => t("desktop.update.holding"),
            onHold: holdForRelaunch,
            log: (event, data) => getMainLogger()?.process(event, data),
        });
        state.updateTransition = updateTransition;
        const appSourceService = new AppSourceService({
            stellaAppDir: state.stellaAppDir ?? config.stellaAppDir,
            broadcast: (next) => {
                // An update is waiting: load the transition's overlay now so
                // pressing Update doesn't pay for it.
                if (next.ready.length > 0 ||
                    next.remote.status === "ahead" ||
                    next.upstream.status === "ahead") {
                    updateTransition.prewarm();
                }
                for (const window of getAllWindows(context)) {
                    if (!window.isDestroyed()) {
                        window.webContents.send(IPC_APP_SOURCE_STATE, next);
                    }
                }
            },
            isAnyWindowVisible: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible() && !window.isMinimized()),
            requestRuntimeRestart: () => state.stellaHostRunner?.requestRuntimeRestart(),
            applyRendererChanges: (paths) => state.rendererSource?.applyChanges(paths),
            coverRenderer: () => updateTransition.cover(),
            beforeRelaunch: () => updateTransition.holdForRelaunch(),
            relaunch: relaunchApp,
            // Checking a merged update happens on a scratch worktree here,
            // never in the checkout that is running.
            updateScratchDir: path.join(app.getPath("userData"), "update-merge"),
            // Git work that needs a judgement goes straight to a background
            // agent with what the app already knows. No user message is
            // synthesized for it: the user pressed a button, they did not
            // type a request, and nothing should file one against them.
            dispatchAgentBrief: async (brief) => {
                const runner = lifecycle.getRunner();
                const conversationId = services.uiStateService.state.conversationId;
                if (!runner || !conversationId) {
                    throw new Error("Stella isn't ready to install this update yet.");
                }
                await runner.createBackgroundAgent({
                    conversationId,
                    description: brief.description,
                    prompt: brief.prompt,
                    agentType: "general",
                });
            },
            hasConnectedAccount: () => services.authService.getHostHasConnectedAccount(),
            getBackendUrl: () => services.authService.getBackendUrl(),
            getAuthToken: () => services.authService.getAuthToken(),
            log: (event, data) => getMainLogger()?.process(event, data),
            // Under the native launcher, only signed trees run: refuse to act
            // on an unsigned HEAD and sign every change that lands. Both are
            // no-ops when Stella runs without the launcher.
            beforeAction: assertHeadSigned,
            afterApply: signHead,
            // A push that changed the UI rebuilds the owner's browser renderer.
            onPushed: (cwd) => buildAndUploadWebRenderer(cwd, {
                getBackendUrl: () => services.authService.getBackendUrl(),
                getAuthToken: () => services.authService.getAuthToken(),
                log: (event, data) => getMainLogger()?.process(event, data),
            }),
        });
        state.appSourceService = appSourceService;
        state.processRuntime.registerCleanup("will-quit", "app-source", () => {
            appSourceService.dispose();
        });
    }
    registerAppSourceHandlers({
        getService: () => state.appSourceService ?? null,
        appPartition: config.sessionPartition,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
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
    const voice = registerVoiceHandlers({
        uiState: services.uiStateService.state,
        getAppReady: () => state.appReady,
        windowManager: state.windowManager,
        broadcastUiState: () => services.uiStateService.broadcast(),
        toggleRealtimeVoice: toggleRealtimeVoiceImpl,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
        getStellaHostRunner: lifecycle.getRunner,
        onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
        getOverlayController: () => state.overlayController ?? null,
        getActiveCloudConversationCacheAuthority: () => services.localChatHistoryService.getActiveCloudConversationCacheAuthority(),
        stellaAppDir: state.stellaAppDir,
        stellaDataDirPath: state.stellaDataDirPath,
    });
    const dictationTap = registerDictationHandlers({
        windowManager: state.windowManager,
        stellaAppDir: config.stellaAppDir,
        getCompanionController: () => state.companionController ?? null,
        getStellaDataDir: lifecycle.getStellaDataDir,
        assertPrivilegedSender: (event, channel) => services.externalLinkService.assertPrivilegedSender(event, channel),
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
    handleIpc(IPC_PREFERENCES_GET_WAKE_WORD, (event) => {
        if (!services.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_WAKE_WORD)) {
            throw new Error("Blocked untrusted preferences:getWakeWord request.");
        }
        const root = lifecycle.getStellaDataDir();
        if (!root)
            return false;
        return loadLocalPreferences(root).wakeWordEnabled;
    });
    handleIpc(IPC_PREFERENCES_SET_WAKE_WORD, (event, enabled) => {
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
    // What a paired phone may ask of this computer through the cloud relay
    // (the runtime host's `serveDeviceRequest`), under the same policy the
    // handlers above apply to a remote caller.
    state.deviceRequestHandlers = {
        readFile: display.readFileForRequest,
        readThumbnail: display.readThumbnailForRequest,
        renderOfficePreview: officePreview.renderForRequest,
        voiceConfig: voice.configForRequest,
        voiceExecuteTool: voice.executeToolForRequest,
    };
};
