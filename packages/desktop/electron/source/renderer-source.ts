import fs from "node:fs";
import path from "node:path";
import { absolutizeCssUrls, compileTailwind, cssModule, isTailwindStylesheet } from "./css.js";
import { bundleDependencies, type DepBundle } from "./deps.js";
import { envDefines, loadRendererEnv } from "./env.js";
import { createModuleGraph, isInNodeModules, SOURCE_EXTENSIONS } from "./modules.js";
import { RENDERER_ORIGIN } from "./origin.js";
import { createRouteTreeGenerator } from "./routes.js";
import type { SourceTools } from "./tools.js";

/**
 * Serves the renderer straight from its source tree, with no dev server and
 * no build: `stella-app://desktop/...` answers HTML, source modules
 * (transformed on request and cached by content), pre-bundled npm
 * dependencies, and stylesheets. Before the first window loads it walks the
 * module graph from the HTML entries, which warms the cache and finds the
 * dependencies to bundle.
 */

export { RENDERER_ORIGIN, RENDERER_SCHEME } from "./origin.js";

const HTML_ENTRIES = ["index.html", "overlay.html", "companion.html"];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const respond = (body: string | Uint8Array, contentType: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": contentType, "cache-control": "no-cache" },
  });
const javascript = (code: string) => respond(code, CONTENT_TYPES[".js"]!);

/** A module that fails the way a broken import should: loudly, with the cause. */
const errorModule = (message: string) =>
  javascript(
    [
      `const error = new Error(${JSON.stringify(message)});`,
      `window.dispatchEvent(new CustomEvent("stella:source-error", { detail: { error } }));`,
      `throw error;`,
    ].join("\n"),
  );

const exists = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

export type RendererSourceOptions = {
  tools: SourceTools;
  uiRoot: string;
  repoRoot: string;
  cacheDir: string;
  isDev: boolean;
  log: (message: string) => void;
  /** Source changed (dev) or dependencies were rebundled: reload the windows. */
  onReloadNeeded: () => void;
};

