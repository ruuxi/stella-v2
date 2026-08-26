import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ChatApp } from "@/app/chat/App";

/**
 * `?c=<conversationId>` is the canonical chat-route search param and the
 * single live source of truth for which conversation is active. We use a
 * search param (not a path param) so `/chat` with no conversation can still
 * render the home pane while the bootstrap is preparing one.
 */
const ChatSearch = z.object({
  c: z.string().optional(),
});

export const Route = createFileRoute("/chat")({
  validateSearch: ChatSearch,
  // RootLayout repairs a missing or foreign `?c=` only after Better Auth and
  // the ownership-migration gate prove which server-owned conversation is
  // safe for the current account. Route loaders must never consult SQLite or
  // an unscoped renderer cache: either can still name the previous owner.
  component: ChatApp,
});
