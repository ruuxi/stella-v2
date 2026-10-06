/**
 * Resolve natural map inputs into a `map-route` artifact with Google Places
 * (New) text search and the Directions API, using the server-side
 * `GOOGLE_MAPS_SERVER_API_KEY`. Backs `POST /api/maps/resolve` for the desktop
 * `map` tool and runs in-process for the cloud one.
 *
 * Best-effort: partial place resolution succeeds with the misses listed in
 * `unresolved`; a failed route is an error, since a route card without a route
 * is useless.
 */

import type {
  MapArtifactMarker,
  MapArtifactRoute,
  MapArtifactRouteStep,
  MapRouteArtifact,
  MapTravelMode,
} from "@stella/contracts/map-artifact";

const MAX_PLACES = 8;
const MAX_ROUTE_STEPS = 20;
const GOOGLE_TIMEOUT_MS = 12_000;

const TRAVEL_MODES = new Set<MapTravelMode>(["driving", "walking", "cycling", "transit"]);

const DIRECTIONS_MODE: Record<MapTravelMode, string> = {
  driving: "driving",
  walking: "walking",
  cycling: "bicycling",
  transit: "transit",
};

type ResolveRequest = {
  places: string[];
  origin?: string;
  destination?: string;
  mode: MapTravelMode;
  title?: string;
};

export type MapResolveResult =
  | { status: 200; body: { map: MapRouteArtifact; unresolved: string[] } }
  | { status: 400 | 422 | 502 | 503; body: { error: string } };

const asTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const parseBody = (raw: unknown): ResolveRequest | string => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Request body must be JSON.";
  const body = raw as Record<string, unknown>;
  const places = Array.isArray(body.places)
    ? body.places.map(asTrimmedString).filter((entry) => entry.length > 0)
    : [];
  const origin = asTrimmedString(body.origin);
  const destination = asTrimmedString(body.destination);
  if ((origin && !destination) || (!origin && destination)) {
    return "Provide both origin and destination for a route, or neither.";
  }
  if (places.length === 0 && !origin) return "Provide places to pin and/or an origin + destination route.";
  if (places.length > MAX_PLACES) return `At most ${MAX_PLACES} places per map.`;
  const modeRaw = asTrimmedString(body.mode).toLowerCase();
  const mode = TRAVEL_MODES.has(modeRaw as MapTravelMode) ? (modeRaw as MapTravelMode) : "driving";
  const title = asTrimmedString(body.title);
  return {
    places,
    ...(origin ? { origin, destination } : {}),
    mode,
    ...(title ? { title } : {}),
  };
};

