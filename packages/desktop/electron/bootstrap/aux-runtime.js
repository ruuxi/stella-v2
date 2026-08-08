import { getDevServerUrl } from "../renderer-location.js";
import { buildMobileBridgeBootstrap } from "../services/mobile-bridge/bootstrap-payload.js";
import { createStellaBrowserBridgeResource } from "../process-resources/browser-bridge-resource.js";
import { createMobileBridgeResource } from "../process-resources/mobile-bridge-resource.js";
import { broadcastStellaBrowserBridgeStatus, } from "./context.js";
const readMobileBridgeBootstrap = async (context) => {
    return buildMobileBridgeBootstrap(context.state.uiStateKvStore?.snapshot() ?? {});
};
export const startMobileBridge = (context) => {
    try {
        if (context.state.mobileBridgeResource) {
            context.state.mobileBridgeResource.start();
            return;
        }
        const resource = createMobileBridgeResource({
            electronDir: context.config.electronDir,
            isDev: context.config.useDevServer,
            getAuthToken: () => context.services.authService.getAuthToken(),
            getBootstrapPayload: () => readMobileBridgeBootstrap(context),
            getConvexUrl: () => context.services.authService.getPendingConvexUrl(),
            getConvexSiteUrl: () => context.services.authService.getConvexSiteUrl(),
            getDeviceId: () => context.state.deviceId,
            getDevServerUrl: () => getDevServerUrl() ?? "",
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
