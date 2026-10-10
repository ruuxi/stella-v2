/**
 * A local HTML document's relative assets (`<img src="img/x.png">`, a
 * stylesheet, a script), for viewers that hold the document's text rather
 * than serving its folder: the website and the phone. They read each asset
 * through their own file lane and embed it, so the document renders as it
 * does on the desktop.
 *
 * Only paths inside the document's own folder are considered: `..` past the
 * folder, absolute paths, URLs and hidden files or folders are left alone.
 */

export type HtmlAssetKind = "image" | "text";

export type HtmlAssetLoader = (asset: {
  path: string;
  kind: HtmlAssetKind;
}) => Promise<string | null>;

const MAX_ASSETS = 64;
const MAX_EMBEDDED_CHARS = 48 * 1024 * 1024;
const CONCURRENCY = 4;

const TAG_RE = /<(img|video|link|script)\b[^>]*>/gi;
const ATTRIBUTE_RE = /(\s)(src|href|poster|rel)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

type AssetSlot = {
  tag: string;
  start: number;
  end: number;
  attribute: string;
  ref: string;
  kind: HtmlAssetKind;
  mode: "attribute" | "style" | "script";
};

const decodeRef = (value: string) => {
  const withoutSuffix = value.split(/[?#]/u, 1)[0] ?? "";
  try {
    return decodeURIComponent(withoutSuffix);
  } catch {
    return withoutSuffix;
  }
};

/**
 * The absolute path `ref` names relative to the document at `documentPath`,
 * or null when it is not a plain relative path inside the document's folder.
 */
export const resolveRelativeHtmlAsset = (
  documentPath: string,
  ref: string,
): string | null => {
  const trimmed = ref.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    SCHEME_RE.test(trimmed)
  ) {
    return null;
  }
  const slash = Math.max(documentPath.lastIndexOf("/"), documentPath.lastIndexOf("\\"));
  if (slash < 0) return null;
  const separator = documentPath[slash] ?? "/";
  const directory = documentPath.slice(0, slash);
  const parts: string[] = [];
  for (const segment of decodeRef(trimmed).split(/[\\/]/u)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (segment.startsWith(".") || segment.includes("\0")) return null;
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  return `${directory}${separator}${parts.join(separator)}`;
};

const attributesOf = (tag: string) => {
  const found = new Map<string, { value: string; index: number; length: number }>();
  for (const match of tag.matchAll(ATTRIBUTE_RE)) {
    const name = match[2]!.toLowerCase();
    if (found.has(name)) continue;
    found.set(name, {
      value: match[5] ?? match[6] ?? match[7] ?? "",
      index: match.index!,
      length: match[0].length,
    });
  }
  return found;
};

const findAssetSlots = (html: string): AssetSlot[] => {
  const slots: AssetSlot[] = [];
  for (const match of html.matchAll(TAG_RE)) {
    const tag = match[0];
    const name = match[1]!.toLowerCase();
    const attributes = attributesOf(tag);
    const push = (
      attribute: string,
      kind: HtmlAssetKind,
      mode: AssetSlot["mode"],
    ) => {
      const value = attributes.get(attribute)?.value;
      if (!value) return;
      slots.push({
        tag,
        start: match.index!,
        end: match.index! + tag.length,
        attribute,
        ref: value,
        kind,
        mode,
      });
    };
    if (name === "img") push("src", "image", "attribute");
    else if (name === "video") push("poster", "image", "attribute");
    else if (name === "script") push("src", "text", "script");
    else if (
      name === "link" &&
      /(?:^|\s)stylesheet(?:\s|$)/iu.test(attributes.get("rel")?.value ?? "")
    ) {
      push("href", "text", "style");
    }
  }
  return slots;
};

/** The absolute paths of the document's relative assets inside its folder. */
export const relativeHtmlAssetPaths = (
  html: string,
  documentPath: string,
): string[] => {
  const paths = new Set<string>();
  for (const slot of findAssetSlots(html)) {
    const resolved = resolveRelativeHtmlAsset(documentPath, slot.ref);
    if (resolved) paths.add(resolved);
    if (paths.size >= MAX_ASSETS) break;
  }
  return [...paths];
};

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const withAttribute = (tag: string, attribute: string, value: string) => {
  const existing = attributesOf(tag).get(attribute);
  if (!existing) return tag;
  const match = tag.slice(existing.index, existing.index + existing.length);
  const prefix = /^(\s)([^=\s]+)(\s*=\s*)/u.exec(match)?.[0] ?? ` ${attribute}=`;
  return (
    tag.slice(0, existing.index) +
    `${prefix}"${escapeAttribute(value)}"` +
    tag.slice(existing.index + existing.length)
  );
};

/**
 * `html` with each relative image, stylesheet and script inside the
 * document's folder embedded: images as the data URIs `load` returns for
 * them, stylesheets and scripts inline as the text it returns. An asset
 * `load` cannot supply keeps its original reference.
 */
export const embedRelativeHtmlAssets = async (
  html: string,
  documentPath: string,
  load: HtmlAssetLoader,
  signal?: AbortSignal,
): Promise<string> => {
  const slots = findAssetSlots(html).filter(
    (slot) => resolveRelativeHtmlAsset(documentPath, slot.ref) !== null,
  );
  if (slots.length === 0) return html;
  const keys = [
    ...new Set(
      slots.map(
        (slot) => `${slot.kind}\0${resolveRelativeHtmlAsset(documentPath, slot.ref)}`,
      ),
    ),
  ].slice(0, MAX_ASSETS);
  const loaded = new Map<string, string>();
  let embeddedChars = 0;
  let next = 0;
  const worker = async () => {
    while (next < keys.length && !signal?.aborted) {
      const key = keys[next++]!;
      if (embeddedChars >= MAX_EMBEDDED_CHARS) return;
      const [kind, path] = key.split("\0") as [HtmlAssetKind, string];
      const content = await load({ path, kind }).catch(() => null);
      if (content === null || embeddedChars + content.length > MAX_EMBEDDED_CHARS) {
        continue;
      }
      embeddedChars += content.length;
      loaded.set(key, content);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (signal?.aborted || loaded.size === 0) return html;

  let output = "";
  let cursor = 0;
  for (const slot of slots) {
    if (slot.start < cursor) continue;
    const content = loaded.get(
      `${slot.kind}\0${resolveRelativeHtmlAsset(documentPath, slot.ref)}`,
    );
    if (content === undefined) continue;
    output += html.slice(cursor, slot.start);
    cursor = slot.end;
    if (slot.mode === "attribute") {
      output += withAttribute(slot.tag, slot.attribute, content);
    } else if (slot.mode === "style") {
      output += `<style>${content.replace(/<\/style/giu, "<\\/style")}</style>`;
    } else {
      const closingRe = /\s*<\/script\s*>/iuy;
      closingRe.lastIndex = cursor;
      const closing = closingRe.exec(html);
      if (!closing) {
        output += slot.tag;
        continue;
      }
      cursor += closing[0].length;
      const open = slot.tag.replace(
        ATTRIBUTE_RE,
        (attribute: string, _space: string, name: string) =>
          name.toLowerCase() === "src" ? "" : attribute,
      );
      output += `${open}${content.replace(/<\/script/giu, "<\\/script")}</script>`;
    }
  }
  return output + html.slice(cursor);
};
