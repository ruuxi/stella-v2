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

export const compileTailwind = async (options: {
  tools: SourceTools;
  file: string;
  source: string;
  /** The project root Tailwind scans by default (Vite's root). */
  root: string;
}): Promise<{ css: string; dependencies: string[] }> => {
  const dependencies: string[] = [];
  const compiler = await options.tools.compileTailwind(options.source, {
    base: path.dirname(options.file),
    from: options.file,
    shouldRewriteUrls: true,
    onDependency: (dependency) => dependencies.push(dependency),
  });
  const roots =
    compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base: options.root, pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }];
  const scanner = new options.tools.TailwindScanner({ sources: [...roots, ...compiler.sources] });
  const css = compiler.build(scanner.scan());
  return { css, dependencies };
};

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
