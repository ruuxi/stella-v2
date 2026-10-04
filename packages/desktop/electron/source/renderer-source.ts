import fs from "node:fs";
import path from "node:path";
import { absolutizeCssUrls, createTailwindBuild, cssModule, isTailwindStylesheet, type TailwindBuild } from "./css.js";
import { bundleDependencies, type DepBundle } from "./deps.js";
import { envDefines, loadRendererEnv } from "./env.js";
import { createModuleGraph, isInNodeModules, isInside, SOURCE_EXTENSIONS } from "./modules.js";
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
 *
 * Nothing watches the files. A page load picks up whatever is on disk, and
 * `applyChanges` swaps changed files into the open windows: React Fast
 * Refresh for components, accept handlers, and stylesheets, with a reload
 * when a change reaches an entry.
 */

export { RENDERER_ORIGIN, RENDERER_SCHEME } from "./origin.js";

const HTML_ENTRIES = ["index.html", "overlay.html", "companion.html"];
/** Loaded first in every window (see the file). */
const HOT_CLIENT_URL = "/src/platform/hot/hot-client.ts";
/** Prefixed to every module but the hot client, on its first line. */
const HOT_HEADER =
  "const __stella_hot = import.meta.hot = globalThis.__stellaHot.module(import.meta.url);";

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

/** What a window does with an update: see `hot-client.ts` for the payload. */
export type HotUpdate =
  | { type: "self"; id: string; url: string }
  | { type: "dep"; id: string; spec: string; url: string }
  | { type: "css"; id: string; url: string };
export type ApplyResult =
  | { mode: "none" | "reload" }
  | { mode: "hot"; payload: { updates: HotUpdate[]; stale: string[] } };

export type RendererSourceOptions = {
  tools: SourceTools;
  uiRoot: string;
  repoRoot: string;
  /** The desktop-ui directory whose `.env` files supply `import.meta.env`. */
  envDir: string;
  cacheDir: string;
  isDev: boolean;
  log: (message: string) => void;
  /** Dependencies were rebundled: reload the windows. */
  onReloadNeeded: () => void;
};

