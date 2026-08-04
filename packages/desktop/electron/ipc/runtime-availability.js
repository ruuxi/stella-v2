import { createRuntimeUnavailableError } from "@stella/contracts/protocol/rpc-peer";
export const waitForConnectedRunner = async (getStellaHostRunner, { timeoutMs = 10_000, unavailableMessage = "Runtime not available.", onRunnerChanged, } = {}) => {
    return await new Promise((resolve, reject) => {
        let timeout = null;
        let unsubscribeRunner = null;
        let unsubscribeAvailability = null;
        let lastError = null;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            unsubscribeAvailability?.();
            unsubscribeAvailability = null;
            unsubscribeRunner?.();
            unsubscribeRunner = null;
        };
        const tryResolve = (runner) => {
            if (!runner) {
                return false;
            }
            const snapshot = runner.getAvailabilitySnapshot();
            if (!snapshot.connected) {
                if (snapshot.reason) {
                    lastError = createRuntimeUnavailableError(snapshot.reason);
                }
                return false;
            }
            cleanup();
            resolve(runner);
            return true;
        };
        const attachRunner = (runner) => {
            unsubscribeAvailability?.();
            unsubscribeAvailability = null;
            if (tryResolve(runner) || !runner) {
                return;
            }
            unsubscribeAvailability = runner.onAvailabilityChange((snapshot) => {
                if (snapshot.reason) {
                    lastError = createRuntimeUnavailableError(snapshot.reason);
                }
                if (runner !== getStellaHostRunner()) {
                    return;
                }
                if (!snapshot.connected) {
                    return;
                }
                cleanup();
                resolve(runner);
            });
        };
        timeout = setTimeout(() => {
            cleanup();
            reject(lastError ?? createRuntimeUnavailableError(unavailableMessage));
        }, timeoutMs);
        unsubscribeRunner = onRunnerChanged?.((runner) => {
            attachRunner(runner);
        }) ?? null;
        attachRunner(getStellaHostRunner());
    });
};
