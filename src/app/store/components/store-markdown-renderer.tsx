"use client";

import { memo } from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown";

const REMARK_PLUGINS = Object.values(defaultRemarkPlugins);
const REHYPE_PLUGINS = Object.values(defaultRehypePlugins);

type StoreMarkdownRendererProps = {
  text: string;
  className?: string;
};

/** Heavy markdown implementation, isolated from the initial Store bundle. */
export const StoreMarkdownRenderer = memo(function StoreMarkdownRenderer({
  text,
  className,
}: StoreMarkdownRendererProps) {
  return (
    <Streamdown
      className={className ? `markdown ${className}` : "markdown"}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      linkSafety={{ enabled: false }}
    >
      {text}
    </Streamdown>
  );
});
