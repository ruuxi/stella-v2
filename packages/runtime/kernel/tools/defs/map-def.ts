/**
 * The `map` tool's model-visible surface, split from the executable
 * definition so workerd hosts advertise the byte-identical tool. Resolution
 * itself lives in `map-resolve.ts`; the device and cloud definitions both
 * call it.
 */

export const MAP_TOOL_NAME = "map";

export const MAP_TOOL_DESCRIPTION =
  "Show the user an interactive map card inline in the chat — pinned places and/or a route with turn-by-turn-ready directions. Use when the user asks where something is, for places to go (restaurants, coffee, sights), or how to get somewhere. Provide natural inputs: `places` (up to 8 names/addresses) and/or `origin` + `destination` (+ `mode`). Resolution (geocoding, place ratings, route distance/duration) happens automatically; the result summary comes back for you to answer with, and the card includes an 'Open in Apple Maps' handoff. Don't use for abstract geography questions that need no map.";

export const MAP_TOOL_PROMPT_SNIPPET =
  "Show an inline interactive map (pins and/or a route) in the chat";

export const MAP_TOOL_WORKING_TEXT = "Mapping";

export const MAP_TOOL_SEARCH_TERMS = [
  "interactive map",
  "places and locations",
  "directions and routes",
  "restaurants coffee sights",
] as const;

export const MAP_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  description:
    "Show an interactive map card inline in the chat. Provide places to pin and/or origin+destination for a route.",
  properties: {
    places: {
      type: "array",
      items: { type: "string" },
      description:
        "Up to 8 places to pin, as natural queries — place names, addresses, or 'lat,lng' (e.g. 'Tartine Bakery San Francisco', '1 Ferry Building, SF'). Include the city/area when it isn't obvious from context.",
    },
    origin: {
      type: "string",
      description:
        "Route start, as a natural query. Requires destination. Combine with places to also pin stops along the way.",
    },
    destination: {
      type: "string",
      description: "Route end, as a natural query. Requires origin.",
    },
    mode: {
      type: "string",
      enum: ["driving", "walking", "cycling", "transit"],
      description: "Travel mode for the route. Defaults to driving.",
    },
    title: {
      type: "string",
      description:
        "Optional short card title (e.g. 'Coffee near the Ferry Building').",
    },
  },
};
