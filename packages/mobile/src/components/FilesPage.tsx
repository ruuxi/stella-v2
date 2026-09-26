import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useT } from "../i18n";
import { filterHubArtifacts } from "../lib/activity-hub-search";
import { authClient } from "../lib/auth-client";
import { isGuest } from "../lib/guest-mode";
import { tapLight } from "../lib/haptics";
import { useActivityHub } from "../lib/main-shell-store";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { useShellBottomInset } from "../lib/shell-bottom-inset";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";
import type { ChatArtifact } from "../types";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactViewer } from "./ArtifactViewer";
import { Icon } from "./Icon";

const EMPTY_ARTIFACTS: ChatArtifact[] = [];
const SEARCH_HEIGHT = 40;

/**
 * The Files tab: every file the conversation has produced, newest first,
 * whether the main thread or a background agent made it, with a search
 * field over titles. The rows come from the chat through the shell store, so
 * the list is live while agents keep producing.
 */
export function FilesPage() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const bottomInset = useShellBottomInset();
  const hub = useActivityHub();
  const session = authClient.useSession();
  const signedIn = Boolean(session.data?.user) && !isGuest();
  const artifacts = hub?.artifacts ?? EMPTY_ARTIFACTS;
  const [query, setQuery] = useState("");
  const [viewerArtifact, setViewerArtifact] = useState<ChatArtifact | null>(
    null,
  );

  const shown = useMemo(
    () => filterHubArtifacts(artifacts, query),
    [artifacts, query],
  );
  const filtering = query.trim().length > 0;

  const openArtifact = useCallback((artifact: ChatArtifact) => {
    tapLight();
    setViewerArtifact(artifact);
  }, []);

  const emptyText = !hub && !signedIn
    ? t("mobile.sidebar.signedOutHint")
    : filtering
      ? t("mobile.activityHub.files.emptyFiltered")
      : t("mobile.activityHub.files.empty");

  return (
    <View style={styles.root}>
      <Text style={styles.title} accessibilityRole="header">
        {t("mobile.activityHub.tabs.files")}
      </Text>

      {artifacts.length > 0 ? (
        <View style={styles.search}>
          <Icon name="search" size={15} color={colors.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("mobile.activityHub.files.searchPlaceholder")}
            placeholderTextColor={fadeHex(colors.textMuted, 0.7)}
            selectionColor={colors.accent}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          />
          {query.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("mobile.activityHub.search.clear")}
              hitSlop={10}
              onPress={() => setQuery("")}
            >
              <Icon name="x" size={14} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <LegendList<ChatArtifact>
        style={styles.list}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
        data={shown}
        keyExtractor={(artifact) => artifact.id}
        renderItem={({
          item,
          index,
        }: LegendListRenderItemProps<ChatArtifact>) => (
          <View
            style={[
              styles.row,
              index === 0 && styles.rowFirst,
              index === shown.length - 1 && styles.rowLast,
              index > 0 && styles.rowDivider,
            ]}
          >
            <ArtifactCard
              compact
              artifact={item}
              colors={colors}
              onPress={openArtifact}
            />
          </View>
        )}
        ListEmptyComponent={
          <Text
            style={styles.empty}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {emptyText}
          </Text>
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        estimatedItemSize={52}
        recycleItems
      />

      <ArtifactViewer
        visible={Boolean(viewerArtifact)}
        artifact={viewerArtifact}
        access={hub?.access ?? null}
        onClose={() => setViewerArtifact(null)}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      minHeight: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 32,
      letterSpacing: -1.2,
      marginBottom: 16,
      marginTop: 4,
    },
    search: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: SEARCH_HEIGHT / 2,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      height: SEARCH_HEIGHT,
      marginBottom: 14,
      paddingHorizontal: 14,
    },
    searchInput: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      padding: 0,
    },
    list: {
      flex: 1,
    },
    // Rows join into one rounded card, like a Settings group.
    row: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
    },
    rowFirst: {
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    rowLast: {
      borderBottomLeftRadius: 16,
      borderBottomRightRadius: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    rowDivider: {
      borderTopColor: fadeHex(colors.border, 0.8),
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      paddingHorizontal: 20,
      paddingVertical: 36,
      textAlign: "center",
    },
  });
