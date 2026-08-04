import { isMobileBridgeEventChannel } from "../services/mobile-bridge/index.js";
import { MobileBridgeService } from "../services/mobile-bridge/service.js";
import { createCloudflareTunnelResource, } from "./cloudflare-tunnel-resource.js";
const AUTH_SYNC_INTERVAL_MS = 30_000;
/**
 * How long the bridge server + Cloudflare tunnel stay up with no phone
 * activity. This used to be 10 minutes, which meant nearly every app-open on
 * the phone paid the full cold path (cloudflared spawn, edge registration,
 * readiness probing, registration lease — 8-30s). Idle cost of keeping it up
 * is small (cloudflared ~20-40 MB RSS, a keepalive connection, no CPU), the
 * hostname is already public/stable, and sessions still expire on their own
 * TTL — so we keep the transport warm for half a day and let truly dormant
 * desktops wind down.
 */
const MOBILE_SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60_000;
const WINDOW_RETRY_DELAY_MS = 1_000;
const PORT_RETRY_DELAY_MS = 500;
export const createMobileBridgeResource = (options) => {
    let bridge = null;
    let tunnel = null;
    let stopped = true;
    let sessionId = 0;
    let stopAuthSync = null;
    let stopSessionTimer = null;
    let mirroredWindow = null;
    let restoreWindowSend = null;
    const createTunnel = () => {
        tunnel = createCloudflareTunnelResource({
            processRuntime: options.processRuntime,
            getAuthToken: options.getAuthToken,
            getConvexSiteUrl: options.getConvexSiteUrl,
            getDeviceId: options.getDeviceId,
            onTunnelUrl: (url) => {
                bridge?.setTunnelUrl(url);
            },
        });
    };
    const clearWindowMirror = () => {
        restoreWindowSend?.();
        restoreWindowSend = null;
        mirroredWindow = null;
    };
    const rearmSessionTimer = () => {
        stopSessionTimer?.();
        stopSessionTimer = options.processRuntime.setManagedTimeout(() => {
            void resource.stop();
        }, MOBILE_SESSION_IDLE_TIMEOUT_MS);
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
            onClientActivity: rearmSessionTimer,
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
            rearmSessionTimer();
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
            stopSessionTimer?.();
            stopSessionTimer = null;
            clearWindowMirror();
            await tunnel?.stop();
            tunnel = null;
            bridge?.stop();
            bridge = null;
        },
    };
    return resource;
};
