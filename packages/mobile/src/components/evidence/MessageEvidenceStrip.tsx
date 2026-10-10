import { memo, useCallback, useMemo, useState } from "react";
import { fileDisplayName } from "@stella/contracts/file-display-name";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import type { EvidenceCard } from "@stella/contracts/chat-evidence";
import { Icon, type IconName } from "../Icon";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import {
  evidenceCardWidth,
  useChatEvidence,
  EVIDENCE_MEDIA_CARD_HEIGHT,
} from "../../lib/use-chat-evidence";
import type { StoredPhoneAccess } from "../../lib/phone-access";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import { WaveformCard } from "./WaveformCard";

const ROW_GAP = 8;
/** Keep one card's worth of row on each side of the viewport mounted. */
const MOUNT_MARGIN = 220;

const VISUAL_KINDS: ReadonlySet<EvidenceCard["kind"]> = new Set([
  "image",
  "stack",
  "video",
]);

const pillIcon = (card: EvidenceCard): IconName => {
  if (card.kind === "bundle") return "box";
  const label = (card.extensionLabel ?? "").toLowerCase();
  if (label.includes("font")) return "file";
  return "file-text";
};

const ImageThumb = memo(function ImageThumb({
  uri,
  width,
  height,
  label,
}: {
  uri: string;
  width: number;
  height: number;
  label: string;
}) {
  return (
    <Image
      source={{ uri }}
      style={{ width, height }}
      contentFit="cover"
      // expo-image downsamples to the view, so a 4K screenshot never becomes a
      // 4K bitmap in memory, and keeps the result in its own disk cache.
      cachePolicy="memory-disk"
      accessibilityLabel={label}
      recyclingKey={uri}
      transition={120}
    />
  );
});

const VideoPoster = memo(function VideoPoster({
  uri,
  width,
  height,
  label,
  colors,
}: {
  uri: string;
  width: number;
  height: number;
  label: string;
  colors: Colors;
}) {
  return (
    <View style={{ width, height }}>
      <ImageThumb uri={uri} width={width} height={height} label={label} />
      <View style={[styles.playBadge, { backgroundColor: colors.overlay }]}>
        <Icon name="play" size={13} color="#ffffff" />
      </View>
    </View>
  );
});

const PendingThumb = ({
  width,
  height,
  colors,
}: {
  width: number;
  height: number;
  colors: Colors;
}) => (
  <View
    style={[styles.pending, { width, height, backgroundColor: colors.surface }]}
  />
);

/**
 * One reply's attached files: a scrolling row of real media, then everything
 * without a preview as pills. No tray, no card container, no grid — either row
 * can stand alone, and media always comes first. `part` renders just one row:
 * a reply with text shows its media under the bubble and its pills inside it.
 */
