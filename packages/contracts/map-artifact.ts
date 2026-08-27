import { z } from "zod";

export type MapTravelMode = "driving" | "walking" | "cycling" | "transit";

export type MapArtifactMarker = {

  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;

  placeId?: string;

  rating?: number;
  ratingCount?: number;
  role?: "origin" | "destination" | "place";
};

export type MapArtifactRouteStep = {
  instruction: string;
  distanceMeters: number;
};

export type MapArtifactRoute = {
  mode: MapTravelMode;

  originId: string;
  destinationId: string;
  distanceMeters: number;
  durationSeconds: number;

  summary?: string;

  polyline: string;

  steps?: MapArtifactRouteStep[];
};

export type MapRouteArtifact = {
  kind: "map-route";
  version: 1;
  title?: string;
  markers: MapArtifactMarker[];
  route?: MapArtifactRoute;
};

export const MAPS_SITE_BASE_URL = "https://stella.sh";
export const MAPS_SITE_URL_ENV = "STELLA_MAPS_SITE_URL";
export const MAPS_RESOLVE_PATH = "/api/maps/resolve";
export const MAPS_EMBED_PATH = "/maps/embed";

const markerSchema = z.object({
  id: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
});

const routeSchema = z.object({
  polyline: z.string().min(1),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
});

const mapRouteArtifactSchema = z.object({
  kind: z.literal("map-route"),
  markers: z.array(markerSchema).min(1),
  route: routeSchema.optional(),
});

export const isMapRouteArtifact = (
  value: unknown,
): value is MapRouteArtifact =>
  mapRouteArtifactSchema.safeParse(value).success;

const toBase64Url = (json: string): string => {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const mapsEmbedUrl = (
  artifact: MapRouteArtifact,
  options?: { mode?: "light" | "dark"; siteBaseUrl?: string },
): string => {
  const base = (options?.siteBaseUrl ?? MAPS_SITE_BASE_URL).replace(/\/+$/, "");
  let slim: MapRouteArtifact = artifact;
  if (artifact.route?.steps) {
    const { steps: _steps, ...route } = artifact.route;
    slim = { ...artifact, route };
  }
  const params = new URLSearchParams({ d: toBase64Url(JSON.stringify(slim)) });
  if (options?.mode) params.set("mode", options.mode);
  params.set("embedded", "1");
  return `${base}${MAPS_EMBED_PATH}?${params.toString()}`;
};

const APPLE_MAPS_DIRFLG: Record<MapTravelMode, string> = {
  driving: "d",
  walking: "w",
  cycling: "c",
  transit: "r",
};

export const appleMapsUrl = (artifact: MapRouteArtifact): string => {
  const params = new URLSearchParams();
  if (artifact.route) {
    const origin = artifact.markers.find(
      (marker) => marker.id === artifact.route?.originId,
    );
    const destination = artifact.markers.find(
      (marker) => marker.id === artifact.route?.destinationId,
    );
    if (origin && destination) {
      params.set("saddr", `${origin.lat},${origin.lng}`);
      params.set("daddr", `${destination.lat},${destination.lng}`);
      params.set("dirflg", APPLE_MAPS_DIRFLG[artifact.route.mode]);
      return `https://maps.apple.com/?${params.toString()}`;
    }
  }
  const first = artifact.markers[0];
  params.set("q", first?.name ?? "Location");
  if (first) params.set("ll", `${first.lat},${first.lng}`);
  return `https://maps.apple.com/?${params.toString()}`;
};
