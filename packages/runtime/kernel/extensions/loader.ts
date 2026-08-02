/**
 * Extension loader - auto-discovers tools, hooks, providers, prompts, and agents
 * from the extensions directory structure.
 */

import { promises as fs } from "fs";
import path from "path";
import { Effect } from "effect";
import type {
  ToolDefinition,
  HookDefinition,
  ProviderDefinition,
  PromptTemplate,
  LoadedExtensions,
  ExtensionFactory,
  ExtensionRegistrationApi,
} from "./types.js";
import type { ExtensionServices } from "./services.js";
import { extractFrontmatter } from "../frontmatter.js";
import { runExtensionEffect, tryExtensionOp } from "./effect-runtime.js";

const log = (...args: unknown[]) =>
  console.error("[stella:extensions]", ...args);
const logError = (...args: unknown[]) =>
  console.error("[stella:extensions]", ...args);

/**
 * Build a cache-busting query suffix for ESM `import()` so the runtime
 * picks up edits to existing extension files on F1 reload.
 *
 * The Node ESM loader caches modules by their full specifier string. A
 * stable `file:///abs/path.ts` URL hits the cache on every reload —
 * even if the file was edited on disk — and `import()` returns the
 * old module record. Appending a query that changes between calls
 * (file mtime + a per-load token) makes each reload's specifier
 * unique while keeping intra-load deduplication intact (two
 * `importModules` invocations during the same `loadExtensions` call
 * share the same loadToken so they don't re-import the same file).
 *
 * Using mtime alone wouldn't help if the user saved twice within the
 * same millisecond; `loadToken` provides a tiebreaker. Querystrings
 * are valid in `file://` URLs and the loader treats different
 * query-stringed specifiers as distinct cache keys.
 *
 * Note: this DOES leak the previous version's module record from the
 * loader cache on every reload — Node ESM exposes no public API to
 * evict a module by URL. Per-session leak ≈ N × (file count under
 * `extensions/**`) where N is the number of reloads. For typical
 * extension authoring (occasional edits, a handful of files) the
 * working set is small. For pathological churn (auto-reload on every
 * keystroke through a watcher, or thousands of files), expect the
 * worker process to grow until restart.
 *
 * Mitigation: {@link loadExtensions} logs a heads-up when the per-
 * worker reload count crosses a threshold so the user has a signal
 * to restart Stella before memory becomes a problem. Bumping the
 * threshold here is fine — the trade-off is "surface a warning the
 * user might care about" vs. "let the leak grow silently."
 */
const cacheBusterEffect = (
  filePath: string,
  loadToken: string,
): Effect.Effect<string> =>
  tryExtensionOp(() => fs.stat(filePath)).pipe(
    Effect.map((stat) => stat.mtimeMs),
    // Falling back to loadToken alone keeps the cache-bust correct
    // even if stat fails for some reason.
    Effect.catch(() => Effect.succeed(0)),
    Effect.map((mtime) => `?v=${mtime}-${loadToken}`),
  );

/** List a directory, reading an unreadable/missing one as empty. */
const readDirOrEmpty = (dir: string): Effect.Effect<string[]> =>
  tryExtensionOp(() => fs.readdir(dir)).pipe(
    Effect.catch(() => Effect.succeed([] as string[])),
  );

/**
 * Dynamically import all matching TypeScript files from a directory.
 * Returns the default export of each file. Per-file failures are logged and
 * skipped (error isolation identical to the pre-Effect loader).
 */
const importModules = <T>(
  dir: string,
  suffix: string,
  loadToken: string,
): Effect.Effect<T[]> =>
  Effect.gen(function* () {
    const results: T[] = [];
    const entries = yield* readDirOrEmpty(dir);

    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const filePath = path.join(dir, entry);
      yield* Effect.gen(function* () {
        // Use file:// URL for cross-platform ESM import compatibility,
        // with a cache-busting query string so F1 reload picks up edits.
        const resolvedPath = path.resolve(filePath);
        const fileUrl =
          `file:///${resolvedPath.replace(/\\/g, "/")}` +
          (yield* cacheBusterEffect(filePath, loadToken));
        const mod = yield* tryExtensionOp(
          () => import(/* @vite-ignore */ fileUrl),
        );
        const definition = mod.default ?? mod;
        if (definition && typeof definition === "object") {
          results.push(definition as T);
          log(`Loaded ${suffix}: ${entry}`);
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logError(`Failed to load ${filePath}:`, (error as Error).message);
          }),
        ),
      );
    }

    return results;
  });