export const createRendererSource = (options: RendererSourceOptions) => {
  const { tools, uiRoot, repoRoot, log } = options;
  const mode = options.isDev ? "development" : "production";
  const env = loadRendererEnv(options.envDir, mode);
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
  const lockfile = path.join(repoRoot, "bun.lock");
  const hotClientFile = path.join(uiRoot, HOT_CLIENT_URL);

  const depFiles = new Set<string>();
  let deps: DepBundle | null = null;
  let depsBuild: Promise<DepBundle> | null = null;
  const buildDeps = () => {
    const build = bundleDependencies({
      tools,
      files: depFiles,
      cacheDir: options.cacheDir,
      lockfile,
      mode,
      log,
    }).then((bundle) => {
      deps = bundle;
      return bundle;
    });
    depsBuild = build;
    return build;
  };

  const tailwind = new Map<string, Promise<string>>();
  /** Incremental Tailwind builds by stylesheet: they outlive `tailwind`'s cached output. */
  const tailwindBuilds = new Map<string, TailwindBuild>();
  // What the windows were served, for hot updates: each module's resolved
  // source and stylesheet imports, the stylesheets loaded as modules, and
  // the version each updated file is now imported at (`?t=<version>`).
  const servedImports = new Map<string, Set<string>>();
  const servedStylesheets = new Set<string>();
  const tailwindStylesheets = new Set<string>();
  const versions = new Map<string, number>();
  let lastVersion = 0;

  const withVersion = (url: string, file: string) => {
    const version = versions.get(file);
    return version ? `${url}${url.includes("?") ? "&" : "?"}t=${version}` : url;
  };

  const htmlEntryModules = (): string[] => {
    const modules: string[] = options.isDev ? [hotClientFile] : [];
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
      await routes.run().catch((error) => log(`[source] route tree: ${String(error)}`));
      const moduleCount = await crawl();
      await buildDeps();
      log(`[source] ${moduleCount} modules ready in ${Date.now() - startedAt}ms`);
    })());

  /** Before a page loads: forget resolutions and compiled CSS, and regenerate the route tree. */
  const refresh = async () => {
    graph.invalidate();
    tailwind.clear();
    await routes.run().catch((error) => log(`[source] route tree: ${String(error)}`));
  };

  const renderModule = async (file: string): Promise<string> => {
    const module = await graph.load(file);
    const missing: string[] = [];
    const imported = new Set<string>();
    const code = graph.render(
      module,
      file,
      (ref) => {
        const resolved = graph.resolveImport(ref.specifier, file);
        if (!resolved) return null;
        if (resolved.kind !== "dep") {
          if (resolved.kind === "source" || path.extname(resolved.file) === ".css") {
            imported.add(resolved.file);
          }
          return withVersion(resolved.url, resolved.file);
        }
        const entry = deps?.entries.get(resolved.file);
        if (!entry) {
          missing.push(resolved.file);
          return null;
        }
        return `/@deps/${entry}`;
      },
      options.isDev && file !== hotClientFile ? HOT_HEADER : "",
    );
    if (missing.length === 0) {
      servedImports.set(file, imported);
      return code;
    }
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
      tailwindStylesheets.add(file);
      let compiled = tailwind.get(file);
      if (!compiled) {
        let build = tailwindBuilds.get(file);
        if (!build) {
          build = createTailwindBuild({ tools, file, root: uiRoot });
          tailwindBuilds.set(file, build);
        }
        compiled = build.build(source);
        tailwind.set(file, compiled);
        compiled.catch(() => tailwind.delete(file));
      }
      css = await compiled;
    }
    return absolutizeCssUrls(css, `${RENDERER_ORIGIN}${graph.urlForFile(file)}`);
  };

  /** Serve an HTML entry from disk, with the hot client as its first module. */
  const html = async (file: string): Promise<string> => {
    await refresh();
    const source = await fs.promises.readFile(file, "utf8");
    if (!options.isDev) return source;
    const index = source.search(/<script\s+type="module"/);
    const tag = `<script type="module" src="${HOT_CLIENT_URL}"></script>\n    `;
    return index < 0 ? source.replace("</head>", `${tag}</head>`) : `${source.slice(0, index)}${tag}${source.slice(index)}`;
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      await prepare();
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
        if (ext === ".css") {
          servedStylesheets.add(file);
          const prefix = options.isDev ? HOT_HEADER : "";
          return javascript(`${prefix}${cssModule(await stylesheet(file), pathname)}`);
        }
        if (ext === ".json") {
          return javascript(`export default ${await fs.promises.readFile(file, "utf8")};\n`);
        }
        return javascript(`export default ${JSON.stringify(pathname)};\n`);
      }
      if (ext === ".css") return respond(await stylesheet(file), CONTENT_TYPES[".css"]!);
      if (!isPublic && SOURCE_EXTENSIONS.has(ext)) return javascript(await renderModule(file));
      if (!isPublic && ext === ".html") return respond(await html(file), CONTENT_TYPES[".html"]!);
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

  /** Whether a changed file can affect a page: the app's sources, or anything a window was served. */
  const isRendererInput = (file: string) =>
    file === lockfile ||
    servedImports.has(file) ||
    servedStylesheets.has(file) ||
    HTML_ENTRIES.some((name) => file === path.join(uiRoot, name)) ||
    ((isInside(path.join(uiRoot, "src"), file) || isInside(publicDir, file)) && !isInNodeModules(file));

  /** A module that takes its own updates: JSX whose exports all look like components. */
  const selfAccepts = (file: string, exports: string[]) =>
    graph.isJsxLang(file) &&
    !isInside(routes.routesDirectory, file) &&
    exports.length > 0 &&
    exports.every((name) => name === "default" || /^[A-Z]/.test(name));

  /**
   * Swap files that changed on disk (repo-relative paths) into the windows.
   * Walks up from each served changed module through its importers to the
   * nearest modules that accept the update; every module on the way is
   * re-imported at a new version, so the rest keep their instances and
   * state. Reaching a module nothing imports (an entry) means a reload.
   */
  const applyChanges = async (repoPaths: string[]): Promise<ApplyResult> => {
    await prepare();
    const changed = new Set(
      repoPaths.map((repoPath) => path.resolve(repoRoot, repoPath)).filter(isRendererInput),
    );
    if (changed.size === 0) return { mode: "none" };
    for (const file of changed) graph.invalidate(file);
    // Tailwind reads every source file's class names and its own stylesheets'
    // imports; a change to any other stylesheet can't change what it builds.
    const tailwindChanged = [...changed].some(
      (file) =>
        path.extname(file) !== ".css" ||
        tailwindStylesheets.has(file) ||
        [...tailwindBuilds.values()].some((build) => build.inputs.has(file)),
    );
    if (tailwindChanged) tailwind.clear();
    if ([...changed].some((file) => isInside(routes.routesDirectory, file))) {
      await routes.run().catch((error) => log(`[source] route tree: ${String(error)}`));
      changed.add(routes.routeTreeFile);
      graph.invalidate(routes.routeTreeFile);
    }
    if (changed.has(lockfile)) {
      await buildDeps();
      return { mode: "reload" };
    }
    const reloads = (file: string) =>
      file === hotClientFile || isInside(publicDir, file) || path.extname(file) === ".html";
    if (!options.isDev || [...changed].some(reloads)) return { mode: "reload" };

    const importers = new Map<string, string[]>();
    for (const [importer, imported] of servedImports) {
      for (const file of imported) importers.set(file, [...(importers.get(file) ?? []), importer]);
    }
    const updates: HotUpdate[] = [];
    const stale = new Set<string>();
    const settled = new Set<string>();
    const pendingDeps: { id: string; spec: string; file: string }[] = [];
    const pendingSelf: { file: string; type: "self" | "css" }[] = [];
    const propagate = async (file: string, chain: string[]): Promise<boolean> => {
      if (settled.has(file)) {
        for (const link of chain) stale.add(link);
        return true;
      }
      // An import cycle: the walk that entered it covers the rest.
      if (chain.includes(file)) return true;
      const trail = [...chain, file];
      const accept = (type: "self" | "css") => {
        pendingSelf.push({ file, type });
        for (const link of trail) stale.add(link);
        settled.add(file);
        return true;
      };
      if (path.extname(file) === ".css") return accept("css");
      const module = await graph.load(file);
      if (selfAccepts(file, module.exports)) return accept("self");
      const above = importers.get(file) ?? [];
      if (above.length === 0) return false;
      for (const importer of above) {
        const importerModule = await graph.load(importer);
        const spec = importerModule.hotAccepts.find((specifier) => {
          try {
            return graph.resolveImport(specifier, importer)?.file === file;
          } catch {
            return false;
          }
        });
        if (spec) {
          pendingDeps.push({ id: graph.urlForFile(importer), spec, file });
          for (const link of trail) stale.add(link);
        } else if (!(await propagate(importer, trail))) {
          return false;
        }
      }
      settled.add(file);
      return true;
    };
    try {
      for (const file of changed) {
        // Nothing loaded it yet: the next page or import reads it from disk.
        if (!servedImports.has(file) && !importers.has(file) && !servedStylesheets.has(file)) continue;
        if (!(await propagate(file, []))) return { mode: "reload" };
      }
    } catch (error) {
      log(`[source] update: ${error instanceof Error ? error.message : String(error)}`);
      return { mode: "reload" };
    }
    // A new route tree gets new route objects throughout: the router only
    // rebuilds its routes for a new root route.
    if (stale.has(routes.routeTreeFile)) {
      for (const file of servedImports.get(routes.routeTreeFile) ?? []) stale.add(file);
    }
    // Tailwind scans the sources for classes, so any such change can change it.
    for (const file of tailwindChanged ? servedStylesheets : []) {
      if (!settled.has(file) && tailwindStylesheets.has(file)) {
        pendingSelf.push({ file, type: "css" });
        stale.add(file);
      }
    }
    // An updated module that imports a dependency the bundle lacks: rebundle and reload.
    const missing = new Set<string>();
    for (const file of stale) {
      if (path.extname(file) === ".css") continue;
      for (const ref of (await graph.load(file).catch(() => null))?.imports ?? []) {
        try {
          const resolved = graph.resolveImport(ref.specifier, file);
          if (resolved?.kind === "dep" && !deps?.entries.has(resolved.file)) missing.add(resolved.file);
        } catch {
          // Fails the same way when the window imports it.
        }
      }
    }
    if (missing.size > 0) {
      for (const file of missing) depFiles.add(file);
      await buildDeps();
      return { mode: "reload" };
    }

    const version = (lastVersion = Math.max(Date.now(), lastVersion + 1));
    for (const file of stale) versions.set(file, version);
    const urlOf = (file: string) =>
      withVersion(`${graph.urlForFile(file)}${path.extname(file) === ".css" ? "?import" : ""}`, file);
    for (const { file, type } of pendingSelf) {
      updates.push({ type, id: graph.urlForFile(file), url: urlOf(file) });
    }
    for (const { id, spec, file } of pendingDeps) {
      updates.push({ type: "dep", id, spec, url: urlOf(file) });
    }
    return {
      mode: "hot",
      payload: { updates, stale: [...stale].map((file) => graph.urlForFile(file)) },
    };
  };

  return {
    prepare,
    handle,
    applyChanges,
    dispose: () => {
      servedImports.clear();
      servedStylesheets.clear();
    },
  };
};

export type RendererSource = ReturnType<typeof createRendererSource>;
