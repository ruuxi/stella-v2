import type { EventRecord } from "@/features/chat/lib/event-transforms";
import type { MapRouteArtifact } from "@stella/contracts/map-artifact";
export type TurnMapArtifact = {

    id: string;
    map: MapRouteArtifact;
};
export declare const deriveTurnMapArtifacts: (events: readonly EventRecord[]) => TurnMapArtifact[];