const loadExtensionFactories = (
  baseDir: string,
  loadToken: string,
  services: ExtensionServices,
): Effect.Effect<LoadedExtensions> =>
  Effect.gen(function* () {
    const collected: LoadedExtensions = {
      tools: [],
      hooks: [],
      providers: [],
      prompts: [],
      agents: [],
    };

    const entries = yield* readDirOrEmpty(baseDir);

    for (const entry of entries) {
      if (entry.startsWith(".")) {
        continue;
      }
      const extensionDir = path.join(baseDir, entry);
      const stat = yield* tryExtensionOp(() => fs.stat(extensionDir)).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!stat?.isDirectory()) {
        continue;
      }

      const entryCandidates = ["index.js", "index.ts"].map((fileName) =>
        path.join(extensionDir, fileName),
      );
      let filePath: string | undefined;
      for (const candidate of entryCandidates) {
        const accessible = yield* tryExtensionOp(() =>
          fs.access(candidate),
        ).pipe(
          Effect.map(() => true),
          // Try the next supported extension entry format.
          Effect.catch(() => Effect.succeed(false)),
        );
        if (accessible) {
          filePath = candidate;
          break;
        }
      }
      if (!filePath) {
        continue;
      }

      const entryFilePath = filePath;
      yield* Effect.gen(function* () {
        const resolvedPath = path.resolve(entryFilePath);
        const fileUrl =
          `file:///${resolvedPath.replace(/\\/g, "/")}` +
          (yield* cacheBusterEffect(entryFilePath, loadToken));
        const mod = yield* tryExtensionOp(
          () => import(/* @vite-ignore */ fileUrl),
        );
        const factory = (mod.default ?? mod) as ExtensionFactory;
        if (typeof factory !== "function") {
          return;
        }

        const api: ExtensionRegistrationApi = {
          on(event, handler, filter) {
            collected.hooks.push({
              event,
              filter,
              handler,
            });
          },
          registerTool(tool) {
            collected.tools.push(tool);
          },
          registerProvider(provider) {
            collected.providers.push(provider);
          },
          registerPrompt(prompt) {
            collected.prompts.push(prompt);
          },
          registerAgent(agent) {
            collected.agents.push(agent);
          },
        };

        // The factory is user-authored promise-land code — one seam.
        yield* tryExtensionOp(async () => factory(api, services));
        log(`Loaded extension: ${entry}`);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logError(
              `Failed to load extension ${entryFilePath}:`,
              (error as Error).message,
            );
          }),
        ),
      );
    }

    return collected;
  });

/**
 * Parse prompt template markdown files with optional frontmatter.
 */
const loadPrompts = (dir: string): Effect.Effect<PromptTemplate[]> =>
  Effect.gen(function* () {
    const results: PromptTemplate[] = [];
    const entries = yield* readDirOrEmpty(dir);

    for (const entry of entries) {
      if (!entry.endsWith(".prompt.md")) continue;
      const filePath = path.join(dir, entry);
      // One seam per file: the read AND the frontmatter parse sit inside it,
      // so a parse throw is isolated per-file exactly as before.
      yield* tryExtensionOp(async () => {
        const raw = await fs.readFile(filePath, "utf-8");
        const { metadata, body } = extractFrontmatter(raw);
        const baseName = entry.replace(/\.prompt\.md$/, "");
        results.push({
          name: typeof metadata.name === "string" ? metadata.name : baseName,
          description:
            typeof metadata.description === "string"
              ? metadata.description
              : "",
          template: body.trim() || raw,
          filePath,
        });
        log(`Loaded prompt: ${entry}`);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logError(
              `Failed to load prompt ${filePath}:`,
              (error as Error).message,
            );
          }),
        ),
      );
    }

    return results;
  });

/**
 * Load all extensions from an extensions directory.
 *
 * Expected structure:
 *   baseDir/
 *     my-extension/index.ts
 *     tools/*.tool.ts
 *     hooks/*.hook.ts
 *     providers/*.provider.ts
 *     prompts/*.prompt.md
 */
// Per-process counter of how many times `loadExtensions` has run.
// First call (startup) is 1; each F1 reload increments it. Used only
// to surface a warning when the count crosses
// `LOADER_RELOAD_WARN_THRESHOLD` so the user has a signal that the
// ESM-loader cache is accumulating stale module records (see
// `cacheBuster` for why eviction isn't possible).
let loadExtensionsCallCount = 0;
const LOADER_RELOAD_WARN_THRESHOLD = 50;

export function loadExtensions(
  baseDir: string,
  services: ExtensionServices,
): Promise<LoadedExtensions> {
  return runExtensionEffect(
    Effect.gen(function* () {
      loadExtensionsCallCount += 1;
      if (loadExtensionsCallCount === LOADER_RELOAD_WARN_THRESHOLD) {
        // One-shot warning at the threshold. Silent past that — repeated
        // warnings would drown out other logs and the user already has
        // the signal.
        log(
          `Extensions have been (re)loaded ${loadExtensionsCallCount} times this session. ` +
            "Each reload leaks the previous version's module records into the Node ESM loader cache. " +
            "If you're seeing memory pressure, restart Stella to clear the cache.",
        );
      }
      log(`Loading extensions from ${baseDir}`);

      // Per-load token shared across all importModules calls below so a
      // single `loadExtensions` invocation reuses cached imports for the
      // same file, but a subsequent reload (next call to `loadExtensions`)
      // sees a fresh token and re-imports edited files. See `cacheBuster`.
      const loadToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // The five collectors run concurrently, matching the old Promise.all.
      const [tools, hooks, providers, prompts, registered] = yield* Effect.all(
        [
          importModules<ToolDefinition>(
            path.join(baseDir, "tools"),
            ".tool.ts",
            loadToken,
          ),
          importModules<HookDefinition>(
            path.join(baseDir, "hooks"),
            ".hook.ts",
            loadToken,
          ),
          importModules<ProviderDefinition>(
            path.join(baseDir, "providers"),
            ".provider.ts",
            loadToken,
          ),
          loadPrompts(path.join(baseDir, "prompts")),
          loadExtensionFactories(baseDir, loadToken, services),
        ],
        { concurrency: "unbounded" },
      );

      const loaded: LoadedExtensions = {
        tools: [...tools, ...registered.tools],
        hooks: [...hooks, ...registered.hooks],
        providers: [...providers, ...registered.providers],
        prompts: [...prompts, ...registered.prompts],
        agents: [...registered.agents],
      };

      log(
        `Loaded ${loaded.tools.length} tools, ${loaded.hooks.length} hooks, ${loaded.providers.length} providers, ${loaded.prompts.length} prompts, ${loaded.agents.length} agents`,
      );

      return loaded;
    }),
  );
}