export const MessageEvidenceStrip = memo(function MessageEvidenceStrip({
  filePaths,
  conversationId,
  access,
  colors,
  onOpen,
  style,
  part,
}: {
  filePaths: readonly string[];
  conversationId: string;
  access: StoredPhoneAccess | null;
  colors: Colors;
  onOpen?: (filePath: string, gallery?: readonly string[]) => void;
  style?: StyleProp<ViewStyle>;
  part?: "media" | "documents";
}) {
  const { media, pills, overflowCount } = useChatEvidence({
    filePaths,
    conversationId,
    access,
  });
  const [range, setRange] = useState({ start: 0, end: MOUNT_MARGIN * 2 });

  const offsets = useMemo(() => {
    const spans: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const card of media) {
      const width = evidenceCardWidth(card);
      spans.push({ start: cursor, end: cursor + width });
      cursor += width + ROW_GAP;
    }
    return spans;
  }, [media]);

  const gallery = useMemo(
    () =>
      media
        .filter((card) => card.kind === "image")
        .map((card) => card.sourcePaths[0])
        .filter((filePath): filePath is string => Boolean(filePath)),
    [media],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement } = event.nativeEvent;
      const start = contentOffset.x - MOUNT_MARGIN;
      const end = contentOffset.x + layoutMeasurement.width + MOUNT_MARGIN;
      setRange((current) =>
        Math.abs(current.start - start) < MOUNT_MARGIN / 2 &&
        Math.abs(current.end - end) < MOUNT_MARGIN / 2
          ? current
          : { start, end },
      );
    },
    [],
  );

  const showMedia = part !== "documents" && media.length > 0;
  const showPills = part !== "media" && pills.length > 0;
  const showOverflow = part !== "media" && overflowCount > 0;
  if (!showMedia && !showPills && !showOverflow) return null;

  return (
    <View style={[styles.strip, style]}>
      {showMedia ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
          onScroll={onScroll}
          scrollEventThrottle={96}
          accessibilityLabel="Attached media"
        >
          {media.map((card, index) => {
            const width = evidenceCardWidth(card);
            const span = offsets[index];
            const mounted =
              !span || (span.end >= range.start && span.start <= range.end);
            const primary = card.sourcePaths[0] ?? "";
            const body = !mounted ? (
              <PendingThumb
                width={width}
                height={EVIDENCE_MEDIA_CARD_HEIGHT}
                colors={colors}
              />
            ) : card.kind === "audio" && card.peaks ? (
              <WaveformCard
                filePath={primary}
                conversationId={conversationId}
                access={access}
                peaks={card.peaks}
                durationMs={card.durationMs ?? 0}
                width={width}
                height={EVIDENCE_MEDIA_CARD_HEIGHT}
                colors={colors}
                label={card.title}
              />
            ) : card.kind === "video" && card.thumbnail ? (
              <VideoPoster
                uri={card.thumbnail}
                width={width}
                height={EVIDENCE_MEDIA_CARD_HEIGHT}
                label={card.title}
                colors={colors}
              />
            ) : card.thumbnail ? (
              <ImageThumb
                uri={card.thumbnail}
                width={width}
                height={EVIDENCE_MEDIA_CARD_HEIGHT}
                label={card.title}
              />
            ) : (
              <PendingThumb
                width={width}
                height={EVIDENCE_MEDIA_CARD_HEIGHT}
                colors={colors}
              />
            );
            // The whole frame opens the file, except audio, whose waveform is
            // its own transport. An image opens with the reply's other images
            // as its neighbours, so the viewer swipes through them.
            const framed =
              card.kind === "audio" || !onOpen || !primary ? (
                <View style={[styles.frame, { borderColor: colors.borderWeak }]}>
                  {body}
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${card.title}`}
                  onPress={() =>
                    onOpen(primary, card.kind === "image" ? gallery : undefined)
                  }
                  style={({ pressed }) => [
                    styles.frame,
                    { borderColor: colors.borderWeak, opacity: pressed ? 0.78 : 1 },
                  ]}
                >
                  {body}
                </Pressable>
              );
            return (
              <View key={card.id} style={{ width }}>
                {framed}
                {VISUAL_KINDS.has(card.kind) ? null : (
                  <Text
                    style={[styles.cardTitle, { color: colors.textMuted }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                  >
                    {card.title}
                  </Text>
                )}
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      {showPills ? (
        <View style={[styles.pills, !showMedia && styles.pillsFirst]}>
          {pills.map((card) => {
            const primary = card.sourcePaths[0] ?? "";
            return (
              <Pressable
                key={card.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${card.title}`}
                disabled={!onOpen || !primary}
                onPress={onOpen && primary ? () => onOpen(primary) : undefined}
                style={({ pressed }) => [
                  styles.pill,
                  {
                    backgroundColor: fadeHex(colors.assistantBubbleText, 0.12),
                    opacity: pressed ? 0.78 : 1,
                  },
                ]}
              >
                <Icon
                  name={pillIcon(card)}
                  size={14}
                  color={fadeHex(colors.assistantBubbleText, 0.8)}
                />
                <Text
                  style={[styles.pillTitle, { color: colors.assistantBubbleText }]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                >
                  {primary ? fileDisplayName(primary) : card.title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {showOverflow ? (
        <Text
          style={[styles.overflow, { color: colors.textMuted }]}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {`+${overflowCount} more`}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  cardTitle: {
    fontFamily: fonts.sans.regular,
    fontSize: 11,
    letterSpacing: -0.1,
    marginTop: 5,
  },
  frame: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  overflow: { fontFamily: fonts.sans.regular, fontSize: 11, marginTop: 6 },
  pending: { borderRadius: 14 },
  pill: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 5,
    maxWidth: "100%",
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  pillTitle: { flexShrink: 1, fontFamily: fonts.sans.medium, fontSize: 14 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  pillsFirst: { marginTop: 0 },
  playBadge: {
    alignItems: "center",
    borderRadius: 13,
    bottom: 8,
    height: 26,
    justifyContent: "center",
    left: 8,
    position: "absolute",
    width: 26,
  },
  row: { gap: ROW_GAP, paddingRight: 4 },
  strip: { alignSelf: "stretch", marginTop: 10 },
});
