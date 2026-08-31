"use client";

import dynamic from "next/dynamic";

const LazyStoreMarkdownRenderer = dynamic(() =>
  import("./store-markdown-renderer").then(
    (module) => module.StoreMarkdownRenderer,
  ),
  {
    loading: () => (
      <div className="markdown" aria-busy="true">
        Loading formatted text…
      </div>
    ),
  },
);

type StoreMarkdownProps = {
  text: string;
  className?: string;
};

/** Defers the Store markdown stack until formatted copy is actually visible. */
export function StoreMarkdown({
  text,
  className,
}: StoreMarkdownProps) {
  return <LazyStoreMarkdownRenderer text={text} className={className} />;
}
