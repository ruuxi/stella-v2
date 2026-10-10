import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createTailwindBuild, cssModule, isTailwindStylesheet } from "./css.js";
import { envDefines, loadRendererEnv, pairedAppsHosts, type RendererEnv } from "./env.js";
import { createModuleGraph, isInNodeModules, SOURCE_EXTENSIONS } from "./modules.js";
import { createRouteTreeGenerator } from "./routes.js";
import type { SourceTools } from "./tools.js";

/**
 * The browser build of the renderer, without Vite: rolldown bundles
 * `index.html`'s entry, resolving and transforming through the same module
 * graph the desktop source server uses (oxc, `import.meta.glob`, the `@`
 * alias, one React). Stylesheets are compiled the same way (Tailwind when
 * they ask for it) and applied by their modules, as on desktop.
 *
 * Every URL in the output is relative, so one build serves from any path:
 * the shared `/chat-app/` and each owner's `/chat-app/u/<fork>/<tree>/`. The
 * router keeps its location in memory, so the document's URL, and with it
 * every document-relative URL, stays put for the page's life.
 */

const toPosix = (value: string) => value.replace(/\\/g, "/");
const ASSETS = "assets";

/**
 * The website's public config: `VITE_*`, then the website's `NEXT_PUBLIC_*`
 * twin, then desktop-ui's `.env` files. The Apps host follows the backend.
 */
export const webBuildEnv = (
  uiRoot: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): RendererEnv => {
  const base = loadRendererEnv(uiRoot, "production");
  const pick = (name: string): string =>
    processEnv[`VITE_${name}`] ||
    processEnv[`NEXT_PUBLIC_${name}`] ||
    (typeof base[`VITE_${name}`] === "string" ? (base[`VITE_${name}`] as string) : "");
  const backendUrl = pick("STELLA_BACKEND_URL").trim().replace(/\/+$/, "");
  const paired = pairedAppsHosts(backendUrl);
  const appsHost =
    processEnv.VITE_STELLA_APPS_HOST ||
    processEnv.NEXT_PUBLIC_STELLA_APPS_HOST ||
    paired?.appsHost ||
    pick("STELLA_APPS_HOST");
  if (!backendUrl || !appsHost) {
    throw new Error("Configure the Stella backend and Apps host origins.");
  }
  const webUrl = (pick("STELLA_WEB_URL") || processEnv.NEXT_PUBLIC_STELLA_SITE_URL || "").trim();
  return {
    ...base,
    ...(webUrl ? { VITE_STELLA_WEB_URL: webUrl } : {}),
    VITE_STELLA_WEB_BUILD: "1",
    VITE_STELLA_BACKEND_URL: backendUrl,
    VITE_TURNSTILE_SITE_KEY: pick("TURNSTILE_SITE_KEY"),
    VITE_STELLA_APPS_HOST: appsHost,
    VITE_STELLA_APPS_AUTH_HOST: paired?.appsAuthHost || pick("STELLA_APPS_AUTH_HOST"),
    BASE_URL: "./",
  };
};

export type WebBuildOptions = {
  tools: SourceTools;
  repoRoot: string;
  outDir: string;
  env: RendererEnv;
  cacheDir: string;
  log?: (message: string) => void;
  staticHome?: { firstVisit: Record<"dark" | "light", StaticHomeRoot> };
};

export type StaticHomeRoot = { attributes: Record<string, string>; properties: Array<[string, string]> };

const NEW_URL = /new\s+URL\(\s*(["'])([^"'\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const LAUNCH_RESCUE =
  /    <div id="stella-launch"[\s\S]*?<script src="[^"\n]*\/stella-launch-rescue\.js"><\/script>\s*/;

const FUN_GREETINGS = /const FUN_GREETINGS = (\[[\s\S]*?\]);/;
const FUN_GREETING_CHANCE = /const FUN_GREETING_CHANCE = ([0-9.]+);/;

const staticHomeMarkup = (
  uiRoot: string,
  log: (message: string) => void,
  firstVisit: Record<"dark" | "light", StaticHomeRoot>,
): string => {
  const partial = fs.readFileSync(path.join(uiRoot, "web-static-home.html"), "utf8");
  const home = fs.readFileSync(path.join(uiRoot, "src", "app", "home", "HomeContent.jsx"), "utf8");
  let greetings: string[] = [];
  try {
    greetings = JSON.parse(FUN_GREETINGS.exec(home)?.[1]?.replace(/,\s*\]$/, "]") ?? "[]");
  } catch {
    log("[web-build] HomeContent's greetings were not found; the static Home uses the time of day only.");
  }
  const chance = Number(FUN_GREETING_CHANCE.exec(home)?.[1] ?? 0);
  return partial
    .replace("__STELLA_FUN_GREETINGS__", () => JSON.stringify(greetings))
    .replace("__STELLA_FUN_GREETING_CHANCE__", () => String(Number.isFinite(chance) ? chance : 0))
    .replace("__STELLA_FIRST_VISIT_ROOTS__", () => JSON.stringify(firstVisit));
};

const isExternalUrl = (value: string) =>
  !value || value.startsWith("#") || value.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);

