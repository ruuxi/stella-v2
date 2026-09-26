"use client";

import { useEffect } from "react";
import {
  adoptChatFrameSource,
  CHAT_APP_PATH,
  CHAT_FRAME_ID,
} from "./chat-frame-source";

type ChatFrameProps = {
  className: string;
};

/**
 * The page's inline boot script normally sets the frame source during HTML
 * parse. Client-side navigations into /chat never run that script, so the
 * hydrated component finishes the job when the source is still unset.
 */
export function ChatFrame({ className }: ChatFrameProps) {
  useEffect(() => {
    adoptChatFrameSource(CHAT_FRAME_ID, CHAT_APP_PATH);
  }, []);

  return (
    <iframe
      id={CHAT_FRAME_ID}
      className={className}
      title="Stella chat"
      allow="microphone; clipboard-read; clipboard-write"
      // The boot script adds `src` before hydration.
      suppressHydrationWarning
    />
  );
}
