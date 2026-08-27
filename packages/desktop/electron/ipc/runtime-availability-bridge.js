import { webContents } from "electron";
import { IPC_PREFERENCES_MODELS_UPDATED, IPC_RUNTIME_AVAILABILITY, } from "@stella/contracts/desktop/ipc-channels";

export const registerRuntimeAvailabilityBridge = ({ getStellaHostRunner, onStellaHostRunnerChanged, }) => {
    let unsubscribeFromRunner = null;
    let unsubscribeFromModelCatalog = null;
    let lastSnapshotKey = null;
    const broadcast = (snapshot) => {
        const snapshotKey = JSON.stringify(snapshot);
        if (lastSnapshotKey === snapshotKey) {
            return;
        }
        lastSnapshotKey = snapshotKey;
        for (const wc of webContents.getAllWebContents()) {
            if (wc.isDestroyed())
                continue;
            try {
                wc.send(IPC_RUNTIME_AVAILABILITY, snapshot);
            }
            catch {

            }
        }
    };
    const attach = (runner) => {
        unsubscribeFromRunner?.();
        unsubscribeFromRunner = null;
        unsubscribeFromModelCatalog?.();
        unsubscribeFromModelCatalog = null;
        if (!runner)
            return;
        broadcast(runner.getAvailabilitySnapshot());
        unsubscribeFromRunner = runner.onAvailabilityChange((snapshot) => {
            broadcast(snapshot);
        });
        unsubscribeFromModelCatalog = runner.onModelCatalogUpdated((snapshot) => {
            for (const wc of webContents.getAllWebContents()) {
                if (wc.isDestroyed())
                    continue;
                try {
                    wc.send(IPC_PREFERENCES_MODELS_UPDATED, snapshot);
                }
                catch {

                }
            }
        });
    };
    attach(getStellaHostRunner());
    const unsubscribeFromLifecycle = onStellaHostRunnerChanged((runner) => {
        attach(runner);
    });
    return () => {
        unsubscribeFromRunner?.();
        unsubscribeFromRunner = null;
        unsubscribeFromModelCatalog?.();
        unsubscribeFromModelCatalog = null;
        unsubscribeFromLifecycle();
    };
};
