import type { EventRecord } from "@/features/chat/lib/event-transforms";
export type WebSearchImageHit = {
    title: string;
    url: string;
    image: string;
    favicon?: string;
};

export declare const deriveTurnWebSearchResults: (events: readonly EventRecord[]) => WebSearchImageHit[];
