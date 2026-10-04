import { memo, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { getAuthToken } from "../lib/auth-token";
import { tapLight } from "../lib/haptics";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import {
  requestOpenApp,
  useWorkspaceApp,
  workspaceAppPreviewUrl,
} from "../lib/workspace-app-links";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { Icon } from "./Icon";
import { NativeMenu } from "./NativeMenu";

/**
 * A cloud app a reply links (`stella://app/<slug>`): a still of the app on
 * top, then its icon, name and "App", with a menu. Tapping anywhere opens the
 * app in the Apps tab. Renders nothing for a slug that is not a ready app.
 */
export const AppPreviewCard = memo(function AppPreviewCard({
  slug,
  colors,
}: {
  slug: string;
  colors: Colors;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const app = useWorkspaceApp(slug);
  const [token, setToken] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getAuthToken()
      .then((value) => {
        if (!cancelled) setToken(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (app === null) return null;
  const title = app?.title ?? "";
  const previewUrl = app ? workspaceAppPreviewUrl(app) : null;
  const open = () => {
    tapLight();
    requestOpenApp(slug);
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={app ? `Open ${title}` : "Loading app"}
      disabled={!app}
      onPress={open}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.preview}>
        {/* Shown until the still arrives (it is captured on first view), and
            in its place if it cannot be. */}
        <View style={styles.previewPlaceholder}>
          {app?.icon ? (
            <Text style={styles.previewEmoji}>{app.icon}</Text>
          ) : (
            <Icon name="apps" size={28} color={colors.textMuted} />
          )}
        </View>
        {app && previewUrl && token && !previewFailed ? (
          <Image
            source={{
              uri: previewUrl,
              headers: { Authorization: `Bearer ${token}` },
              cacheKey: `app-preview:${app.slug}:${app.revision}`,
            }}
            cachePolicy="disk"
            contentFit="cover"
            contentPosition="top"
            transition={180}
            onError={() => setPreviewFailed(true)}
            style={StyleSheet.absoluteFill}
            accessibilityIgnoresInvertColors
          />
        ) : null}
      </View>
      <View style={styles.footer}>
        <View style={styles.tile}>
          {app?.icon ? (
            <Text style={styles.tileEmoji} maxFontSizeMultiplier={1}>
              {app.icon}
            </Text>
          ) : (
            <Icon name="apps" size={22} color={colors.text} />
          )}
        </View>
        <View style={styles.titles}>
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
            App
          </Text>
        </View>
        {app ? (
          <NativeMenu
            label={
              <Icon name="more-horizontal" size={18} color={colors.textMuted} />
            }
            accessibilityLabel={`More for ${title}`}
            width={36}
            height={36}
            circular
            items={[
              {
                id: "open",
                title: "Open",
                systemImage: "arrow.up.forward.app",
                onPress: open,
              },
            ]}
            onFallbackPress={() =>
              Alert.alert(title, undefined, [
                { text: "Open", onPress: open },
                { text: "Cancel", style: "cancel" },
              ])
            }
          />
        ) : null}
      </View>
    </Pressable>
  );
});

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignSelf: "stretch",
      backgroundColor: fadeHex(colors.card, 0.85),
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
      padding: 6,
    },
    cardPressed: { opacity: 0.85 },
    preview: {
      aspectRatio: 16 / 10,
      backgroundColor: colors.surfaceInset,
      borderCurve: "continuous",
      borderRadius: 17,
      overflow: "hidden",
    },
    previewPlaceholder: {
      ...StyleSheet.absoluteFill,
      alignItems: "center",
      justifyContent: "center",
    },
    previewEmoji: { fontSize: 44 },
    footer: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingBottom: 6,
      paddingHorizontal: 8,
      paddingTop: 10,
    },
    tile: {
      alignItems: "center",
      backgroundColor: colors.surfaceInset,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    tileEmoji: { fontSize: 24 },
    titles: { flex: 1, gap: 2, minWidth: 0 },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 16,
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.1,
    },
  });
