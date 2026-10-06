/**
 * Electron main-process entry (package.json "main").
 *
 * The real entry, `main.js`, is one ~13MB esbuild bundle. Without a code cache
 * V8 re-parses and re-compiles all of it on every launch before `ready` can
 * fire. Node's compile cache persists the code V8 produces when it compiles
 * each module loaded after the cache is enabled, so it has to be switched on
 * here, in a tiny module that runs before the bundle is compiled. Cache
 * entries are keyed by file path and validated against the source hash, so an
 * update simply recompiles once and rewrites them.
 *
 * `NODE_DISABLE_COMPILE_CACHE=1` turns the cache off without a rebuild.
 */
import {
  enableCompileCache,
  flushCompileCache,
  getCompileCacheDir,
} from "node:module";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

// Persist once startup has settled rather than only at exit: a crash or a
// force-kill before a clean quit would otherwise drop the whole cache.
const COMPILE_CACHE_FLUSH_DELAY_MS = 15_000;
const COMPILE_CACHE_DIR_NAME = "Main Compile Cache";

const enableMainCompileCache = (): void => {
  try {
    // Node's default temp location, in every install. Stella's own userData
    // would survive temp cleaners, but this module runs before the bundle it
    // loads, and it is that bundle (bootstrap) which renames the app and points
    // userData at Stella's profile: `app.getPath("userData")` here is still the
    // pre-rename default and would plant a stray profile directory. This was an
    // `app.isPackaged` branch that no install has taken since packaging was
    // removed; moving the cache needs a path the launcher hands us, and this
    // module may not import one to derive it (electron/launch.js must inline
    // nothing — see assertMainBundleStartupBoundary).
    enableCompileCache();
  } catch {
    // Startup must never depend on the cache.
  }
};

/**
 * Node versions each cache under a `v<node>-<arch>-<hash>` subdirectory, so an
 * Electron upgrade leaves the previous one behind. Only Stella's own cache root
 * is pruned; the shared development temp root is left alone.
 */
const pruneStaleCompileCacheVersions = async (activeDir: string) => {
  const root = path.dirname(activeDir);
  if (path.basename(root) !== COMPILE_CACHE_DIR_NAME) {
    return;
  }
  const activeName = path.basename(activeDir);
  const entries = await readdir(root);
  await Promise.all(
    entries
      .filter((entry) => entry !== activeName)
      .map((entry) =>
        rm(path.join(root, entry), { recursive: true, force: true }),
      ),
  );
};

enableMainCompileCache();

// Electron holds `ready` until an ESM entry, including its top-level await,
// has finished evaluating, so awaiting the bundle here keeps the ordering of
// loading it directly: its top level still runs entirely before `ready`.
// The specifier is computed so esbuild leaves the bundle as a separate file.
await import(new URL("./main.js", import.meta.url).href);

// The versioned directory actually in use; undefined when the cache is off.
const compileCacheDir = getCompileCacheDir();
if (compileCacheDir) {
  setTimeout(() => {
    try {
      flushCompileCache();
    } catch {
      // Best-effort; Node also persists pending entries at exit.
    }
    void pruneStaleCompileCacheVersions(compileCacheDir).catch(() => {});
  }, COMPILE_CACHE_FLUSH_DELAY_MS).unref();
}
