import path from "path";
import { buildMobileBridgeBootstrap } from "../services/mobile-bridge/bootstrap-payload.js";
import { createStellaBrowserBridgeResource } from "../process-resources/browser-bridge-resource.js";
import { broadcastStellaBrowserBridgeStatus, } from "./context.js";
const readMobileBridgeBootstrap = async (context) => {
    return buildMobileBridgeBootstrap(context.state.uiStateKvStore?.snapshot() ?? {});
};
// The mobile bridge (bridge service, crypto, cloudflared tunnel installer) only
// runs once the user starts a phone-access session, so its module graph loads
// on that first start instead of with bootstrap.
let mobileBridgeModulePromise = null;
// Bumped by stopMobileBridge so a stop that lands while the first start is
// still loading the module wins, as it did when the start was synchronous.
let mobileBridgeStopEpoch = 0;
const loadMobileBridgeModule = () => {
    mobileBridgeModulePromise ??= import("../process-resources/mobile-bridge-resource.js");
    return mobileBridgeModulePromise;
};
export const startMobileBridge = async (context) => {
    try {
        if (context.state.mobileBridgeResource) {
            context.state.mobileBridgeResource.start();
            return;
        }
        const stopEpoch = mobileBridgeStopEpoch;
        const { createMobileBridgeResource } = await loadMobileBridgeModule();
        if (stopEpoch !== mobileBridgeStopEpoch || context.state.isQuitting) {
            return;
        }
        // A concurrent start may have created the resource while this one
        // awaited the module.
        if (context.state.mobileBridgeResource) {
            context.state.mobileBridgeResource.start();
            return;
        }
        const resource = createMobileBridgeResource({
            getAuthToken: () => context.services.authService.getAuthToken(),
            getBootstrapPayload: () => readMobileBridgeBootstrap(context),
            getConvexUrl: () => context.services.authService.getPendingConvexUrl(),
            getConvexSiteUrl: () => context.services.authService.getConvexSiteUrl(),
            getDeviceId: () => context.state.deviceId,
            // `~/.stella/bin` — writable and untouched by app updates, unlike
            // the cloudflared package's own default path inside `app.asar`.
            getCloudflaredBinDir: () => context.state.stellaDataDirPath
                ? path.join(context.state.stellaDataDirPath, "bin")
                : null,
            getFullWindow: () => context.state.windowManager?.getFullWindow() ?? null,
            processRuntime: context.state.processRuntime,
        });
        context.state.mobileBridgeResource = resource;
        resource.start();
    }
    catch (error) {
        console.error("[mobile-bridge] Failed to start:", error.message);
    }
};
export const stopMobileBridge = async (context) => {
    mobileBridgeStopEpoch += 1;
    if (!context.state.mobileBridgeResource) {
        return;
    }
    await context.state.mobileBridgeResource.stop();
};
export const startStellaBrowserBridge = (context) => {
    if (context.state.stellaBrowserBridgeService) {
        context.state.stellaBrowserBridgeService.start();
        return;
    }
    const service = createStellaBrowserBridgeResource({
        stellaAppDir: context.config.stellaAppDir,
        processRuntime: context.state.processRuntime,
        onStatus: (status) => {
            broadcastStellaBrowserBridgeStatus(context, status);
        },
    });
    context.state.stellaBrowserBridgeService = service;
    service.start();
};
