"use client";

import { useEffect, useRef } from "react";

type ChatFrameProps = {
  className: string;
};

const CHAT_APP_PATH = "/chat-app/index.html";

/**
 * OAuth returns a short-lived one-time token in the URL fragment. Fragments
 * never reach Next, so transfer that credential once into the same-origin
 * renderer iframe and immediately erase it from the public address bar.
 */
export function ChatFrame({ className }: ChatFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const rawFragment = window.location.hash.replace(/^#\??/, "");
    const containsHandoff =
      rawFragment.length > 0 && new URLSearchParams(rawFragment).has("ott");
    frameRef.current?.setAttribute(
      "src",
      `${CHAT_APP_PATH}${containsHandoff ? window.location.hash : ""}`,
    );
    if (containsHandoff) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  }, []);

  return (
    <iframe
      ref={frameRef}
      className={className}
      title="Stella chat"
      allow="microphone; clipboard-read; clipboard-write"
    />
  );
}