const fetchGoogle = (fetchImpl: typeof fetch, input: string, signal: AbortSignal | undefined, init?: RequestInit) => {
  const timeout = AbortSignal.timeout(GOOGLE_TIMEOUT_MS);
  return fetchImpl(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
};

type ResolvedPlace = Omit<MapArtifactMarker, "id" | "role">;

const resolvePlace = async (
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<ResolvedPlace | null> => {
  const response = await fetchGoogle(fetchImpl, "https://places.googleapis.com/v1/places:searchText", signal, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({ textQuery: query, pageSize: 1 }),
  });
  if (!response.ok) throw new Error(`Places search failed (${response.status}).`);
  const data = (await response.json()) as {
    places?: Array<{
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      rating?: number;
      userRatingCount?: number;
    }>;
  };
  const place = data.places?.[0];
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (!place || typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    name: place.displayName?.text?.trim() || query,
    lat,
    lng,
    ...(place.formattedAddress ? { address: place.formattedAddress } : {}),
    ...(place.id ? { placeId: place.id } : {}),
    ...(typeof place.rating === "number" ? { rating: place.rating } : {}),
    ...(typeof place.userRatingCount === "number" ? { ratingCount: place.userRatingCount } : {}),
  };
};

const stripHtml = (html: string): string =>
  html
    .replace(/<div[^>]*>/gi, " — ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

type ResolvedRoute = { origin: MapArtifactMarker; destination: MapArtifactMarker; route: MapArtifactRoute };

const resolveRoute = async (
  originQuery: string,
  destinationQuery: string,
  mode: MapTravelMode,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<ResolvedRoute | string> => {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", originQuery);
  url.searchParams.set("destination", destinationQuery);
  url.searchParams.set("mode", DIRECTIONS_MODE[mode]);
  url.searchParams.set("key", apiKey);
  const response = await fetchGoogle(fetchImpl, url.toString(), signal);
  if (!response.ok) return `Directions lookup failed (${response.status}).`;
  const data = (await response.json()) as {
    status?: string;
    error_message?: string;
    routes?: Array<{
      summary?: string;
      overview_polyline?: { points?: string };
      legs?: Array<{
        distance?: { value?: number };
        duration?: { value?: number };
        start_address?: string;
        end_address?: string;
        start_location?: { lat?: number; lng?: number };
        end_location?: { lat?: number; lng?: number };
        steps?: Array<{ html_instructions?: string; distance?: { value?: number } }>;
      }>;
    }>;
  };
  if (data.status === "ZERO_RESULTS") {
    return `No ${mode} route found between "${originQuery}" and "${destinationQuery}".`;
  }
  if (data.status !== "OK") {
    return data.error_message
      ? `Directions lookup failed: ${data.error_message}`
      : `Directions lookup failed (${data.status ?? "no status"}).`;
  }
  const route = data.routes?.[0];
  const leg = route?.legs?.[0];
  const polyline = route?.overview_polyline?.points;
  const start = leg?.start_location;
  const end = leg?.end_location;
  if (
    !route ||
    !leg ||
    !polyline ||
    typeof start?.lat !== "number" ||
    typeof start.lng !== "number" ||
    typeof end?.lat !== "number" ||
    typeof end.lng !== "number"
  ) {
    return "Directions lookup returned an unusable route.";
  }
  const steps: MapArtifactRouteStep[] = (leg.steps ?? [])
    .slice(0, MAX_ROUTE_STEPS)
    .map((step) => ({ instruction: stripHtml(step.html_instructions ?? ""), distanceMeters: step.distance?.value ?? 0 }))
    .filter((step) => step.instruction.length > 0);
  return {
    origin: {
      id: "origin",
      name: originQuery,
      lat: start.lat,
      lng: start.lng,
      ...(leg.start_address ? { address: leg.start_address } : {}),
      role: "origin",
    },
    destination: {
      id: "destination",
      name: destinationQuery,
      lat: end.lat,
      lng: end.lng,
      ...(leg.end_address ? { address: leg.end_address } : {}),
      role: "destination",
    },
    route: {
      mode,
      originId: "origin",
      destinationId: "destination",
      distanceMeters: leg.distance?.value ?? 0,
      durationSeconds: leg.duration?.value ?? 0,
      ...(route.summary ? { summary: route.summary } : {}),
      polyline,
      ...(steps.length > 0 ? { steps } : {}),
    },
  };
};

export const mapsServerKey = (env: unknown): string | undefined => {
  const value = (env as { GOOGLE_MAPS_SERVER_API_KEY?: unknown }).GOOGLE_MAPS_SERVER_API_KEY;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const resolveMapRequest = async (
  raw: unknown,
  apiKey: string | undefined,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<MapResolveResult> => {
  if (!apiKey) return { status: 503, body: { error: "Maps aren't set up on this Stella." } };
  const parsed = parseBody(raw);
  if (typeof parsed === "string") return { status: 400, body: { error: parsed } };
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const markers: MapArtifactMarker[] = [];
    let route: MapArtifactRoute | undefined;
    const unresolved: string[] = [];
    if (parsed.origin && parsed.destination) {
      const resolved = await resolveRoute(parsed.origin, parsed.destination, parsed.mode, apiKey, fetchImpl, options.signal);
      if (typeof resolved === "string") return { status: 422, body: { error: resolved } };
      markers.push(resolved.origin, resolved.destination);
      route = resolved.route;
    }
    for (const [index, query] of parsed.places.entries()) {
      const place = await resolvePlace(query, apiKey, fetchImpl, options.signal);
      if (!place) {
        unresolved.push(query);
        continue;
      }
      markers.push({ id: `p${index + 1}`, role: "place", ...place });
    }
    if (markers.length === 0) {
      return {
        status: 422,
        body: {
          error: unresolved.length > 0
            ? `Could not find: ${unresolved.join("; ")}.`
            : "Nothing could be resolved for this map.",
        },
      };
    }
    const map: MapRouteArtifact = {
      kind: "map-route",
      version: 1,
      ...(parsed.title ? { title: parsed.title } : {}),
      markers,
      ...(route ? { route } : {}),
    };
    return { status: 200, body: { map, unresolved } };
  } catch (error) {
    return { status: 502, body: { error: `Map resolution failed: ${(error as Error).message}` } };
  }
};
