import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { GlassToggle } from "./glass";
import type { AddContextSheetProps } from "./AddContextSheet.types";
import { useT } from "../i18n";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";

/** Everything below the sheet's grabber: header, the three tiles, read aloud. */
export const ADD_CONTEXT_BODY_HEIGHT = 262;

export function AddContextSheetBody({
  onClose,
  onCamera,
  onPhotos,
  onFiles,
  readAloud,
  onReadAloudChange,
}: AddContextSheetProps) {
  const t = useT();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tiles: { id: string; label: string; icon: IconName; onPress: () => void }[] = [];
  if (onCamera) {
    tiles.push({ id: "camera", label: t("chat.attachments.camera"), icon: "camera", onPress: onCamera });
  }
  if (onPhotos) {
    tiles.push({ id: "photos", label: t("chat.attachments.photos"), icon: "image", onPress: onPhotos });
  }
  if (onFiles) {
    tiles.push({ id: "files", label: t("chat.attachments.files"), icon: "file-text", onPress: onFiles });
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        >
          <Icon name="x" size={17} color={colors.text} weight="semibold" />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          {t("chat.attachments.sheetTitle")}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {tiles.length > 0 ? (
        <View style={styles.tiles}>
          {tiles.map((tile) => (
            <Pressable
              key={tile.id}
              onPress={tile.onPress}
              accessibilityRole="button"
              accessibilityLabel={tile.label}
              style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
            >
              <Icon name={tile.icon} size={24} color={colors.text} />
              <Text style={styles.tileLabel} numberOfLines={1}>
                {tile.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.row}>
        <Icon
          name={readAloud ? "volume-2" : "volume-x"}
          size={19}
          color={colors.text}
        />
        <Text style={styles.rowLabel}>{t("chat.attachments.readAloud")}</Text>
        <GlassToggle
          value={readAloud}
          onValueChange={onReadAloudChange}
          accessibilityLabel={t("chat.attachments.readAloud")}
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { gap: 16, paddingHorizontal: 20, paddingTop: 14 },
    header: { alignItems: "center", flexDirection: "row", height: 44 },
    close: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderRadius: 22,
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    headerSpacer: { width: 44 },
    title: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      textAlign: "center",
    },
    tiles: { flexDirection: "row", gap: 10 },
    tile: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderRadius: 22,
      flex: 1,
      gap: 8,
      height: 96,
      justifyContent: "center",
    },
    tileLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
    row: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderRadius: 26,
      flexDirection: "row",
      gap: 12,
      height: 56,
      paddingLeft: 20,
      paddingRight: 12,
    },
    rowLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 16,
    },
    pressed: { opacity: 0.6 },
  });
