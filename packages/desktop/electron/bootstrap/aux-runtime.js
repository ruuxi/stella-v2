import { createStellaBrowserBridgeResource } from "../process-resources/browser-bridge-resource.js";
import { broadcastStellaBrowserBridgeStatus, } from "./context.js";
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
