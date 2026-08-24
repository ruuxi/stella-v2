import type {
  AnchorHTMLAttributes,
  CSSProperties,
  ImgHTMLAttributes,
} from "react";
import { memo, useMemo, useRef } from "react";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import { cn } from "@/shared/lib/utils";
import {
  remarkStellaFileLinks,
  STELLA_FILE_TAG,
  STELLA_FILE_TAG_ATTRIBUTES,
} from "@/features/chat/lib/stella-file-links";
import {
  isUnmodifiedPrimaryClick,
  normalizedHttpUrl,
  openUrlInStellaBrowser,
} from "@/features/chat/lib/stella-web-links";
import { StellaFileLink } from "./StellaFileLink";
import {
  hasCompleteEmojiSpritePack,
  useActiveEmojiPack,
} from "./emoji-sprites/active-emoji-pack";
import { remarkEmojiSprites } from "./emoji-sprites/remark-emoji-sprites";
import { shouldUseBoundedMarkdownPlaintext } from "@/features/chat/streaming/markdown-chunks";
import {
  cellToRowCol,
  getEmojiSpriteGridSize,
  parseEmojiSpriteUrl,
} from "./emoji-sprites/sprite-map";
import "./markdown.css";

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;

  hideHorizontalRules?: boolean;
}

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  node?: unknown;
};

const DEFAULT_REMARK_PLUGINS = Object.values(defaultRemarkPlugins);
const BASE_REMARK_PLUGINS = [...DEFAULT_REMARK_PLUGINS, remarkStellaFileLinks];

const ALLOWED_TAGS: Record<string, string[]> = {
  [STELLA_FILE_TAG]: [...STELLA_FILE_TAG_ATTRIBUTES],
};

const LINK_SAFETY = { enabled: false } as const;

const UNBOUNDED_STREAMDOWN_HEIGHT = Number.POSITIVE_INFINITY;

const areMarkdownPropsEqual = (
  prev: MarkdownProps,
  next: MarkdownProps,
): boolean =>
  prev.text === next.text &&
  prev.cacheKey === next.cacheKey &&
  prev.className === next.className &&
  Boolean(prev.hideHorizontalRules) === Boolean(next.hideHorizontalRules);

const MarkdownImage = ({
  src,
  alt,
  className,
  ...rest
}: MarkdownImageProps) => {
  const cell = typeof src === "string" ? parseEmojiSpriteUrl(src) : null;
  if (!cell) {
    return <img {...rest} src={src} alt={alt} className={className} />;
  }
  const { row, col } = cellToRowCol(cell.cell);
  const gridSize = getEmojiSpriteGridSize();
  const last = Math.max(1, gridSize - 1);
  return (
    <span
      className={cn("ai-emoji", className)}
      style={
        {
          "--ai-emoji-row": String(row),
          "--ai-emoji-col": String(col),
          backgroundImage: `var(--ai-emoji-sheet-${cell.sheet}-url)`,
          backgroundSize: `${gridSize * 100}% ${gridSize * 100}%`,
          backgroundPosition: `${(col / last) * 100}% ${(row / last) * 100}%`,
        } as CSSProperties
      }
      role="img"
      aria-label={alt ?? ""}
    />
  );
};

type MarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  node?: unknown;
};

const MarkdownLink = ({
  href,
  onClick,
  node: _node,
  ...rest
}: MarkdownLinkProps) => (
  <a
    {...rest}
    data-streamdown="link"
    href={href}
    onClick={(event) => {
      onClick?.(event);
      if (event.defaultPrevented || !isUnmodifiedPrimaryClick(event)) return;

      const url = normalizedHttpUrl(event.currentTarget.href);
      const api = window.electronAPI?.browserView;
      if (!url || !api) return;

      event.preventDefault();
      void openUrlInStellaBrowser(url, api).catch(() => {
        window.electronAPI?.system?.openExternal(url);
      });
    }}
  />
);

const buildComponents = (hideHorizontalRules: boolean) => ({
  ...(hideHorizontalRules ? { hr: () => null } : {}),
  a: MarkdownLink,
  img: MarkdownImage,
  [STELLA_FILE_TAG]: StellaFileLink,
});

let nextAnonCacheKey = 0;

export const Markdown = memo(function Markdown({
  text,
  cacheKey,
  className,
  hideHorizontalRules = false,
}: MarkdownProps) {

  const anonCacheKeyRef = useRef<string | null>(null);
  if (anonCacheKeyRef.current === null) {
    anonCacheKeyRef.current = `markdown-anon-${nextAnonCacheKey++}`;
  }
  const effectiveCacheKey = cacheKey ?? anonCacheKeyRef.current;
  const components = useMemo(
    () => buildComponents(hideHorizontalRules),
    [hideHorizontalRules],
  );
  const [activeEmojiPack] = useActiveEmojiPack();
  const emojiSpritesEnabled = hasCompleteEmojiSpritePack(activeEmojiPack);
  const remarkPlugins = useMemo(
    () =>
      emojiSpritesEnabled
        ? [...BASE_REMARK_PLUGINS, remarkEmojiSprites]
        : BASE_REMARK_PLUGINS,
    [emojiSpritesEnabled],
  );

  const emojiVars = useMemo<CSSProperties | undefined>(() => {
    if (!emojiSpritesEnabled || !activeEmojiPack) return undefined;
    return Object.fromEntries(
      activeEmojiPack.sheetUrls.map((url, index) => [
        `--ai-emoji-sheet-${index}-url`,
        `url("${url}")`,
      ]),
    ) as CSSProperties;
  }, [activeEmojiPack, emojiSpritesEnabled]);
  const streamdownKey = `${effectiveCacheKey}:${emojiSpritesEnabled ? "emoji" : "plain"}`;

  const useBoundedPlaintext = shouldUseBoundedMarkdownPlaintext(text.length);
  return (
    <div style={emojiVars}>
      {useBoundedPlaintext ? (
        <div className={cn("markdown markdown--streaming-plaintext", className)}>
          {text}
        </div>
      ) : (
        <Streamdown
          key={streamdownKey}
          mode="static"
          codeBlockMaxHeight={UNBOUNDED_STREAMDOWN_HEIGHT}
          tableMaxHeight={UNBOUNDED_STREAMDOWN_HEIGHT}
          className={cn("markdown", className)}
          remarkPlugins={remarkPlugins}
          components={components}
          allowedTags={ALLOWED_TAGS}
          linkSafety={LINK_SAFETY}
        >
          {text}
        </Streamdown>
      )}
    </div>
  );
}, areMarkdownPropsEqual);
