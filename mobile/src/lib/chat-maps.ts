import type { ChatArtifact, MobileDisplayPayload } from "../types";
import { artifactId, isMobileDisplayPayload } from "./mobile-artifacts";

/**
 * Client-side maps resolver for the offline chat — the mobile analog of the
 * desktop runtime's `map` tool (`runtime/kernel/tools/defs/map.ts`). It takes
 * natural inputs (place names, addresses, origin -> destination) and POSTs them
 * to the hosted stella.sh resolve endpoint, which geocodes/routes with a
 * server-side Google key (no API key ever ships in the app). The resolved
 * `map-route` payload is the same shared artifact the desktop bridge already
 * renders inline via `MapRouteCard`, so a resolved map just rides the assistant
 * message's `artifacts` and shows up as an interactive card.
 *
 * The offline responder is a plain text model with no native tool channel, so
 * the model requests a map through the `chat-tools.ts` text protocol and this
 * resolver runs the lookup on-device.
 */

const MAPS_RESOLVE_URL = "https://stella.sh/api/maps/resolve";
const RESOLVE_TIMEOUT_MS = 25_000;
const MAX_PLACES = 8;

export type MapToolInput = {
  places?: string[];
  origin?: string;
  destination?: string;
  mode?: string;
  title?: string;
};

type MapRoutePayload = Extract<MobileDisplayPayload, { kind: "map-route" }>;

export type MapResolveResult = {
  payload: MapRoutePayload;
  /** Compact text the model answers from; the card shows the map itself. */
  summary: string;
};

const asTrimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const VALID_MODES = new Set(["driving", "walking", "cycling", "transit"]);

const formatDistance = (meters: number): string => {
  if (!Number.isFinite(meters) || meters <= 0) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  const miles = meters / 1609.344;
  return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km (${
    miles >= 100 ? Math.round(miles) : miles.toFixed(1)
  } mi)`;
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} hr ${rest} min` : `${hours} hr`;
};

/** Mirror of the desktop map tool's `summarizeArtifact`. */
const summarizeMap = (map: MapRoutePayload, unresolved: string[]): string => {
  const lines: string[] = [];
  if (map.route) {
    const origin = map.markers.find((m) => m.id === map.route?.originId);
    const destination = map.markers.find(
      (m) => m.id === map.route?.destinationId,
    );
    const distance = formatDistance(map.route.distanceMeters);
    const duration = formatDuration(map.route.durationSeconds);
    lines.push(
      `${map.route.mode} route from ${origin?.name ?? "origin"} to ${
        destination?.name ?? "destination"
      }: ${[distance, duration].filter(Boolean).join(", ")}${
        map.route.summary ? ` (${map.route.summary})` : ""
      }.`,
    );
  }
  const places = map.markers.filter((marker) => marker.role === "place");
  if (places.length > 0) {
    lines.push(`Pinned ${places.length === 1 ? "place" : "places"}:`);
    for (const place of places) {
      const rating =
        typeof place.rating === "number"
          ? ` - ${place.rating.toFixed(1)} stars`
          : "";
      lines.push(
        `  - ${place.name}${rating}${
          place.address ? ` - ${place.address}` : ""
        }`,
      );
    }
  }
  if (unresolved.length > 0) {
    lines.push(`Could not find: ${unresolved.join("; ")}.`);
  }
  lines.push(
    "The interactive map card is now visible in the chat; don't re-describe the map itself.",
  );
  return lines.join("\n");
};

export type MapResolveOutcome =
  | { ok: true; result: MapResolveResult }
  | { ok: false; error: string };

/** Resolve a map request to a renderable payload + summary, or an error. */
export async function resolveMap(
  input: MapToolInput,
): Promise<MapResolveOutcome> {
  const places = Array.isArray(input.places)
    ? input.places.map(asTrimmed).filter(Boolean).slice(0, MAX_PLACES)
    : [];
  const origin = asTrimmed(input.origin);
  const destination = asTrimmed(input.destination);
  const mode = asTrimmed(input.mode).toLowerCase();
  const title = asTrimmed(input.title);

  if ((origin && !destination) || (!origin && destination)) {
    return {
      ok: false,
      error: "Provide both origin and destination for a route, or neither.",
    };
  }
  if (places.length === 0 && !origin) {
    return {
      ok: false,
      error: "Provide places to pin and/or an origin + destination route.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const response = await fetch(MAPS_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(places.length > 0 ? { places } : {}),
        ...(origin ? { origin, destination } : {}),
        ...(mode && VALID_MODES.has(mode) ? { mode } : {}),
        ...(title ? { title } : {}),
      }),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body; fall through to the status message.
    }
    const record =
      body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
    if (!response.ok) {
      const message =
        asTrimmed(record.error) || `map service returned ${response.status}`;
      return { ok: false, error: `Map lookup failed: ${message}` };
    }
    const map = record.map;
    if (!isMobileDisplayPayload(map) || map.kind !== "map-route") {
      return {
        ok: false,
        error: "Map lookup failed: the map service returned no usable map.",
      };
    }
    const unresolved = Array.isArray(record.unresolved)
      ? record.unresolved.map(asTrimmed).filter(Boolean)
      : [];
    return {
      ok: true,
      result: { payload: map, summary: summarizeMap(map, unresolved) },
    };
  } catch (error) {
    const message =
      (error as Error)?.name === "AbortError"
        ? "timed out"
        : ((error as Error)?.message ?? "network error");
    return { ok: false, error: `Map lookup failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap a resolved map payload as a ChatArtifact for an assistant message. */
export function mapArtifactFor(
  payload: MapRoutePayload,
  conversationId: string,
  index: number,
): ChatArtifact {
  return {
    id: artifactId(payload, conversationId, index),
    conversationId,
    payload,
  };
}
