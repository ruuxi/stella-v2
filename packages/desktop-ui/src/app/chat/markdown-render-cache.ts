/**
 * Cross-mount cache for Streamdown's parsed markdown.
 *
 * Chat rows are virtualized, so a reply is unmounted when it scrolls out of
 * the draw window and fully re-parsed (remark → rehype → sanitize/harden,
 * ~10ms for a long reply) every time it scrolls back in. Replies are
 * immutable once shown, so the finished hast for a given text + plugin
 * configuration never changes.
 *
 * Streamdown owns the unified processor and renders it with
 * `processor.runSync(processor.parse(text), text)`. This remark "plugin"
 * installs nothing into the pipeline; its attacher (which unified calls with
 * the processor as `this` when the processor freezes) wraps that processor's
 * `parse` / `runSync` pair so a repeat of the same text returns the cached
 * hast instead of re-running the pipeline. Only the conversion to React
 * elements runs per mount, so handlers and context are resolved fresh.
 *
 * The cached tree is shared between mounts and must be treated as immutable;
 * Streamdown's hast → JSX step only reads it. The ratchet in
 * `tests/app/chat/markdown-render-cache.test.tsx` fails if a Streamdown
 * upgrade changes the call shape this relies on.
 */

type UnifiedLike = {
  parse: (file?: unknown) => unknown;
  runSync: (tree: unknown, file?: unknown) => unknown;
};

/**
 * Upper bound on the source text retained, summed across entries. A cached
 * tree measured ~120 bytes of heap per source character, so this caps the
 * cache near 18MB while covering the 80-message visible window at typical
 * reply lengths.
 */
export const MAX_CACHED_MARKDOWN_CHARS = 150_000;
/** A single reply larger than this is never cached (it would evict the rest). */
const MAX_CACHED_ENTRY_CHARS = MAX_CACHED_MARKDOWN_CHARS / 4;

type CacheEntry = { tree: object; chars: number };

// Insertion-ordered: the first key is the least recently used.
const entries = new Map<string, CacheEntry>();
let cachedChars = 0;
let hits = 0;
let misses = 0;

/** Placeholder trees handed from `parse` to `runSync` on a cache hit. */
const pendingHits = new WeakMap<object, object>();

const cacheKey = (scope: string, text: string) => `${scope}\u0001${text}`;

const readEntry = (key: string): object | undefined => {
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry.tree;
};

const writeEntry = (key: string, tree: object, chars: number) => {
  if (chars > MAX_CACHED_ENTRY_CHARS) return;
  const existing = entries.get(key);
  if (existing) {
    entries.delete(key);
    cachedChars -= existing.chars;
  }
  entries.set(key, { tree, chars });
  cachedChars += chars;
  for (const [oldestKey, oldest] of entries) {
    if (cachedChars <= MAX_CACHED_MARKDOWN_CHARS) break;
    entries.delete(oldestKey);
    cachedChars -= oldest.chars;
  }
};

/**
 * Remark attacher. `scope` must identify everything besides the text that
 * changes the resulting tree (the rest of the plugin configuration).
 */
export function remarkMarkdownRenderCache(this: unknown, scope = ""): void {
  const processor = this as UnifiedLike;
  const base = Object.getPrototypeOf(processor) as Partial<UnifiedLike>;
  const baseParse = base.parse;
  const baseRunSync = base.runSync;
  if (typeof baseParse !== "function" || typeof baseRunSync !== "function") {
    return;
  }

  processor.parse = function parseWithCache(this: unknown, file?: unknown) {
    if (typeof file === "string") {
      const tree = readEntry(cacheKey(scope, file));
      if (tree) {
        hits += 1;
        const placeholder = { type: "root", children: [] };
        pendingHits.set(placeholder, tree);
        return placeholder;
      }
    }
    return baseParse.call(this, file);
  };

  processor.runSync = function runSyncWithCache(
    this: unknown,
    tree: unknown,
    file?: unknown,
  ) {
    if (tree && typeof tree === "object") {
      const cached = pendingHits.get(tree);
      if (cached) {
        pendingHits.delete(tree);
        return cached;
      }
    }
    const result = baseRunSync.call(this, tree, file);
    if (typeof file === "string" && result && typeof result === "object") {
      misses += 1;
      writeEntry(cacheKey(scope, file), result, file.length);
    }
    return result;
  };
}

export const getMarkdownRenderCacheStats = () => ({
  hits,
  misses,
  entries: entries.size,
  chars: cachedChars,
});

export const clearMarkdownRenderCache = () => {
  entries.clear();
  cachedChars = 0;
  hits = 0;
  misses = 0;
};
