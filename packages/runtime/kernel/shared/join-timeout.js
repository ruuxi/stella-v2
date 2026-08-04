/**
 * Bounded join for shutdown paths. Interruption is always delivered first
 * by the caller (the kill ladder / scope close); this only caps how long we
 * wait for a wedged native promise that no JavaScript runtime can
 * force-kill. Returns `"joined"` when the promise settled in time,
 * `"timeout"` otherwise.
 */
const settleSilently = (promise) => promise.then(() => undefined, () => undefined);
export const joinWithTimeout = async (promise, timeoutMs, onTimeout) => {
    let timer = null;
    try {
        const result = await Promise.race([
            settleSilently(promise).then(() => "joined"),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve("timeout"), timeoutMs);
                timer.unref?.();
            }),
        ]);
        if (result === "timeout")
            onTimeout?.();
        return result;
    }
    finally {
        if (timer !== null)
            clearTimeout(timer);
    }
};
