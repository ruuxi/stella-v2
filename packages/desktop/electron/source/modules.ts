import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SourceTools } from "./tools.js";

/**
 * The renderer's source modules: resolve an import the way the browser build
 * did, transform TS/JSX with oxc, expand `import.meta.glob`, and rewrite every
 * import to a URL the source server answers. Transforms are cached in memory
 * and on disk by content, so a warm start transforms nothing.
 */

export type ImportRef = {
  start: number;
  end: number;
  specifier: string;
  dynamic: boolean;
};

export type TransformedModule = { code: string; map: string | null; imports: ImportRef[] };

export type ResolvedImport =
  | { kind: "source"; file: string; url: string }
  | { kind: "dep"; file: string }
  | { kind: "asset"; file: string; url: string }
  | { kind: "virtual"; url: string };

/** Part of every cache key: bump it whenever transform output changes. */
const TRANSFORM_VERSION = "3";
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]);
const VIRTUAL_MODULES: Record<string, string> = {
  // React Fast Refresh needs the preamble; until the source server does
  // refresh, the module has nothing to set up.
  "@vitejs/plugin-react/preamble": "/@stella/preamble.js",
};

const toPosix = (value: string) => value.replace(/\\/g, "/");
export const isInNodeModules = (file: string) => toPosix(file).includes("/node_modules/");
const isInside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const langFor = (file: string): "ts" | "tsx" | "jsx" => {
  const ext = path.extname(file);
  if (ext === ".ts" || ext === ".mts") return "ts";
  if (ext === ".tsx") return "tsx";
  // Vite's React plugin let `.js` files carry JSX; `jsx` parses plain JS too.
  return "jsx";
};

export type ModuleGraphOptions = {
  tools: SourceTools;
  uiRoot: string;
  repoRoot: string;
  cacheDir: string;
  isDev: boolean;
  defines: Record<string, string>;
};

