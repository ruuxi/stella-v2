/**
 * Per-turn web-search image derivation.
 *
 * The `web` tool (search mode) persists its structured hits onto the
 * `tool_result` payload (see `runtime/kernel/tools/defs/web.ts` and the
 * worker spread in `runtime/worker/server.ts`). Each hit may carry optional
 * `image`/`favicon` URLs. We surface those as an inline
 * "Results from the web" strip, Claude-style — but only for hits that
 * actually have a thumbnail, since the cards are image-first.
 *
 * The model never sees these URLs (the text result stays clean); this is
 * purely a renderer affordance derived from already-persisted events.
 */
import type { EventRecord } from "@/features/chat/lib/event-transforms";
export type WebSearchImageHit = {
    title: string;
    url: string;
    image: string;
    favicon?: string;
};
/**
 * Pick the most recent `web` search result on this turn and return its
 * image-bearing hits (deduped by URL, capped). Returns `[]` for turns
 * with no web search or no thumbnailable results.
 */
export declare const deriveTurnWebSearchResults: (events: readonly EventRecord[]) => WebSearchImageHit[];