const exists = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

export const buildWebRenderer = async (options: WebBuildOptions): Promise<{ files: string[] }> => {
  const { tools, repoRoot, outDir } = options;
  const log = options.log ?? (() => undefined);
  const uiRoot = path.join(repoRoot, "packages", "desktop-ui");
  const publicDir = path.join(uiRoot, "public");
  const defines = { ...envDefines(options.env), "import.meta.hot": "undefined" };
  const graph = createModuleGraph({
    tools,
    uiRoot,
    repoRoot,
    cacheDir: options.cacheDir,
    development: false,
    defines,
  });
  await createRouteTreeGenerator(tools, uiRoot).run();

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, ASSETS), { recursive: true });

  /** Copy a file into `assets/` under a content-hashed name; returns its output path. */
  const emitted = new Map<string, string>();
  const emitFile = (name: string, bytes: Uint8Array): string => {
    const hash = createHash("sha256").update(bytes).digest("base64url").slice(0, 8);
    const ext = path.extname(name);
    const fileName = `${ASSETS}/${path.basename(name, ext)}-${hash}${ext}`;
    fs.writeFileSync(path.join(outDir, fileName), bytes);
    return fileName;
  };
  const emitAsset = (file: string): string => {
    let fileName = emitted.get(file);
    if (!fileName) {
      fileName = emitFile(file, fs.readFileSync(file));
      emitted.set(file, fileName);
    }
    return fileName;
  };

  /** A `url()` or attribute reference, made relative to the output root. */
  const rewriteReference = (reference: string, fromFile: string): string | null => {
    const trimmed = reference.trim();
    if (isExternalUrl(trimmed)) return null;
    const bare = trimmed.replace(/[?#].*$/, "");
    const suffix = trimmed.slice(bare.length);
    if (bare.startsWith("/")) {
      if (exists(path.join(publicDir, bare))) return `${bare.slice(1)}${suffix}`;
      const file = graph.fileForUrlPath(bare);
      return file && exists(file) ? `${emitAsset(file)}${suffix}` : null;
    }
    const file = path.resolve(path.dirname(fromFile), bare);
    return exists(file) ? `${emitAsset(file)}${suffix}` : null;
  };

  const rewriteCssUrls = (css: string, fromFile: string, prefix = "") =>
    css.replace(CSS_URL, (match, quote: string, reference: string) => {
      const rewritten = rewriteReference(reference, fromFile);
      return rewritten === null ? match : `url(${quote}${prefix}${rewritten}${quote})`;
    });

  const compiledCss = new Map<string, Promise<string>>();
  const compileStylesheet = (file: string): Promise<string> => {
    let compiled = compiledCss.get(file);
    if (!compiled) {
      compiled = fs.promises.readFile(file, "utf8").then((source) =>
        isTailwindStylesheet(source) ? createTailwindBuild({ tools, file, root: uiRoot }).build(source) : source,
      );
      compiledCss.set(file, compiled);
    }
    return compiled;
  };

  const stylesheet = async (file: string, prefix = ""): Promise<string> =>
    rewriteCssUrls(await compileStylesheet(file), file, prefix);

  const linkedCss = new Set<string>();

  const rolldownOptions = (input: Record<string, string>) => ({
    input,
    platform: "browser" as const,
    tsconfig: false,
    transform: { define: defines },
    plugins: [plugin],
    onLog: (level: string, entry: { code?: string; message: string }) => {
      if (level === "warn" && entry.code !== "IMPORT_IS_UNDEFINED" && entry.code !== "EVAL") {
        log(`[web-build] ${entry.message}`);
      }
    },
  });

  /** A worker script, bundled on its own into one file. */
  const workers = new Map<string, Promise<string>>();
  const buildWorker = (file: string): Promise<string> => {
    let build = workers.get(file);
    if (!build) {
      build = (async () => {
        const bundle = await tools.rolldown(rolldownOptions({ worker: file }));
        try {
          const { output } = await bundle.generate({ format: "esm", minify: true, codeSplitting: false });
          const chunk = output.find((item) => item.type === "chunk");
          if (!chunk || chunk.type !== "chunk") throw new Error(`No output for worker ${file}`);
          const ext = path.extname(file);
          return emitFile(`${path.basename(file, ext)}.js`, Buffer.from(chunk.code));
        } finally {
          await bundle.close();
        }
      })();
      workers.set(file, build);
    }
    return build;
  };

  /** `new URL("./x", import.meta.url)`: bundle a script, copy anything else. */
  const rewriteModuleUrls = async (code: string, file: string): Promise<string> => {
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(NEW_URL)) {
      const reference = match[2]!;
      if (isExternalUrl(reference) || replacements.has(match[0])) continue;
      const target = path.resolve(path.dirname(file), reference);
      if (!exists(target)) continue;
      const fileName = SOURCE_EXTENSIONS.has(path.extname(target))
        ? await buildWorker(target)
        : emitAsset(target);
      // Chunks live in `assets/` too.
      replacements.set(match[0], `new URL(${JSON.stringify(`./${path.basename(fileName)}`)}, import.meta.url)`);
    }
    let result = code;
    for (const [from, to] of replacements) result = result.split(from).join(to);
    return result;
  };

  const plugin = {
    name: "stella-web-source",
    resolveId(source: string, importer: string | undefined, extra: { kind?: string }) {
      if (!importer || source.startsWith("\0") || importer.startsWith("\0")) return null;
      if (extra.kind === "require-call") return null;
      try {
        const resolved = graph.resolveImport(source, importer);
        return resolved ? resolved.file : { id: source, external: true };
      } catch (error) {
        // Dependencies may import optional packages they guard at runtime.
        if (isInNodeModules(importer)) return null;
        throw error;
      }
    },
    async load(id: string) {
      if (id.startsWith("\0")) return null;
      const ext = path.extname(id).toLowerCase();
      if (ext === ".css") {
        if (linkedCss.has(id)) return { code: "export default \"\";\n", moduleType: "js" as const };
        return { code: cssModule(await stylesheet(id), toPosix(path.relative(repoRoot, id))), moduleType: "js" as const };
      }
      if (SOURCE_EXTENSIONS.has(ext) || ext === ".cjs" || ext === ".json") {
        if (isInNodeModules(id) || ext === ".cjs" || ext === ".json") return null;
        const module = await graph.load(id);
        return { code: await rewriteModuleUrls(module.code, id), moduleType: "js" as const };
      }
      return { code: `export default ${JSON.stringify(emitAsset(id))};\n`, moduleType: "js" as const };
    },
  };

  const entryStylesheets = async (entryFile: string): Promise<string[]> => {
    const probe = await tools.rolldown(rolldownOptions({ main: entryFile }));
    let probeOutput;
    try {
      ({ output: probeOutput } = await probe.generate({ format: "esm" }));
    } finally {
      await probe.close();
    }
    const chunks = new Map(
      probeOutput.flatMap((item) => (item.type === "chunk" ? [[item.fileName, item] as const] : [])),
    );
    const evaluated = new Set<string>();
    const stylesheets: string[] = [];
    const evaluate = (fileName: string) => {
      const chunk = chunks.get(fileName);
      if (!chunk || evaluated.has(fileName)) return;
      evaluated.add(fileName);
      for (const imported of chunk.imports) evaluate(imported);
      for (const id of chunk.moduleIds) {
        if (path.extname(id).toLowerCase() === ".css") stylesheets.push(id);
      }
    };
    const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
    if (entry) evaluate(entry.fileName);
    return stylesheets;
  };

  // The entry, from the page's module script.
  const htmlFile = path.join(uiRoot, "index.html");
  let html = fs.readFileSync(htmlFile, "utf8");
  const entryTag = /<script\s+type="module"\s+src="([^"]+)"><\/script>/.exec(html);
  const entryFile = entryTag ? graph.fileForUrlPath(entryTag[1]!) : null;
  if (!entryTag || !entryFile) throw new Error("index.html has no module script entry.");

  const startedAt = Date.now();
  const criticalCss = options.staticHome ? await entryStylesheets(entryFile) : [];
  for (const id of criticalCss) linkedCss.add(id);

  const bundle = await tools.rolldown(rolldownOptions({ main: entryFile }));
  let output;
  try {
    ({ output } = await bundle.write({
      dir: outDir,
      format: "esm",
      minify: true,
      entryFileNames: `${ASSETS}/[name]-[hash].js`,
      chunkFileNames: `${ASSETS}/[name]-[hash].js`,
      assetFileNames: `${ASSETS}/[name]-[hash][extname]`,
    }));
  } finally {
    await bundle.close();
  }
  const chunks = new Map(
    output.flatMap((item) => (item.type === "chunk" ? [[item.fileName, item] as const] : [])),
  );
  const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
  if (!entry) throw new Error("The build produced no entry chunk.");
  const statsFile = process.env.STELLA_WEB_BUILD_STATS;
  if (statsFile) {
    const stats = [...chunks.values()].map((chunk) => ({
      fileName: chunk.fileName,
      isEntry: chunk.isEntry,
      bytes: Buffer.byteLength(chunk.code),
      imports: chunk.imports,
      dynamicImports: chunk.dynamicImports,
      modules: Object.entries(chunk.modules)
        .map(([id, info]) => ({ id: toPosix(path.relative(repoRoot, id)), bytes: info.renderedLength }))
        .sort((a, b) => b.bytes - a.bytes),
    }));
    fs.writeFileSync(statsFile, JSON.stringify(stats));
  }
  // Preload the entry's static import graph so it doesn't load as a waterfall.
  const preload = new Set<string>();
  const walk = (fileName: string) => {
    for (const imported of chunks.get(fileName)?.imports ?? []) {
      if (preload.has(imported)) continue;
      preload.add(imported);
      walk(imported);
    }
  };
  walk(entry.fileName);

  const originOf = (value: unknown) => {
    try {
      return typeof value === "string" && value.trim() ? new URL(value.trim()).origin : null;
    } catch {
      return null;
    }
  };
  const backend = originOf(options.env.VITE_STELLA_BACKEND_URL);
  const linkedStylesheet = criticalCss.length
    ? emitFile("app.css", Buffer.from((await Promise.all(criticalCss.map((id) => stylesheet(id, "../")))).join("\n")))
    : null;
  if (options.staticHome) {
    const markup = staticHomeMarkup(uiRoot, log, options.staticHome.firstVisit);
    html = html.replace(/(\s*)<div id="root">/, (match, indent: string) => `${indent}${markup.trim().split("\n").join(indent)}${match}`);
  }
  const entryTags = [
    `<script type="module" crossorigin src="./${entry.fileName}"></script>`,
    ...[...preload].map((fileName) => `<link rel="modulepreload" crossorigin href="./${fileName}">`),
  ];
  html = html
    .replace(LAUNCH_RESCUE, "")
    .replace(entryTag[0], () => (options.staticHome ? "" : entryTags.join("\n    ")))
    .replace(/<style>([\s\S]*?)<\/style>/g, (_match, css: string) => `<style>${rewriteCssUrls(css, htmlFile)}</style>`)
    .replace(/(<(?:link|script|img)\b[^>]*?\s(?:href|src)=")(\/[^"]*)"/g, (match, head: string, reference: string) => {
      const rewritten = rewriteReference(reference, htmlFile);
      return rewritten === null ? match : `${head}./${rewritten}"`;
    })
    .replace(
      "</head>",
      [
        ...(backend ? [`  <link rel="preconnect" href="${backend}" crossorigin="anonymous">`] : []),
        ...(linkedStylesheet ? [`  <link rel="stylesheet" href="./${linkedStylesheet}">`] : []),
        ...(options.staticHome ? entryTags.map((tag) => `  ${tag}`) : []),
        "</head>",
      ].join("\n  "),
    );
  if (options.staticHome) {
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (match) => `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`,
    );
    html = html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*?script-src )/, (match) => `${match}${hashes.join(" ")} `);
  }
  fs.writeFileSync(path.join(outDir, "index.html"), html);

  // Static files, and pdf.js's worker from the copy react-pdf imports.
  fs.cpSync(publicDir, outDir, { recursive: true });
  try {
    const reactPdf = graph.resolveImport("react-pdf", path.join(uiRoot, "src", "main.tsx"));
    const worker = reactPdf && graph.resolveImport("pdfjs-dist/build/pdf.worker.min.mjs", reactPdf.file);
    if (worker) {
      fs.mkdirSync(path.join(outDir, "vendor", "pdfjs"), { recursive: true });
      fs.copyFileSync(worker.file, path.join(outDir, "vendor", "pdfjs", "pdf.worker.min.mjs"));
    }
  } catch (error) {
    log(`[web-build] pdf.js worker not copied; PDF previews will not render: ${String(error)}`);
  }

  const files = (fs.readdirSync(outDir, { recursive: true }) as string[])
    .map(toPosix)
    .filter((name) => fs.statSync(path.join(outDir, name)).isFile())
    .sort();
  log(`[web-build] ${chunks.size} chunks, ${files.length} files in ${Date.now() - startedAt}ms`);
  return { files };
};