export const createModuleGraph = (options: ModuleGraphOptions) => {
  const { uiRoot, repoRoot } = options;
  const { ResolverFactory, parse, transform } = options.tools;
  // The app's `@/` alias, and React pinned to one copy (the tsconfig maps
  // the JSX runtimes to type declarations, which only type checking wants).
  const reactFile = (name: string) => path.join(repoRoot, "node_modules", name);
  const resolver = new ResolverFactory({
    alias: {
      "@": [path.join(uiRoot, "src")],
      react$: [reactFile("react/index.js")],
      "react/jsx-runtime": [reactFile("react/jsx-runtime.js")],
      "react/jsx-dev-runtime": [reactFile("react/jsx-dev-runtime.js")],
      "react-dom$": [reactFile("react-dom/index.js")],
      "react-dom/client": [reactFile("react-dom/client.js")],
    },
    conditionNames: ["browser", "import", "module", "default"],
    mainFields: ["browser", "module", "main"],
    aliasFields: [["browser"]],
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    },
    symlinks: true,
  });
  const definesDigest = createHash("sha256").update(JSON.stringify(options.defines)).digest("hex");
  const moduleCacheDir = path.join(options.cacheDir, "modules");
  fs.mkdirSync(moduleCacheDir, { recursive: true });
  const memory = new Map<string, { mtimeMs: number; size: number; module: TransformedModule }>();
  const resolutions = new Map<string, ResolvedImport>();

  /** The URL the source server answers for a file. */
  const urlForFile = (file: string): string => {
    if (isInside(uiRoot, file) && !isInNodeModules(file)) {
      return `/${toPosix(path.relative(uiRoot, file))}`;
    }
    const posix = toPosix(file);
    return `/@fs${posix.startsWith("/") ? "" : "/"}${posix}`;
  };

  /** The file a URL path names, or null when it is outside the repository. */
  const fileForUrlPath = (urlPath: string): string | null => {
    const decoded = decodeURIComponent(urlPath);
    const file = decoded.startsWith("/@fs/")
      ? path.resolve(process.platform === "win32" ? decoded.slice(5) : decoded.slice(4))
      : path.resolve(uiRoot, `.${decoded}`);
    return isInside(repoRoot, file) ? file : null;
  };

  const resolveImport = (specifier: string, importer: string): ResolvedImport | null => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier) || specifier.startsWith("/@")) return null;
    const virtual = VIRTUAL_MODULES[specifier];
    if (virtual) return { kind: "virtual", url: virtual };
    const cacheKey = `${path.dirname(importer)}\0${specifier}`;
    const cached = resolutions.get(cacheKey);
    if (cached) return cached;
    const result = resolver.sync(path.dirname(importer), specifier);
    if (!result.path) {
      throw new Error(
        `Cannot resolve "${specifier}" from ${path.relative(repoRoot, importer)}: ${result.error ?? "not found"}`,
      );
    }
    const file = result.path;
    const isScript = SOURCE_EXTENSIONS.has(path.extname(file)) || path.extname(file) === ".cjs";
    const resolved: ResolvedImport =
      isScript && isInNodeModules(file)
        ? { kind: "dep", file }
        : isScript
          ? { kind: "source", file, url: urlForFile(file) }
          : { kind: "asset", file, url: `${urlForFile(file)}?import` };
    resolutions.set(cacheKey, resolved);
    return resolved;
  };

  const expandGlobs = (code: string, file: string): string => {
    if (!code.includes("import.meta.glob")) return code;
    const hoisted: string[] = [];
    let counter = 0;
    const expanded = code.replace(
      /import\.meta\.glob(?:<[^>]*>)?\(\s*(["'])([^"']+)\1\s*(?:,\s*(\{[^}]*\}))?\s*\)/g,
      (_match, _quote: string, pattern: string, optionsText?: string) => {
        const eager = /eager\s*:\s*true/.test(optionsText ?? "");
        const importName = /import\s*:\s*["']([^"']+)["']/.exec(optionsText ?? "")?.[1];
        const directory = path.dirname(file);
        const matches = (fs.globSync(pattern, { cwd: directory }) as string[])
          .map((match) => toPosix(match))
          .sort();
        const entries = matches.map((match) => {
          // Keys read like the pattern: glob drops a leading "./" but keeps "../".
          const key = match.startsWith("../") ? match : `./${match}`;
          if (!eager) {
            const loader = importName
              ? `() => import(${JSON.stringify(key)}).then((m) => m[${JSON.stringify(importName)}])`
              : `() => import(${JSON.stringify(key)})`;
            return `${JSON.stringify(key)}: ${loader}`;
          }
          const local = `__stella_glob_${counter++}`;
          hoisted.push(
            importName === "default"
              ? `import ${local} from ${JSON.stringify(key)};`
              : importName
                ? `import { ${importName} as ${local} } from ${JSON.stringify(key)};`
                : `import * as ${local} from ${JSON.stringify(key)};`,
          );
          return `${JSON.stringify(key)}: ${local}`;
        });
        return `({ ${entries.join(", ")} })`;
      },
    );
    return hoisted.length > 0 ? `${hoisted.join("\n")}\n${expanded}` : expanded;
  };

  const collectImports = async (file: string, code: string): Promise<ImportRef[]> => {
    const parsed = await parse(file, code, { lang: "js", sourceType: "module" });
    const imports: ImportRef[] = [];
    for (const entry of parsed.module.staticImports) {
      const request = entry.moduleRequest;
      imports.push({ start: request.start, end: request.end, specifier: request.value, dynamic: false });
    }
    for (const entry of parsed.module.staticExports) {
      for (const exported of entry.entries) {
        const request = exported.moduleRequest;
        if (request) {
          imports.push({ start: request.start, end: request.end, specifier: request.value, dynamic: false });
        }
      }
    }
    // `export {} from "x"` still loads "x", but the parser's module record
    // leaves it out. oxc prints each statement on its own line.
    for (const match of code.matchAll(/^export\s*\{\s*\}\s*from\s*(["'])([^"'\n]+)\1/gm)) {
      const start = match.index + match[0].length - match[2]!.length - 2;
      imports.push({ start, end: start + match[2]!.length + 2, specifier: match[2]!, dynamic: false });
    }
    for (const entry of parsed.module.dynamicImports) {
      const literal = code.slice(entry.moduleRequest.start, entry.moduleRequest.end);
      const match = /^(["'])(.*)\1$/s.exec(literal);
      if (match) {
        imports.push({
          start: entry.moduleRequest.start,
          end: entry.moduleRequest.end,
          specifier: match[2]!,
          dynamic: true,
        });
      }
    }
    // A re-export can repeat a static import's span; keep each span once.
    const seen = new Set<number>();
    return imports
      .filter((ref) => (seen.has(ref.start) ? false : (seen.add(ref.start), true)))
      .sort((a, b) => a.start - b.start);
  };

  const transformFile = async (file: string, source: string): Promise<TransformedModule> => {
    const result = await transform(file, source, {
      lang: langFor(file),
      sourceType: "module",
      jsx: { runtime: "automatic", importSource: "react", development: options.isDev },
      define: options.defines,
      target: "esnext",
      sourcemap: true,
    });
    if (result.errors.length > 0) {
      throw new Error(
        result.errors.map((error) => error.message).join("\n\n"),
      );
    }
    const code = expandGlobs(result.code, file);
    return {
      code,
      map: result.map ? JSON.stringify(result.map) : null,
      imports: await collectImports(file, code),
    };
  };

  /** A source module, transformed, from memory, disk, or oxc in that order. */
  const load = async (file: string): Promise<TransformedModule> => {
    const stat = await fs.promises.stat(file);
    const hit = memory.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.module;
    const source = await fs.promises.readFile(file, "utf8");
    // Globs read the directory, so their output is never cached by content.
    const cacheable = !source.includes("import.meta.glob");
    const key = createHash("sha256")
      .update(`${TRANSFORM_VERSION}\0${definesDigest}\0${file}\0${source}`)
      .digest("hex");
    const diskPath = path.join(moduleCacheDir, `${key}.json`);
    let module: TransformedModule | null = null;
    if (cacheable) {
      try {
        module = JSON.parse(await fs.promises.readFile(diskPath, "utf8")) as TransformedModule;
      } catch {
        module = null;
      }
    }
    if (!module) {
      module = await transformFile(file, source);
      if (cacheable) {
        await fs.promises.writeFile(diskPath, JSON.stringify(module)).catch(() => undefined);
      }
    }
    memory.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, module });
    return module;
  };

  /** Rewrite a module's imports to the URLs `urlFor` gives them. */
  const render = (module: TransformedModule, urlFor: (ref: ImportRef) => string | null): string => {
    let code = module.code;
    for (let index = module.imports.length - 1; index >= 0; index -= 1) {
      const ref = module.imports[index]!;
      const url = urlFor(ref);
      if (url === null) continue;
      code = `${code.slice(0, ref.start)}${JSON.stringify(url)}${code.slice(ref.end)}`;
    }
    if (module.map) {
      code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(module.map).toString("base64")}`;
    }
    return code;
  };

  return {
    resolveImport,
    load,
    render,
    urlForFile,
    fileForUrlPath,
    /** Forget a changed file and every cached resolution (files may have moved). */
    invalidate: (file?: string) => {
      if (file) memory.delete(file);
      resolutions.clear();
      resolver.clearCache();
    },
  };
};

export type ModuleGraph = ReturnType<typeof createModuleGraph>;
