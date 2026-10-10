import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../i18n";
import { authClient } from "../lib/auth-client";
import {
  artifactFileKey,
  artifactFileSource,
  type ConversationFile,
} from "../lib/conversation-files";
import { isGuest } from "../lib/guest-mode";
import { tapLight } from "../lib/haptics";
import {
  publishTopBarAccessory,
  useActivityHub,
  useComputerControl,
} from "../lib/main-shell-store";
import { formatTimestampHeader } from "../lib/message-time-labels";
import {
  artifactIconName,
  artifactPrimaryFilePath,
  artifactTitle,
} from "../lib/mobile-artifacts";
import type { StoredPhoneAccess } from "../lib/phone-access";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { useConversationFiles } from "../lib/use-conversation-files";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";
import type { ChatArtifact } from "../types";
import { ArtifactViewer } from "./ArtifactViewer";
import { EmptyState } from "./EmptyState";
import { Icon, type IconName } from "./Icon";
import { NativeMenu } from "./NativeMenu";
import type { NativeMenuItem } from "./NativeMenu.types";

const EMPTY_ARTIFACTS: ChatArtifact[] = [];
const EMPTY_PAIRED: StoredPhoneAccess[] = [];
const SEARCH_HEIGHT = 40;
const TOP_BAR_CONTROL = 44;

type SortOrder = "newest" | "oldest" | "name";
type SourceFilter = "all" | "cloud" | "upload" | `computer:${string}`;

const UNKNOWN_COMPUTER = "computer:unknown";

type FileRow = ConversationFile & { title: string; bucket: SourceFilter };

