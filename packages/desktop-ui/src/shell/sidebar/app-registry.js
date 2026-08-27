const APP_MODULES = import.meta.glob("../../app/*/metadata.ts", { eager: true });
const computeSnapshot = (modules) => Object.values(modules)
    .map((m) => m.default)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
let cachedSnapshot = computeSnapshot(APP_MODULES);
const subscribers = new Set();
export const subscribe = (cb) => {
    subscribers.add(cb);
    return () => {
        subscribers.delete(cb);
    };
};

export const getSnapshot = () => cachedSnapshot;
if (import.meta.hot) {
    import.meta.hot.accept((newModule) => {
        if (!newModule)
            return;

        const next = newModule.getSnapshot?.();
        if (!next)
            return;
        cachedSnapshot = next;
        for (const cb of subscribers) {
            try {
                cb();
            }
            catch {

            }
        }
    });
}
