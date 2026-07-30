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
  // Auth-aware route repair lives in the root after the account scope is
  // known. A global synchronous cache cannot safely decide whether its id
  // belongs to the anonymous/connected identity that is active now.
  component: ChatApp,
});
