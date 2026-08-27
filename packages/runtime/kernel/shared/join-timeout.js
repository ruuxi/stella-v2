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
