import fs from "node:fs";
import path from "node:path";
import type { SourceTools } from "./tools.js";

/**
 * Renderer stylesheets. A stylesheet that imports Tailwind is compiled with
 * Tailwind, scanning the app's sources for the classes it uses; every
 * stylesheet then has its relative `url()`s made absolute, because the
 * renderer injects them as `<style>` tags where relative URLs would resolve
 * against the page instead of the file.
 */

const TAILWIND_ENTRY = /@import\s+["']tailwindcss["']|@tailwind\s|@theme\b|@apply\b|@reference\b/;

export const isTailwindStylesheet = (source: string): boolean => TAILWIND_ENTRY.test(source);

/**
 * One Tailwind stylesheet, built incrementally the way Tailwind's own Vite
 * plugin does: the compiler and scanner live across builds, each build
 * rescans (the scanner rereads only what changed) and adds any new classes,
 * and only a change to the stylesheet or one of its imports starts over.
 * A cold build scans the whole UI (~250 ms); a warm one takes a few ms, so a
 * change's hot update doesn't wait on Tailwind.
 */
export const createTailwindBuild = (options: {
  tools: SourceTools;
  file: string;
  /** The project root Tailwind scans by default (Vite's root). */
  root: string;
}) => {
  type Compiler = Awaited<ReturnType<SourceTools["compileTailwind"]>>;
  type Scanner = InstanceType<SourceTools["TailwindScanner"]>;
  let state: {
    compiler: Compiler;
    scanner: Scanner;
    candidates: Set<string>;
    /** The stylesheet and its imports, with the mtime each was built from. */
    inputs: Map<string, number | null>;
  } | null = null;
  const mtime = (file: string) =>
    fs.promises.stat(file).then((stats) => stats.mtimeMs, () => null);
  const stale = async () => {
    if (!state) return true;
    for (const [file, built] of state.inputs) {
      if (built === null || (await mtime(file)) !== built) return true;
    }
    return false;
  };
  const inputs = new Set<string>();
  return {
    /** The stylesheet and the files it imports (as of the last build). */
    inputs,
    build: async (source: string): Promise<string> => {
      if (await stale()) {
        const files = [options.file];
        const compiler = await options.tools.compileTailwind(source, {
          base: path.dirname(options.file),
          from: options.file,
          shouldRewriteUrls: true,
          onDependency: (dependency) => files.push(path.resolve(dependency)),
        });
        const roots =
          compiler.root === "none"
            ? []
            : compiler.root === null
              ? [{ base: options.root, pattern: "**/*", negated: false }]
              : [{ ...compiler.root, negated: false }];
        state = {
          compiler,
          scanner: new options.tools.TailwindScanner({ sources: [...roots, ...compiler.sources] }),
          candidates: new Set(),
          inputs: new Map(await Promise.all(files.map(async (file) => [file, await mtime(file)] as const))),
        };
        inputs.clear();
        for (const file of files) inputs.add(file);
      }
      const current = state!;
      for (const candidate of current.scanner.scan()) current.candidates.add(candidate);
      return current.compiler.build([...current.candidates]);
    },
  };
};

export type TailwindBuild = ReturnType<typeof createTailwindBuild>;

const URL_REFERENCE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Make relative `url()`s absolute against `baseUrl`, the stylesheet's own URL. */
export const absolutizeCssUrls = (css: string, baseUrl: string): string =>
  css.replace(URL_REFERENCE, (match, quote: string, reference: string) => {
    const trimmed = reference.trim();
    if (
      !trimmed ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("/") ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ) {
      return match;
    }
    try {
      return `url(${quote}${new URL(trimmed, baseUrl).pathname}${quote})`;
    } catch {
      return match;
    }
  });

/** A JS module that applies a stylesheet, as Vite's dev server served CSS imports. */
export const cssModule = (css: string, id: string): string =>
  [
    `const css = ${JSON.stringify(css)};`,
    `let style = document.querySelector(${JSON.stringify(`style[data-stella-css="${id}"]`)});`,
    `if (!style) {`,
    `  style = document.createElement("style");`,
    `  style.dataset.stellaCss = ${JSON.stringify(id)};`,
    `  document.head.appendChild(style);`,
    `}`,
    `style.textContent = css;`,
    `export default css;`,
  ].join("\n");
