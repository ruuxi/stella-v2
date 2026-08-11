import { isMobileBridgeEventChannel } from "../services/mobile-bridge/index.js";
import { MobileBridgeService } from "../services/mobile-bridge/service.js";
import { createCloudflareTunnelResource, } from "./cloudflare-tunnel-resource.js";
const AUTH_SYNC_INTERVAL_MS = 30_000;
const WINDOW_RETRY_DELAY_MS = 1_000;
const PORT_RETRY_DELAY_MS = 500;
export const createMobileBridgeResource = (options) => {
    let bridge = null;
    let tunnel = null;
    let stopped = true;
    let sessionId = 0;
    let stopAuthSync = null;
    let mirroredWindow = null;
    let restoreWindowSend = null;
    const createTunnel = () => {
        tunnel = createCloudflareTunnelResource({
            processRuntime: options.processRuntime,
            getAuthToken: options.getAuthToken,
            getConvexSiteUrl: options.getConvexSiteUrl,
            getDeviceId: options.getDeviceId,
            getCloudflaredBinDir: options.getCloudflaredBinDir,
            onTunnelUrl: (url, readiness) => {
                bridge?.setTunnelUrl(url, readiness);
            },
        });
    };
    const clearWindowMirror = () => {
        restoreWindowSend?.();
        restoreWindowSend = null;
        mirroredWindow = null;
    };
    const isInactiveSession = (candidateSessionId) => {
        return (stopped ||
            sessionId !== candidateSessionId ||
            options.processRuntime.isShuttingDown() ||
            !bridge);
    };
    const syncBridgeAuth = async (candidateSessionId) => {
        if (isInactiveSession(candidateSessionId)) {
            return;
        }
        const activeBridge = bridge;
        if (!activeBridge) {
            return;
        }
        activeBridge.setDeviceId(options.getDeviceId());
        activeBridge.setHostAuthToken(await options.getAuthToken());
        activeBridge.setConvexDeploymentUrl(options.getConvexUrl());
        activeBridge.setConvexSiteUrl(options.getConvexSiteUrl());
    };
    const attachWindowMirror = (candidateSessionId) => {
        if (isInactiveSession(candidateSessionId)) {
            return;
        }
        const window = options.getFullWindow();
        if (!window || window.isDestroyed()) {
            options.processRuntime.setManagedTimeout(() => {
                attachWindowMirror(candidateSessionId);
            }, WINDOW_RETRY_DELAY_MS);
            return;
        }
        if (mirroredWindow === window) {
            return;
        }
        clearWindowMirror();
        const originalSend = window.webContents.send.bind(window.webContents);
        window.webContents.send = ((channel, ...args) => {
            originalSend(channel, ...args);
            if (isMobileBridgeEventChannel(channel)) {
                bridge?.broadcastToMobile(channel, args.length === 1 ? args[0] : args);
            }
        });
        mirroredWindow = window;
        restoreWindowSend = () => {
            if (!window.isDestroyed()) {
                window.webContents.send =
                    originalSend;
            }
            mirroredWindow = null;
        };
        window.once("closed", () => {
            if (mirroredWindow === window) {
                restoreWindowSend = null;
                mirroredWindow = null;
            }
            if (!isInactiveSession(candidateSessionId)) {
                options.processRuntime.setManagedTimeout(() => {
                    attachWindowMirror(candidateSessionId);
                }, WINDOW_RETRY_DELAY_MS);
            }
        });
    };
    const waitForBridgePort = (candidateSessionId) => {
        if (isInactiveSession(candidateSessionId)) {
            return;
        }
        const activeBridge = bridge;
        if (!activeBridge) {
            return;
        }
        const port = activeBridge.getPort();
        if (port) {
            tunnel?.setBridgePort(port);
            tunnel?.start();
            return;
        }
        options.processRuntime.setManagedTimeout(() => {
            waitForBridgePort(candidateSessionId);
        }, PORT_RETRY_DELAY_MS);
    };
    const startBridge = (candidateSessionId) => {
        if (bridge || options.processRuntime.isShuttingDown()) {
            return;
        }
        bridge = new MobileBridgeService({
            electronDir: options.electronDir,
            isDev: options.isDev,
            getDevServerUrl: options.getDevServerUrl,
        });
        bridge.setBootstrapPayloadGetter(options.getBootstrapPayload);
        bridge.start();
        stopAuthSync = options.processRuntime.setManagedInterval(() => {
            void syncBridgeAuth(candidateSessionId);
        }, AUTH_SYNC_INTERVAL_MS);
        void syncBridgeAuth(candidateSessionId);
        attachWindowMirror(candidateSessionId);
        waitForBridgePort(candidateSessionId);
    };
    const resource = {
        broadcastToMobile: (channel, data) => {
            bridge?.broadcastToMobile(channel, data);
        },
        start: () => {
            stopped = false;
            if (bridge || options.processRuntime.isShuttingDown()) {
                return;
            }
            sessionId += 1;
            createTunnel();
            startBridge(sessionId);
        },
        stop: async () => {
            stopped = true;
            sessionId += 1;
            stopAuthSync?.();
            stopAuthSync = null;
            clearWindowMirror();
            await tunnel?.stop();
            tunnel = null;
            bridge?.stop();
            bridge = null;
        },
    };
    return resource;
};