export const createRendererSource = (options: RendererSourceOptions) => {
  const { tools, uiRoot, repoRoot, log } = options;
  const mode = options.isDev ? "development" : "production";
  const env = loadRendererEnv(uiRoot, mode);
  const graph = createModuleGraph({
    tools,
    uiRoot,
    repoRoot,
    cacheDir: options.cacheDir,
    isDev: options.isDev,
    defines: envDefines(env),
  });
  const routes = createRouteTreeGenerator(tools, uiRoot);
  const publicDir = path.join(uiRoot, "public");

  const depFiles = new Set<string>();
  let deps: DepBundle | null = null;
  let depsBuild: Promise<DepBundle> | null = null;
  const buildDeps = () => {
    const build = bundleDependencies({
      tools,
      files: depFiles,
      cacheDir: options.cacheDir,
      lockfile: path.join(repoRoot, "bun.lock"),
      mode,
      log,
    }).then((bundle) => {
      deps = bundle;
      return bundle;
    });
    depsBuild = build;
    return build;
  };

  // Dev: watch every directory a served module lives in, plus the routes.
  const watchers = new Map<string, fs.FSWatcher>();
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const tailwind = new Map<string, Promise<string>>();
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      options.onReloadNeeded();
    }, 120);
  };
  const onFileChanged = (file: string) => {
    graph.invalidate(file);
    tailwind.clear();
    if (file.startsWith(routes.routesDirectory)) {
      void routes.run().catch((error) => log(`[source] route tree: ${String(error)}`));
    }
    scheduleReload();
  };
  const watchDirectoryOf = (file: string) => {
    if (!options.isDev || isInNodeModules(file)) return;
    const directory = path.dirname(file);
    if (watchers.has(directory)) return;
    try {
      const watcher = fs.watch(directory, (_event, name) => {
        if (typeof name === "string" && name) onFileChanged(path.join(directory, name));
      });
      watcher.on("error", () => watcher.close());
      watchers.set(directory, watcher);
    } catch {
      // A directory that cannot be watched just won't reload on change.
    }
  };

  const htmlEntryModules = (): string[] => {
    const modules: string[] = [];
    for (const name of HTML_ENTRIES) {
      let html: string;
      try {
        html = fs.readFileSync(path.join(uiRoot, name), "utf8");
      } catch {
        continue;
      }
      for (const match of html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)) {
        const file = graph.fileForUrlPath(match[1]!);
        if (file) modules.push(file);
      }
    }
    return modules;
  };

  /** Transform everything reachable from the HTML entries and note its dependencies. */
  const crawl = async () => {
    const seen = new Set<string>();
    let frontier = htmlEntryModules();
    while (frontier.length > 0) {
      const next: string[] = [];
      await Promise.all(
        frontier.map(async (file) => {
          if (seen.has(file)) return;
          seen.add(file);
          watchDirectoryOf(file);
          let module;
          try {
            module = await graph.load(file);
          } catch (error) {
            log(`[source] ${path.relative(repoRoot, file)}: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          for (const ref of module.imports) {
            let resolved;
            try {
              resolved = graph.resolveImport(ref.specifier, file);
            } catch {
              continue;
            }
            if (resolved?.kind === "dep") depFiles.add(resolved.file);
            else if (resolved?.kind === "source" && !seen.has(resolved.file)) next.push(resolved.file);
          }
        }),
      );
      frontier = next;
    }
    return seen.size;
  };

  let prepared: Promise<void> | null = null;
  const prepare = () =>
    (prepared ??= (async () => {
      const startedAt = Date.now();
      if (options.isDev) watchDirectoryOf(path.join(routes.routesDirectory, "_"));
      await routes.run().catch((error) => log(`[source] route tree: ${String(error)}`));
      const moduleCount = await crawl();
      await buildDeps();
      log(`[source] ${moduleCount} modules ready in ${Date.now() - startedAt}ms`);
    })());

  const renderModule = async (file: string): Promise<string> => {
    watchDirectoryOf(file);
    const module = await graph.load(file);
    const missing: string[] = [];
    const code = graph.render(module, (ref) => {
      const resolved = graph.resolveImport(ref.specifier, file);
      if (!resolved) return null;
      if (resolved.kind !== "dep") return resolved.url;
      const entry = deps?.entries.get(resolved.file);
      if (!entry) {
        missing.push(resolved.file);
        return null;
      }
      return `/@deps/${entry}`;
    });
    if (missing.length === 0) return code;
    // A dependency nothing imported before: rebundle, then reload the
    // windows so no page mixes two bundles' copies of shared code.
    for (const file of missing) depFiles.add(file);
    log(`[source] new dependencies: ${missing.map((file) => path.relative(repoRoot, file)).join(", ")}`);
    await buildDeps();
    options.onReloadNeeded();
    return await renderModule(file);
  };

  const stylesheet = async (file: string): Promise<string> => {
    const source = await fs.promises.readFile(file, "utf8");
    let css = source;
    if (isTailwindStylesheet(source)) {
      let compiled = tailwind.get(file);
      if (!compiled) {
        compiled = compileTailwind({ tools, file, source, root: uiRoot }).then(
          (result) => result.css,
        );
        tailwind.set(file, compiled);
        compiled.catch(() => tailwind.delete(file));
      }
      css = await compiled;
    }
    return absolutizeCssUrls(css, `${RENDERER_ORIGIN}${graph.urlForFile(file)}`);
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      await prepare();
      if (pathname === "/@stella/preamble.js") return javascript("export {};\n");
      if (pathname.startsWith("/@deps/")) {
        const bundle = deps ?? (await depsBuild);
        const file = bundle ? path.join(bundle.dir, path.basename(pathname)) : null;
        return file && exists(file)
          ? javascript(await fs.promises.readFile(file, "utf8"))
          : respond("Not found", "text/plain", 404);
      }
      let file = graph.fileForUrlPath(pathname);
      let isPublic = false;
      if (!file || !exists(file)) {
        const publicFile = path.resolve(publicDir, `.${decodeURIComponent(pathname)}`);
        if (publicFile.startsWith(publicDir) && exists(publicFile)) {
          file = publicFile;
          isPublic = true;
        } else {
          return respond("Not found", "text/plain", 404);
        }
      }
      const ext = path.extname(file).toLowerCase();
      if (url.searchParams.has("import")) {
        if (ext === ".css") return javascript(cssModule(await stylesheet(file), pathname));
        if (ext === ".json") {
          return javascript(`export default ${await fs.promises.readFile(file, "utf8")};\n`);
        }
        return javascript(`export default ${JSON.stringify(pathname)};\n`);
      }
      if (ext === ".css") return respond(await stylesheet(file), CONTENT_TYPES[".css"]!);
      if (!isPublic && SOURCE_EXTENSIONS.has(ext)) return javascript(await renderModule(file));
      return respond(
        await fs.promises.readFile(file),
        CONTENT_TYPES[ext] ?? "application/octet-stream",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[source] ${pathname}: ${message}`);
      const ext = path.extname(pathname).toLowerCase();
      return SOURCE_EXTENSIONS.has(ext) || url.searchParams.has("import")
        ? errorModule(message)
        : respond(message, "text/plain", 500);
    }
  };

  return {
    prepare,
    handle,
    dispose: () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
};

export type RendererSource = ReturnType<typeof createRendererSource>;
