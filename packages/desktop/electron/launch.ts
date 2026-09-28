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
import { app } from "electron";

// Persist once startup has settled rather than only at exit: a crash or a
// force-kill before a clean quit would otherwise drop the whole cache.
const COMPILE_CACHE_FLUSH_DELAY_MS = 15_000;
const PACKAGED_COMPILE_CACHE_DIR_NAME = "Main Compile Cache";

const enableMainCompileCache = (): void => {
  try {
    // Packaged builds keep the cache in their own userData so it survives
    // reboots and temp cleaners. Development uses Node's default temp
    // location rather than creating a profile under the pre-rename app name.
    if (app.isPackaged) {
      enableCompileCache(
        path.join(app.getPath("userData"), PACKAGED_COMPILE_CACHE_DIR_NAME),
      );
    } else {
      enableCompileCache();
    }
  } catch {
    // Startup must never depend on the cache.
  }
};

/**
 * Node versions each cache under a `v<node>-<arch>-<hash>` subdirectory, so an
 * Electron upgrade leaves the previous one behind. Only the packaged cache
 * root is Stella-owned; the shared development temp root is left alone.
 */
const pruneStaleCompileCacheVersions = async (activeDir: string) => {
  const root = path.dirname(activeDir);
  if (path.basename(root) !== PACKAGED_COMPILE_CACHE_DIR_NAME) {
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
