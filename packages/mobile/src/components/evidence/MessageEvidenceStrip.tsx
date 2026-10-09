import { memo, useCallback, useMemo, useRef, useState } from "react";
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
import { AGENT_ACTIVITY_INK } from "../../lib/agent-activity-presentation";
import { CompareFrame } from "./CompareFrame";
import { WaveformCard } from "./WaveformCard";

const ROW_GAP = 8;
/** Keep one card's worth of row on each side of the viewport mounted. */
const MOUNT_MARGIN = 220;

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
 * can stand alone, and media always comes first.
 */
export const MessageEvidenceStrip = memo(function MessageEvidenceStrip({
  filePaths,
  conversationId,
  access,
  colors,
  onOpen,
  style,
}: {
  filePaths: readonly string[];
  conversationId: string;
  access: StoredPhoneAccess | null;
  colors: Colors;
  onOpen?: (filePath: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { media, pills, overflowCount } = useChatEvidence({
    filePaths,
    conversationId,
    access,
  });
  const [range, setRange] = useState({ start: 0, end: MOUNT_MARGIN * 2 });
  const rowRef = useRef<ScrollView>(null);

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

  if (media.length === 0 && pills.length === 0) return null;

  return (
    <View style={[styles.strip, style]}>
      {media.length > 0 ? (
        <ScrollView
          ref={rowRef}
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
            ) : card.kind === "image-pair" && card.thumbnail && card.thumbnailAfter ? (
              <CompareFrame
                beforeUri={card.thumbnail}
                afterUri={card.thumbnailAfter}
                width={width}
                height={EVIDENCE_MEDIA_CARD_HEIGHT}
                colors={colors}
                label={card.title}
                rowRef={rowRef}
                {...(onOpen && primary ? { onOpen: () => onOpen(primary) } : {})}
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
            // The whole frame opens the file, except on the two cards that own
            // their own touch: audio's waveform is the transport, and the pair
            // frame's wipe needs every horizontal move.
            const framed =
              card.kind === "audio" ||
              card.kind === "image-pair" ||
              !onOpen ||
              !primary ? (
                <View style={[styles.frame, { borderColor: colors.borderWeak }]}>
                  {body}
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${card.title}`}
                  onPress={() => onOpen(primary)}
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
                <Text
                  style={[styles.cardTitle, { color: colors.textMuted }]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                >
                  {card.title}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      {pills.length > 0 ? (
        <View style={styles.pills}>
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
                    backgroundColor: fadeHex(colors[AGENT_ACTIVITY_INK.pillBorderInk], 0.03),
                    borderColor: fadeHex(
                      colors[AGENT_ACTIVITY_INK.pillBorderInk],
                      AGENT_ACTIVITY_INK.pillBorderAlpha,
                    ),
                    opacity: pressed ? 0.78 : 1,
                  },
                ]}
              >
                <Icon name={pillIcon(card)} size={13} color={colors.textMuted} />
                <Text
                  style={[styles.pillTitle, { color: colors.text }]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                >
                  {card.title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {overflowCount > 0 ? (
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
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    maxWidth: "100%",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  pillTitle: { flexShrink: 1, fontFamily: fonts.sans.regular, fontSize: 12.5 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
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
