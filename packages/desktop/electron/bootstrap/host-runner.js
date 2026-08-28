import { app } from "electron";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { clearSupersededDeviceId as clearStoredSupersededDeviceId, getOrCreateDeviceIdentity, resetDeviceIdentity as resetStoredDeviceIdentity, signDeviceHeartbeat, } from "@stella/runtime/kernel/home/device";
import { getSoundNotificationsEnabled } from "@stella/runtime/kernel/preferences/local-preferences";
import { deleteConnectorAccessTokens, loadConnectorTokenPayload, saveConnectorTokenPayload, } from "@stella/runtime/kernel/connectors/oauth";
import { ensureStellaDataDirSeeded } from "@stella/runtime/kernel/home/stella-home";
import { createStellaHostRunner, } from "../stella-host-runner.js";
import { broadcastLocalChatUpdated, broadcastThreadActivityUpdated, broadcastScheduleUpdated, broadcastUserAppsUpdated, broadcastToWindows, } from "./context.js";
import { startOfficePreviewBridge } from "./office-preview-bridge.js";
import { showStellaNotification } from "../services/notification-service.js";
import { getActiveBrowserTabForBundleId } from "../active-browser-tab.js";
import { listRecentApps } from "../recent-apps.js";
import { requestMacPermission } from "../utils/macos-permissions.js";
import { getMainLogger } from "../observability/main-logger.js";
import { getLocalLlmCredential, listLocalLlmCredentials, } from "@stella/runtime/kernel/storage/llm-credentials";
import { getLocalLlmOAuthApiKey, listLocalLlmOAuthCredentials, } from "@stella/runtime/kernel/storage/llm-oauth-credentials";
import { retireDetachedWorkerRoot } from "@stella/runtime/host";

let stellaDataDirSeedingPromise = null;
const ensureStellaDataDirSeededOnce = (stellaAppDir, stellaDataDirPath) => {
    if (!stellaDataDirSeedingPromise) {
        const attempt = ensureStellaDataDirSeeded(stellaAppDir, stellaDataDirPath);
        stellaDataDirSeedingPromise = attempt;
        void attempt.catch(() => {
            if (stellaDataDirSeedingPromise === attempt) {
                stellaDataDirSeedingPromise = null;
            }
        });
    }
    return stellaDataDirSeedingPromise;
};

