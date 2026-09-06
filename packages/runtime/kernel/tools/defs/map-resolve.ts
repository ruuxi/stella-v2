/**
 * Pure resolution behind the `map` tool: validate the natural-language
 * request, POST it to the stella.sh maps resolver (Google Places /
 * Directions with a server-side key — zero keys on the user's side), and
 * summarize the resulting `map-route` artifact for the model. No host
 * dependencies, so the device kernel and the cloud Durable Object share it.
 */

import {
  isMapRouteArtifact,
  MAPS_RESOLVE_PATH,
  MAPS_SITE_BASE_URL,
  type MapRouteArtifact,
} from "@stella/contracts/map-artifact";

export const MAP_RESOLVE_TIMEOUT_MS = 25_000;
const MAX_PLACES = 8;

export type MapResolveRequest = {
  places: string[];
  origin: string;
  destination: string;
  mode: string;
  title: string;
};

export type MapResolveOutcome =
  | { ok: true; map: MapRouteArtifact; summary: string }
  | { ok: false; error: string };

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** Normalize model arguments; `null` with an error message when unusable. */
export const parseMapToolArgs = (
  args: Record<string, unknown>,
): { request: MapResolveRequest } | { error: string } => {
  const places = Array.isArray(args.places)
    ? args.places
        .map(asTrimmedString)
        .filter((entry) => entry.length > 0)
        .slice(0, MAX_PLACES)
    : [];
  const origin = asTrimmedString(args.origin);
  const destination = asTrimmedString(args.destination);
  const mode = asTrimmedString(args.mode).toLowerCase();
  const title = asTrimmedString(args.title);
  if ((origin && !destination) || (!origin && destination)) {
    return {
      error: "Provide both origin and destination for a route, or neither.",
    };
  }
  if (places.length === 0 && !origin) {
    return { error: "Provide places to pin and/or an origin + destination route." };
  }
  return { request: { places, origin, destination, mode, title } };
};

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

/** Compact text the model can speak from; the card itself shows the map. */
export const summarizeMapArtifact = (
  map: MapRouteArtifact,
  unresolved: string[],
): string => {
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
    for (const step of (map.route.steps ?? []).slice(0, 10)) {
      lines.push(`  - ${step.instruction}`);
    }
  }
  const places = map.markers.filter((marker) => marker.role === "place");
  if (places.length > 0) {
    lines.push(`Pinned ${places.length === 1 ? "place" : "places"}:`);
    for (const place of places) {
      const rating =
        typeof place.rating === "number"
          ? ` — ${place.rating.toFixed(1)}★${
              typeof place.ratingCount === "number"
                ? ` (${place.ratingCount.toLocaleString()})`
                : ""
            }`
          : "";
      lines.push(
        `  - ${place.name}${rating}${place.address ? ` — ${place.address}` : ""}`,
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

export type MapResolveOptions = {
  /** stella.sh base (or a self-hosted override), no trailing slash. */
  siteBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Composed with the resolve deadline by the caller. */
  signal?: AbortSignal;
};

/** POST the request to the resolver and shape the outcome. Never throws. */
export const resolveMapArtifact = async (
  request: MapResolveRequest,
  options: MapResolveOptions = {},
): Promise<MapResolveOutcome> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.siteBaseUrl ?? MAPS_SITE_BASE_URL).replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}${MAPS_RESOLVE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(request.places.length > 0 ? { places: request.places } : {}),
        ...(request.origin
          ? { origin: request.origin, destination: request.destination }
          : {}),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(request.title ? { title: request.title } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON error body; fall through to the status message.
    }
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    if (!response.ok) {
      const message =
        asTrimmedString(record.error) ||
        `map service returned ${response.status}`;
      return { ok: false, error: `Map lookup failed: ${message}` };
    }
    const map = record.map;
    if (!isMapRouteArtifact(map)) {
      return {
        ok: false,
        error: "Map lookup failed: the map service returned no usable map.",
      };
    }
    const unresolved = Array.isArray(record.unresolved)
      ? record.unresolved.map(asTrimmedString).filter(Boolean)
      : [];
    return { ok: true, map, summary: summarizeMapArtifact(map, unresolved) };
  } catch (error) {
    const message =
      (error as Error).name === "AbortError"
        ? "timed out"
        : (error as Error).message;
    return { ok: false, error: `Map lookup failed: ${message}` };
  }
};
