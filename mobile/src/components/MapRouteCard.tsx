import { useMemo } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { Icon } from "./Icon";
import type { MobileDisplayPayload } from "../types";
import { bytesToBase64Url } from "../lib/bridge-envelope";
import { artifactSubtitle, artifactTitle } from "../lib/mobile-artifacts";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { useTheme } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

/**
 * Inline interactive map card — the mobile renderer for the shared
 * `map-route` artifact (see the Stella repo's
 * `runtime/contracts/map-artifact.ts`). The map is the hosted stella.sh
 * Google Maps embed in a WebView (the Google key never ships in the app);
 * the footer is native with an "Open in Apple Maps" handoff for real
 * turn-by-turn navigation.
 */

export type MapRoutePayload = Extract<
  MobileDisplayPayload,
  { kind: "map-route" }
>;

const MAPS_EMBED_BASE_URL = "https://stella.sh/maps/embed";

const embedUrl = (payload: MapRoutePayload, dark: boolean): string => {
  // Steps aren't needed to draw the map and eat URL budget.
  const { route, ...rest } = payload;
  const slim = route
    ? { ...rest, route: { ...route, steps: undefined } }
    : rest;
  const encoded = bytesToBase64Url(utf8ToBytes(JSON.stringify(slim)));
  return `${MAPS_EMBED_BASE_URL}?d=${encoded}&mode=${dark ? "dark" : "light"}&embedded=1`;
};

const APPLE_MAPS_DIRFLG: Record<string, string> = {
  driving: "d",
  walking: "w",
  cycling: "c",
  transit: "r",
};

const appleMapsUrl = (payload: MapRoutePayload): string => {
  if (payload.route) {
    const origin = payload.markers.find(
      (marker) => marker.id === payload.route?.originId,
    );
    const destination = payload.markers.find(
      (marker) => marker.id === payload.route?.destinationId,
    );
    if (origin && destination) {
      const dirflg = APPLE_MAPS_DIRFLG[payload.route.mode] ?? "d";
      return `https://maps.apple.com/?saddr=${origin.lat},${origin.lng}&daddr=${destination.lat},${destination.lng}&dirflg=${dirflg}`;
    }
  }
  const first = payload.markers[0];
  if (!first) return "https://maps.apple.com/";
  return `https://maps.apple.com/?q=${encodeURIComponent(first.name)}&ll=${first.lat},${first.lng}`;
};

type MapRouteCardProps = {
  payload: MapRoutePayload;
  colors: Colors;
};

export function MapRouteCard({ payload, colors }: MapRouteCardProps) {
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const uri = useMemo(() => embedUrl(payload, isDark), [payload, isDark]);
  const title = artifactTitle(payload);
  const subtitle = artifactSubtitle(payload);

  return (
    <View style={styles.card}>
      <View style={styles.mapWrap}>
        <WebView
          source={{ uri }}
          style={styles.map}
          // The embed is self-contained; block navigations away from it so a
          // stray tap on Google attribution can't hijack the chat card.
          onShouldStartLoadWithRequest={(request) =>
            request.url.startsWith(MAPS_EMBED_BASE_URL) ||
            request.url.startsWith("about:blank")
          }
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={false}
          scrollEnabled={false}
          overScrollMode="never"
          androidLayerType="hardware"
        />
      </View>
      <View style={styles.footer}>
        <View style={styles.meta}>
          <Text
            style={styles.title}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {title}
          </Text>
          <Text
            style={styles.subtitle}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {subtitle}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open in Apple Maps"
          onPress={() => {
            Linking.openURL(appleMapsUrl(payload)).catch(() => {});
          }}
          style={({ pressed }) => [
            styles.handoff,
            pressed ? styles.handoffPressed : null,
          ]}
        >
          <Text
            style={styles.handoffText}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            Apple Maps
          </Text>
          <Icon name="arrow-up-right" size={14} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignSelf: "stretch",
      backgroundColor: fadeHex(colors.card, 0.8),
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    mapWrap: {
      height: 220,
      backgroundColor: colors.muted,
    },
    map: {
      flex: 1,
      backgroundColor: "transparent",
    },
    footer: {
      alignItems: "center",
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    meta: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 13,
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginTop: 1,
    },
    handoff: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    handoffPressed: {
      opacity: 0.72,
    },
    handoffText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
  });
