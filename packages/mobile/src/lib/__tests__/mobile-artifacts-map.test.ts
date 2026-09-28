import { describe, expect, test } from "bun:test";
import {
  isMobileDisplayPayload,
  parseChatArtifacts,
} from "../mobile-artifacts";

const routeMap = {
  kind: "map-route",
  version: 1,
  markers: [
    { id: "origin", name: "Ferry Building", lat: 37.7952, lng: -122.3938, role: "origin" },
    { id: "destination", name: "Golden Gate Bridge", lat: 37.8075, lng: -122.4756, role: "destination" },
  ],
  route: {
    mode: "driving",
    originId: "origin",
    destinationId: "destination",
    distanceMeters: 8653,
    durationSeconds: 1164,
    polyline: "abc123",
  },
};

const pinsMap = {
  kind: "map-route",
  version: 1,
  markers: [{ id: "p1", name: "Blue Bottle Coffee", lat: 37.7961, lng: -122.3939 }],
};

describe("map-route mobile artifacts", () => {
  test("accepts valid map-route payloads from the bridge", () => {
    expect(isMobileDisplayPayload(routeMap)).toBe(true);
    expect(isMobileDisplayPayload(pinsMap)).toBe(true);
    const parsed = parseChatArtifacts([routeMap], "c1");
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.payload.kind).toBe("map-route");
  });

  test("rejects malformed map-route payloads", () => {
    expect(isMobileDisplayPayload({ kind: "map-route", markers: [] })).toBe(false);
    expect(
      isMobileDisplayPayload({
        kind: "map-route",
        markers: [{ id: "p1", name: "X", lat: "nope", lng: 0 }],
      }),
    ).toBe(false);
    expect(
      isMobileDisplayPayload({ ...routeMap, route: { polyline: "" } }),
    ).toBe(false);
  });

});
