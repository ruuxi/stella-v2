/**
 * Reactive registry of top-bar nav apps discovered from
 * `desktop/src/app/<id>/metadata.ts` files via `import.meta.glob`.
 *
 * The glob lives here (not in `ShellTopBarNav.tsx`) so that adding a new
 * `metadata.ts` file invalidates only this leaf module rather than
 * propagating up through the shell to `__root.tsx`. The HMR accept handler
 * below catches the invalidation, recomputes the snapshot, and notifies
 * subscribers via `useSyncExternalStore` -- no full renderer reload, no
 * lost React state for the create-app case.
 *
 * `ShellTopBarNav.tsx` reads via `useSyncExternalStore(subscribe, getSnapshot)`.
 *
 * Production builds: `import.meta.hot` is undefined, so the accept block
 * is a no-op. The snapshot is computed once at module load and never
 * changes -- which is correct for a production build.
 */
import type { AppMetadata } from "@/app/_shared/app-metadata";

type AppMetadataModule = { default: AppMetadata };

const APP_MODULES = import.meta.glob<AppMetadataModule>(
  "../../app/*/metadata.ts",
  { eager: true },
);
const computeSnapshot = (
  modules: Record<string, AppMetadataModule>,
): AppMetadata[] =>
  Object.values(modules)
    .map((m) => m.default)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
let cachedSnapshot = computeSnapshot(APP_MODULES);
const subscribers = new Set<() => void>();
export const subscribe = (cb: () => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};
/**
 * Returns the current registered apps. Reference is stable until the
 * underlying glob actually changes (HMR), satisfying React's
 * `useSyncExternalStore` invariant.
 */
export const getSnapshot = (): AppMetadata[] => cachedSnapshot;
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    if (!newModule) return;
    // Re-evaluating the new module's `APP_MODULES` is the safest way to
    // pick up additions/removals: Vite's `importGlob` plugin re-globs
    // the filesystem when its `hotUpdate` runs, so the new module's
    // exports reflect the updated set. Recomputing the snapshot from the
    // new module ensures stable reference semantics for the consumer.
    const next = (
      newModule as { getSnapshot?: () => AppMetadata[] }
    ).getSnapshot?.();
    if (!next) return;
    cachedSnapshot = next;
    for (const cb of subscribers) {
      try {
        cb();
      } catch {
        // Subscribers throwing should never break the registry.
      }
    }
  });
}
