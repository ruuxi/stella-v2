const META_MODULES = import.meta.glob("./*.tsx", {
    eager: true,
    import: "meta",
});
const LAZY_MODULES = import.meta.glob("./*.tsx");
const slugFromPath = (path) => path.replace(/^\.\//, "").replace(/\.tsx$/, "");
const isValidMeta = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (typeof candidate.label === "string" &&
        typeof candidate.createdAt === "string");
};
const computeSnapshot = () => {
    const apps = [];
    for (const [path, meta] of Object.entries(META_MODULES)) {
        if (!isValidMeta(meta))
            continue;
        const slug = slugFromPath(path);
        const loader = LAZY_MODULES[path];
        if (!loader)
            continue;
        apps.push({ slug, meta, load: loader });
    }
    apps.sort((a, b) => a.slug.localeCompare(b.slug));
    return apps;
};
let cachedSnapshot = computeSnapshot();
const subscribers = new Set();
export const subscribe = (cb) => {
    subscribers.add(cb);
    return () => {
        subscribers.delete(cb);
    };
};
export const getSnapshot = () => cachedSnapshot;
export const getUserApp = (slug) => cachedSnapshot.find((app) => app.slug === slug);
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
                // Subscribers must never break the registry.
            }
        }
    });
}