const spawnAutomationDaemonFromHost = async (params) => {
    if (process.platform === "win32") {
        return { ok: false, reason: "unsupported_platform" };
    }
    const daemonSocketPath = typeof params?.daemonSocketPath === "string" ? params.daemonSocketPath : "";
    const pidPath = typeof params?.pidPath === "string" ? params.pidPath : "";
    const logPath = typeof params?.logPath === "string" ? params.logPath : "";
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    const stateDir = typeof params?.stateDir === "string" ? params.stateDir : "";
    if (!daemonSocketPath ||
        !pidPath ||
        !logPath ||
        !sessionId ||
        !stateDir ||
        !path.isAbsolute(daemonSocketPath) ||
        !path.isAbsolute(pidPath) ||
        !path.isAbsolute(logPath)) {
        return { ok: false, reason: "invalid_params" };
    }

    const helperPath = resolveNativeHelperPath("desktop_automation");
    if (!helperPath) {
        return { ok: false, reason: "helper_not_found" };
    }
    const extraEnv = Object.fromEntries(Object.entries(params?.env && typeof params.env === "object" ? params.env : {}).filter(([key, value]) => key.startsWith("STELLA_COMPUTER_") && typeof value === "string"));
    let logFd;
    try {
        mkdirSync(path.dirname(logPath), { recursive: true });
        logFd = openSync(logPath, "a");
    }
    catch (error) {
        return { ok: false, reason: `log_open_failed: ${error?.message ?? error}` };
    }
    try {
        const child = spawn(helperPath, ["daemon", "--socket-path", daemonSocketPath, "--pid-file", pidPath], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: {
                ...process.env,
                ...extraEnv,
                STELLA_COMPUTER_SESSION: sessionId,
                STELLA_COMPUTER_STATE_DIR: stateDir,
            },
        });
        await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
        child.unref();
        getMainLogger()?.process?.("computer-use.automation-daemon.spawned", {
            pid: child.pid,
            sessionId,
        });
        return { ok: true, pid: child.pid ?? -1, hostPid: process.pid };
    }
    catch (error) {
        return { ok: false, reason: `spawn_failed: ${error?.message ?? error}` };
    }
    finally {
        closeSync(logFd);
    }
};
export const createHostRunnerHandlers = (context, options) => ({
    getActiveConversationId: () => context.services.uiStateService.state.conversationId?.trim() || null,
    getDeviceIdentity: async () => {
        const identity = await options.loadDeviceIdentity();
        return {
            deviceId: identity.deviceId,
            publicKey: identity.publicKey,
            ...(identity.supersededDeviceId
                ? { supersededDeviceId: identity.supersededDeviceId }
                : {}),
        };
    },
    resetDeviceIdentity: async () => {
        const identity = await options.resetDeviceIdentity();
        context.state.deviceId = identity.deviceId;
        return {
            deviceId: identity.deviceId,
            publicKey: identity.publicKey,
            ...(identity.supersededDeviceId
                ? { supersededDeviceId: identity.supersededDeviceId }
                : {}),
        };
    },
    clearSupersededDeviceId: async () => {
        await options.clearSupersededDeviceId();
    },
    signHeartbeatPayload: async (signedAtMs) => {
        const identity = await options.loadDeviceIdentity();
        return {
            publicKey: identity.publicKey,
            signature: signDeviceHeartbeat(identity, signedAtMs),
        };
    },
    requestRuntimeAuthRefresh: async () => await context.services.authService.refreshRuntimeAuth(),
    getScheduleScriptAuth: async () => await context.services.authService.getScheduleScriptAuth(),
    getAppBrowserContext: async () => {
        const apps = (await listRecentApps(3)) ?? [];
        const activeApp = apps.find((app) => app.isActive && app.bundleId);
        const activeBrowserTab = activeApp?.bundleId
            ? await getActiveBrowserTabForBundleId(activeApp.bundleId)
            : null;
        return {
            apps: apps.map((app) => ({
                name: app.name,
                pid: app.pid,
                isActive: app.isActive,
                ...(app.bundleId ? { bundleId: app.bundleId } : {}),
                ...(app.windowTitle ? { windowTitle: app.windowTitle } : {}),
            })),
            activeBrowserTab,
        };
    },
    requestCredential: (payload) => context.services.credentialService.requestCredential(payload),
    requestLlmCredentials: async (request) => {
        const stellaDataDir = context.state.stellaDataDirPath;
        if (!stellaDataDir) {
            return { ok: false, reason: "stella_data_dir_unavailable" };
        }
        if (request.operation === "list") {
            return {
                ok: true,
                apiKeyProviders: listLocalLlmCredentials(stellaDataDir).map(({ provider }) => provider),
                oauthProviders: listLocalLlmOAuthCredentials(stellaDataDir).map(({ provider }) => provider),
            };
        }
        const value = request.kind === "api-key"
            ? getLocalLlmCredential(stellaDataDir, request.provider)
            : await getLocalLlmOAuthApiKey(stellaDataDir, request.provider);
        return { ok: true, value };
    },
    requestConnectorTokenStore: async (request) => {
        const stellaDataDir = context.state.stellaDataDirPath;
        if (!stellaDataDir) {
            return { ok: false, reason: "stella_data_dir_unavailable" };
        }
        if (request.operation === "load") {
            return {
                ok: true,
                payload: await loadConnectorTokenPayload(stellaDataDir, request.tokenKey),
            };
        }
        if (request.operation === "save") {
            await saveConnectorTokenPayload(stellaDataDir, request.tokenKey, request.payload);
            return { ok: true };
        }
        await deleteConnectorAccessTokens(stellaDataDir, request.tokenKeys);
        return { ok: true };
    },
    requestConnectorCredential: (payload) => payload.preregisteredOAuth
        ? context.services.connectorCredentialService.requestPreregisteredOAuth({
            tokenKey: payload.tokenKey,
            displayName: payload.displayName,
            description: payload.description,
            ...payload.preregisteredOAuth,
        })
        : context.services.connectorCredentialService.requestCredential(payload),
    requestConnectorConnection: (payload) => context.services.connectorConnectService.requestConnection(payload),
    cancelConnectorConnection: async (payload) => context.services.connectorConnectService.cancelByOfferId(payload.offerId),
    requestBrowserExtensionConnect: (payload) => context.services.connectorConnectService.requestBrowserExtensionConnect(payload),
    requestComputerUseAppApproval: (payload) => context.services.securityPolicyService.ensureComputerUseAppApproval(payload),
    displayUpdate: (payload) => {

        broadcastToWindows(context, "display:update", payload);
    },
    showNotification: ({ title, body, sound }) => {
        const stellaAppDir = context.state.stellaAppDir;
        const soundEnabled = stellaAppDir
            ? getSoundNotificationsEnabled(stellaAppDir)
            : true;
        showStellaNotification(context, {
            id: `stella-runtime-${Date.now()}`,
            groupId: "stella-runtime",
            groupTitle: "Stella",
            title,
            body,
            sound: soundEnabled ? sound : undefined,
            silent: !soundEnabled,
        });
    },
    requestDesktopPermission: async (kind) => requestMacPermission(kind),
    spawnAutomationDaemon: (params) => spawnAutomationDaemonFromHost(params),
    openExternal: async (url) => {
        context.services.externalLinkService.openSafeExternalUrl(url);
    },
    showWindow: async () => {
        context.state.windowManager?.showWindow();
    },
    focusWindow: async () => {
        context.state.windowManager?.getFullWindow()?.focus();
    },
});
const clearHostRunnerSubscriptions = (context) => {
    const { state } = context;
    state.localChatUpdateUnsubscribe?.();
    state.localChatUpdateUnsubscribe = null;
    state.threadActivityUpdateUnsubscribe?.();
    state.threadActivityUpdateUnsubscribe = null;
    state.scheduleUpdateUnsubscribe?.();
    state.scheduleUpdateUnsubscribe = null;
    state.userAppsUpdateUnsubscribe?.();
    state.userAppsUpdateUnsubscribe = null;
};
const connectHostRunner = async (context) => {
    const { lifecycle, services, state } = context;
    const runner = lifecycle.getRunner();
    if (!runner) {
        throw new Error("Host runner did not initialize.");
    }
    const pendingConvexUrl = services.authService.getPendingConvexUrl();
    if (pendingConvexUrl) {
        runner.setConvexUrl(pendingConvexUrl);
    }
    runner.setConvexSiteUrl(services.authService.getConvexSiteUrl());
    runner.setHasConnectedAccount(services.authService.getHostHasConnectedAccount());
    runner.setAuthToken(await services.authService.getAuthToken());
    state.localChatUpdateUnsubscribe = runner.onLocalChatUpdated((payload) => {
        broadcastLocalChatUpdated(context, payload);
    });
    state.threadActivityUpdateUnsubscribe = runner.onThreadActivityUpdated((payload) => {
        broadcastThreadActivityUpdated(context, payload);
    });
    state.scheduleUpdateUnsubscribe = runner.onScheduleUpdated(() => {
        broadcastScheduleUpdated(context);
    });
    state.userAppsUpdateUnsubscribe = runner.onProjectsUpdated(() => {
        broadcastUserAppsUpdated(context);
    });
    const logger = getMainLogger();
    const connectBeganAt = Math.round(process.uptime() * 1000);
    logger?.process("startup.host-runner.connect", { elapsedMs: connectBeganAt });
    await runner.start();
    if (context.config.startupRuntimeWarmupDelayMs > 0) {
        logger?.process("startup.host-runner.worker-warmup-delayed", {
            delayMs: context.config.startupRuntimeWarmupDelayMs,
            elapsedMs: Math.round(process.uptime() * 1000),
        });
        const completed = await state.processRuntime.wait(context.config.startupRuntimeWarmupDelayMs);
        if (!completed || state.isQuitting) {
            return;
        }
    }

    await runner.ensureWorkerStarted();
    const workerStartedAt = Math.round(process.uptime() * 1000);
    logger?.process("startup.host-runner.worker-spawned", {
        elapsedMs: workerStartedAt,
        sinceConnectMs: workerStartedAt - connectBeganAt,
    });
    const health = await runner.host.health();
    state.deviceId = health.deviceId;
    const readyAt = Math.round(process.uptime() * 1000);
    logger?.process("startup.host-runner.ready", {
        elapsedMs: readyAt,
        sinceConnectMs: readyAt - connectBeganAt,
    });
};
export const initializeStellaHostRunner = async (context) => {
    const { lifecycle, services, state } = context;
    const stellaAppDir = state.stellaAppDir;
    const stellaDataDirPath = state.stellaDataDirPath;
    if (!stellaAppDir || !stellaDataDirPath || !state.stellaWorkspacePath) {
        throw new Error("Stella root is not initialized.");
    }
    if (app.isPackaged) {
        const legacyStellaAppDir = app.getAppPath();
        if (legacyStellaAppDir !== stellaAppDir) {
            const retired = await retireDetachedWorkerRoot(legacyStellaAppDir);
            if (retired.pid != null) {
                getMainLogger()?.process("startup.host-runner.legacy-root-retired", {
                    pid: retired.pid,
                    stopped: retired.stopped,
                });
            }
        }
    }

    await ensureStellaDataDirSeededOnce(stellaAppDir, stellaDataDirPath);
    await services.securityPolicyService.loadPolicy();
    const loadDeviceIdentity = async () => await getOrCreateDeviceIdentity(stellaDataDirPath);

    const resetDeviceIdentity = async () => await resetStoredDeviceIdentity(stellaDataDirPath, { preservePairings: true });
    const clearSupersededDeviceId = async () => await clearStoredSupersededDeviceId(stellaDataDirPath);
    clearHostRunnerSubscriptions(context);
    context.state.officePreviewBridgeStop?.();
    context.state.officePreviewBridgeStop = null;
    await lifecycle.getRunner()?.stop();
    lifecycle.setRunner(createStellaHostRunner({
        initializeParams: {
            clientName: "stella-electron-host",
            clientVersion: app.getVersion(),
            isDev: context.config.useDevServer,
            platform: process.platform,
            stellaAppDir,
            stellaDataDirPath,
            stellaWorkspacePath: state.stellaWorkspacePath,
        },
        hostHandlers: createHostRunnerHandlers(context, {
            loadDeviceIdentity,
            resetDeviceIdentity,
            clearSupersededDeviceId,
        }),
    }));
    await connectHostRunner(context);
    if (state.appReady && !state.officePreviewBridgeStop) {
        state.officePreviewBridgeStop = startOfficePreviewBridge(context);
    }
};