const fileName = (artifact: ChatArtifact): string => {
  const filePath = artifactPrimaryFilePath(artifact.payload);
  const name = filePath?.split(/[?#]/)[0]?.split(/[\\/]/).pop();
  return name || artifactTitle(artifact.payload);
};

/**
 * The Files page: every file Stella produced or shared in the conversation,
 * wherever it lives (the cloud drive, one of the owner's computers, or an
 * attachment the user sent), newest first. The list is read from the
 * conversation's journal, so it reaches files the chat has long scrolled
 * past; anything the chat holds that the journal has not answered for yet
 * shows too. Each opens in the chat's own viewer.
 */
export function FilesPage() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const bottomInset = useSafeAreaInsets().bottom;
  const hub = useActivityHub();
  const computer = useComputerControl();
  const session = authClient.useSession();
  const signedIn = Boolean(session.data?.user) && !isGuest();
  const hubArtifacts = hub?.artifacts ?? EMPTY_ARTIFACTS;
  const preferredAccess = hub?.access ?? null;
  const pairedDesktops = computer?.pairedDesktops ?? EMPTY_PAIRED;
  const journal = useConversationFiles(
    signedIn ? (hub?.conversationId ?? null) : null,
    hub?.revision ?? null,
  );
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [viewerArtifact, setViewerArtifact] = useState<ChatArtifact | null>(
    null,
  );

  const rows = useMemo<FileRow[]>(() => {
    const fallbackDevice = preferredAccess?.desktopDeviceId ?? null;
    const byKey = new Map<string, ConversationFile>();
    for (const file of journal.files) byKey.set(file.key, file);
    const merged: ConversationFile[] = [...journal.files];
    for (const artifact of hubArtifacts) {
      const key = artifactFileKey(artifact);
      const known = byKey.get(key);
      if (known) {
        byKey.set(key, { ...known, artifact });
        continue;
      }
      const payload = artifact.payload as { createdAt?: unknown };
      const file: ConversationFile = {
        key,
        artifact,
        createdAt: typeof payload.createdAt === "number" ? payload.createdAt : 0,
        source: artifactFileSource(artifact),
      };
      byKey.set(key, file);
      merged.push(file);
    }
    return merged.map((entry) => {
      const file = byKey.get(entry.key) ?? entry;
      const deviceId =
        file.source.kind === "computer"
          ? (file.source.deviceId ?? fallbackDevice)
          : null;
      const bucket: SourceFilter =
        file.source.kind === "computer"
          ? deviceId
            ? `computer:${deviceId}`
            : UNKNOWN_COMPUTER
          : file.source.kind;
      return { ...file, title: fileName(file.artifact), bucket };
    });
  }, [hubArtifacts, journal.files, preferredAccess?.desktopDeviceId]);

  const computerLabel = useCallback(
    (deviceId: string | null) =>
      (deviceId ? journal.deviceNames.get(deviceId) : undefined) ??
      t("mobile.computer.defaultDeviceLabel"),
    [journal.deviceNames, t],
  );

  const bucketLabel = useCallback(
    (bucket: SourceFilter) => {
      if (bucket === "all") return t("mobile.activityHub.files.filterAll");
      if (bucket === "cloud") return t("mobile.activityHub.files.sourceCloud");
      if (bucket === "upload") return t("mobile.activityHub.files.sourceUpload");
      if (bucket === UNKNOWN_COMPUTER) return computerLabel(null);
      return computerLabel(bucket.slice("computer:".length));
    },
    [computerLabel, t],
  );

  const buckets = useMemo(() => {
    const computers = new Set<SourceFilter>();
    for (const access of pairedDesktops) {
      computers.add(`computer:${access.desktopDeviceId}`);
    }
    let hasUploads = false;
    for (const row of rows) {
      if (row.bucket.startsWith("computer:")) computers.add(row.bucket);
      if (row.bucket === "upload") hasUploads = true;
    }
    return [
      "cloud" as SourceFilter,
      ...computers,
      ...(hasUploads ? (["upload"] as SourceFilter[]) : []),
    ];
  }, [pairedDesktops, rows]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter(
      (row) =>
        (sourceFilter === "all" || row.bucket === sourceFilter) &&
        (!needle || row.title.toLowerCase().includes(needle)),
    );
    if (sortOrder === "oldest") {
      return [...filtered].sort((a, b) => a.createdAt - b.createdAt);
    }
    if (sortOrder === "name") {
      return [...filtered].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      );
    }
    return [...filtered].sort((a, b) => b.createdAt - a.createdAt);
  }, [query, rows, sortOrder, sourceFilter]);

  const siblings = useMemo(() => shown.map((row) => row.artifact), [shown]);
  const accessById = useMemo(() => {
    const map = new Map<string, StoredPhoneAccess>();
    for (const row of shown) {
      if (!row.bucket.startsWith("computer:")) continue;
      const deviceId = row.bucket.slice("computer:".length);
      const access = pairedDesktops.find(
        (entry) => entry.desktopDeviceId === deviceId,
      );
      if (access) map.set(row.artifact.id, access);
    }
    return map;
  }, [pairedDesktops, shown]);

  const openArtifact = useCallback((artifact: ChatArtifact) => {
    tapLight();
    setViewerArtifact(artifact);
  }, []);

  const filtering =
    query.trim().length > 0 || sourceFilter !== "all";
  const hasAnything = rows.length > 0;
  // Older files are paged in by the list's onEndReached, which never mounts
  // while nothing is resident; keep reaching back until a file turns up or
  // the history runs out.
  const seekingOlder = !hasAnything && journal.hasMore;
  const firstLoad = (journal.loading || seekingOlder) && !hasAnything;
  const { loading: journalLoading, loadingMore, loadMore } = journal;
  useEffect(() => {
    if (seekingOlder && !journalLoading && !loadingMore) loadMore();
  }, [journalLoading, loadMore, loadingMore, seekingOlder]);

  const menuItems = useMemo<NativeMenuItem[]>(() => {
    const choose = (next: SourceFilter) => () => setSourceFilter(next);
    const sortBy = (next: SortOrder) => () => setSortOrder(next);
    return [
      {
        id: "filter:all",
        title: bucketLabel("all"),
        selected: sourceFilter === "all",
        onPress: choose("all"),
      },
      ...buckets.map((bucket) => ({
        id: `filter:${bucket}`,
        title: bucketLabel(bucket),
        selected: sourceFilter === bucket,
        systemImage: (bucket === "cloud"
          ? "cloud"
          : bucket === "upload"
            ? "arrow.up.circle"
            : "desktopcomputer") as NativeMenuItem["systemImage"],
        onPress: choose(bucket),
      })),
      {
        id: "sort:newest",
        title: t("mobile.activityHub.files.sortNewest"),
        selected: sortOrder === "newest",
        separatorBefore: true,
        onPress: sortBy("newest"),
      },
      {
        id: "sort:oldest",
        title: t("mobile.activityHub.files.sortOldest"),
        selected: sortOrder === "oldest",
        onPress: sortBy("oldest"),
      },
      {
        id: "sort:name",
        title: t("mobile.activityHub.files.sortName"),
        selected: sortOrder === "name",
        onPress: sortBy("name"),
      },
    ];
  }, [bucketLabel, buckets, sortOrder, sourceFilter, t]);

  const cycleFilter = useCallback(() => {
    const order: SourceFilter[] = ["all", ...buckets];
    const index = order.indexOf(sourceFilter);
    setSourceFilter(order[(index + 1) % order.length] ?? "all");
  }, [buckets, sourceFilter]);

  const narrowed = sourceFilter !== "all" || sortOrder !== "newest";
  const accessory = useMemo(
    () =>
      hasAnything ? (
        <NativeMenu
          label={
            <Icon
              name="filter"
              size={18}
              color={narrowed ? colors.accent : colors.text}
            />
          }
          accessibilityLabel={t("mobile.activityHub.files.filterLabel")}
          items={menuItems}
          width={TOP_BAR_CONTROL}
          height={TOP_BAR_CONTROL}
          circular
          onFallbackPress={cycleFilter}
        />
      ) : null,
    [colors.accent, colors.text, cycleFilter, hasAnything, menuItems, narrowed, t],
  );

  useEffect(() => {
    publishTopBarAccessory(accessory);
  }, [accessory]);
  useEffect(() => () => publishTopBarAccessory(null), []);

  const renderRow = useCallback(
    ({ item, index }: LegendListRenderItemProps<FileRow>) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={item.title}
        onPress={() => openArtifact(item.artifact)}
        style={({ pressed }) => [
          styles.row,
          index === 0 && styles.rowFirst,
          index === shown.length - 1 && styles.rowLast,
          index > 0 && styles.rowDivider,
          pressed && styles.rowPressed,
        ]}
      >
        <View style={styles.rowIcon}>
          <Icon
            name={artifactIconName(item.artifact.payload) as IconName}
            size={17}
            color={colors.text}
          />
        </View>
        <View style={styles.rowText}>
          <Text
            style={styles.rowTitle}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {item.title}
          </Text>
          <Text
            style={styles.rowMeta}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {item.createdAt > 0
              ? `${bucketLabel(item.bucket)} · ${formatTimestampHeader(item.createdAt)}`
              : bucketLabel(item.bucket)}
          </Text>
        </View>
        <Icon name="chevron-right" size={14} color={colors.textMuted} />
      </Pressable>
    ),
    [bucketLabel, colors.text, colors.textMuted, openArtifact, shown.length, styles],
  );

  if (!signedIn && !hasAnything) {
    return (
      <View style={styles.root}>
        <EmptyState motif="files" message={t("mobile.sidebar.signedOutHint")} />
      </View>
    );
  }

  if (firstLoad) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (!hasAnything) {
    return (
      <View style={styles.root}>
        <EmptyState motif="files" message={t("mobile.activityHub.files.empty")} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
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

      {sourceFilter !== "all" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.activityHub.files.filterAll")}
          onPress={() => setSourceFilter("all")}
          style={styles.activeFilter}
          hitSlop={6}
        >
          <Text style={styles.activeFilterText} numberOfLines={1}>
            {bucketLabel(sourceFilter)}
          </Text>
          <Icon name="x" size={11} color={colors.textMuted} />
        </Pressable>
      ) : null}

      <LegendList<FileRow>
        style={styles.list}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
        data={shown}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        extraData={bucketLabel}
        onEndReached={journal.hasMore ? journal.loadMore : undefined}
        onEndReachedThreshold={0.6}
        ListFooterComponent={
          journal.loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={colors.textMuted} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <Text
            style={styles.emptyFiltered}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {filtering
              ? t("mobile.activityHub.files.emptyFiltered")
              : t("mobile.activityHub.files.empty")}
          </Text>
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        estimatedItemSize={60}
        recycleItems
      />

      <ArtifactViewer
        visible={Boolean(viewerArtifact)}
        artifact={viewerArtifact}
        access={
          (viewerArtifact ? accessById.get(viewerArtifact.id) : undefined) ??
          preferredAccess
        }
        onClose={() => setViewerArtifact(null)}
        siblings={siblings}
        onNavigate={setViewerArtifact}
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
    centered: {
      alignItems: "center",
      justifyContent: "center",
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
      marginTop: 8,
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
    activeFilter: {
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: colors.accentSoft,
      borderColor: colors.selectBorder,
      borderRadius: 13,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 6,
      height: 26,
      marginBottom: 12,
      maxWidth: "80%",
      paddingHorizontal: 11,
    },
    activeFilterText: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    list: {
      flex: 1,
    },
    row: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 12,
      minHeight: 60,
      paddingHorizontal: 12,
      paddingVertical: 10,
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
    rowPressed: {
      backgroundColor: colors.surfaceInset,
    },
    rowIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceInset,
      borderRadius: 10,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    rowText: {
      flex: 1,
      gap: 2,
      minWidth: 0,
    },
    rowTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    rowMeta: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12.5,
      letterSpacing: -0.05,
    },
    footer: {
      paddingVertical: 18,
    },
    emptyFiltered: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      paddingHorizontal: 20,
      paddingVertical: 36,
      textAlign: "center",
    },
  });
