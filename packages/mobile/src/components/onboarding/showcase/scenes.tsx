/**
 * What each chapter's agent window shows while the work happens: a
 * reservation filling in, a product going into the cart, a deck assembling,
 * tomorrow's lock screen with the brief arriving, sources read and ranked.
 *
 * Each scene reads the chapter's cues and hangs its motion on springs that
 * follow them, so nothing here re-renders between cues.
 */
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useT } from "../../../i18n";
import { Icon, type IconName } from "../../Icon";
import { StellaStarGlyph } from "../../AgentActivityGlyph";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import { fadeHex } from "../../../theme/oklch";
import { useColors } from "../../../theme/theme-context";
import { SPRING_SNAPPY, SPRING_SOFT, useSpringFlag } from "../motion";
import { chapterKey, type ChapterId } from "./chapters";
import { MiniAgentWindow } from "./MiniChat";
import type { Has } from "./use-choreography";

function useSceneStyles() {
  const colors = useColors();
  return useMemo(() => makeSceneStyles(colors), [colors]);
}

const useChapterT = (id: ChapterId) => {
  const t = useT();
  return (field: string) => t(chapterKey(id, field));
};

export function ChapterScene({ id, has }: { id: ChapterId; has: Has }) {
  switch (id) {
    case "errands":
      return <ErrandsScene has={has} />;
    case "shopping":
      return <ShopScene has={has} />;
    case "work":
      return <WorkScene has={has} />;
    case "routines":
      return <RoutineScene has={has} />;
    case "research":
      return <ResearchScene has={has} />;
  }
}

/* ── Errands: a reservation form filling itself in ────────────────── */

function FormField({
  label,
  value,
  filled,
}: {
  label: string;
  value: string;
  filled: boolean;
}) {
  const styles = useSceneStyles();
  const fill = useSpringFlag(filled, SPRING_SOFT);
  const valueStyle = useAnimatedStyle(() => ({
    opacity: fill.value,
    transform: [{ translateY: (1 - fill.value) * 5 }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: interpolate(fill.value, [0, 0.5, 1], [0, 1, 0.35]),
  }));
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.fieldBox}>
        <Animated.View style={[styles.fieldRing, ringStyle]} />
        <Animated.Text style={[styles.fieldValue, valueStyle]} numberOfLines={1}>
          {value}
        </Animated.Text>
      </View>
    </View>
  );
}

function ErrandsScene({ has }: { has: Has }) {
  const ct = useChapterT("errands");
  const colors = useColors();
  const styles = useSceneStyles();
  const press = useSpringFlag(has("click") && !has("confirmed"), SPRING_SNAPPY);
  const done = useSpringFlag(has("confirmed"), SPRING_SNAPPY);
  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.07 * press.value }],
  }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: 1 - done.value }));
  const doneStyle = useAnimatedStyle(() => ({
    opacity: done.value,
    transform: [{ scale: 0.6 + 0.4 * done.value }],
  }));
  return (
    <MiniAgentWindow
      title={ct("scene.site")}
      icon="globe"
      live={!has("confirmed")}
    >
      <View style={styles.gap8}>
        <View style={styles.formRow}>
          <FormField
            label={ct("scene.party")}
            value={ct("scene.partyValue")}
            filled={has("fill-1")}
          />
          <FormField
            label={ct("scene.date")}
            value={ct("scene.dateValue")}
            filled={has("fill-2")}
          />
          <FormField
            label={ct("scene.time")}
            value={ct("scene.timeValue")}
            filled={has("fill-3")}
          />
        </View>
        <Animated.View
          style={[
            styles.sceneButton,
            has("confirmed") && { backgroundColor: fadeHex(colors.ok, 0.16) },
            buttonStyle,
          ]}
        >
          <Animated.Text style={[styles.sceneButtonText, labelStyle]}>
            {ct("scene.reserve")}
          </Animated.Text>
          <Animated.View style={[StyleSheet.absoluteFill, styles.centerRow, doneStyle]}>
            <Icon name="check" size={11} color={colors.ok} weight="bold" />
            <Text style={[styles.sceneButtonText, { color: colors.ok }]}>
              {ct("scene.reserved")}
            </Text>
          </Animated.View>
        </Animated.View>
      </View>
    </MiniAgentWindow>
  );
}

/* ── Shopping: the right size, into the cart ──────────────────────── */

const SIZES = ["9", "9½", "10", "10½", "11"];

function SizeChip({ label, selected }: { label: string; selected: boolean }) {
  const styles = useSceneStyles();
  const pick = useSpringFlag(selected, SPRING_SNAPPY);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.12 * interpolate(pick.value, [0, 0.6, 1], [0, 1, 0]) }],
  }));
  return (
    <Animated.View style={[styles.sizeChip, selected && styles.sizeChipSelected, style]}>
      <Text style={[styles.sizeText, selected && styles.sizeTextSelected]}>{label}</Text>
    </Animated.View>
  );
}

function ShopScene({ has }: { has: Has }) {
  const ct = useChapterT("shopping");
  const colors = useColors();
  const styles = useSceneStyles();
  const cart = useSpringFlag(has("cart"), SPRING_SNAPPY);
  const addStyle = useAnimatedStyle(() => ({ opacity: 1 - cart.value }));
  const inCartStyle = useAnimatedStyle(() => ({
    opacity: cart.value,
    transform: [{ scale: 0.7 + 0.3 * cart.value }],
  }));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: cart.value,
    transform: [{ scale: interpolate(cart.value, [0, 0.7, 1], [0.2, 1.25, 1]) }],
  }));
  return (
    <MiniAgentWindow title={ct("scene.site")} icon="globe" live={!has("confirm-done")}>
      <View style={styles.gap8}>
        <View style={styles.productRow}>
          <View style={styles.productThumb}>
            <Icon name="box" size={18} color={colors.accentForeground} />
            <Animated.View style={[styles.cartBadge, badgeStyle]}>
              <Text style={styles.cartBadgeText}>1</Text>
            </Animated.View>
          </View>
          <View style={styles.flex}>
            <Text style={styles.productName} numberOfLines={1}>
              {ct("scene.product")}
            </Text>
            <Text style={styles.productPrice} numberOfLines={1}>
              {ct("amount")}
            </Text>
          </View>
          <View style={styles.cartButton}>
            <Animated.Text style={[styles.cartButtonText, addStyle]} numberOfLines={1}>
              {ct("scene.addToCart")}
            </Animated.Text>
            <Animated.View style={[StyleSheet.absoluteFill, styles.centerRow, inCartStyle]}>
              <Icon name="check" size={10} color={colors.accent} weight="bold" />
              <Text style={[styles.cartButtonText, { color: colors.accent }]} numberOfLines={1}>
                {ct("scene.inCart")}
              </Text>
            </Animated.View>
          </View>
        </View>
        <View style={styles.sizeRow}>
          {SIZES.map((size) => (
            <SizeChip key={size} label={size} selected={size === "10" && has("size")} />
          ))}
        </View>
      </View>
    </MiniAgentWindow>
  );
}

/* ── Work: a deck assembling slide by slide ───────────────────────── */

type SlideKind = "title" | "bars" | "bullets" | "split" | "quote" | "end";
const SLIDES: SlideKind[] = ["title", "bars", "bullets", "split", "bars", "end"];

function Slide({
  kind,
  shown,
  title,
}: {
  kind: SlideKind;
  shown: boolean;
  title: string;
}) {
  const colors = useColors();
  const styles = useSceneStyles();
  const pop = useSpringFlag(shown, SPRING_SOFT);
  const style = useAnimatedStyle(() => ({
    opacity: pop.value,
    transform: [
      { translateY: (1 - pop.value) * 8 },
      { scale: 0.84 + 0.16 * pop.value },
    ],
  }));
  const bar = (width: number | `${number}%`, strong = false) => (
    <View
      style={[
        styles.slideLine,
        { width, backgroundColor: strong ? colors.text : colors.border },
      ]}
    />
  );
  return (
    <Animated.View style={[styles.slide, style]}>
      {kind === "title" ? (
        <View style={styles.slideCenter}>
          <Text style={styles.slideTitle} numberOfLines={1}>
            {title}
          </Text>
          {bar("50%")}
        </View>
      ) : kind === "bars" ? (
        <View style={styles.slideBars}>
          {[0.45, 0.7, 0.55, 0.9].map((h, index) => (
            <View
              key={index}
              style={[
                styles.slideBar,
                {
                  height: `${h * 100}%`,
                  backgroundColor: index === 3 ? colors.accent : colors.border,
                },
              ]}
            />
          ))}
        </View>
      ) : kind === "bullets" ? (
        <View style={styles.slideStack}>
          {bar("60%", true)}
          {bar("85%")}
          {bar("75%")}
          {bar("80%")}
        </View>
      ) : kind === "split" ? (
        <View style={styles.slideSplit}>
          <View style={[styles.slideBlock, { backgroundColor: colors.accentSoft }]} />
          <View style={[styles.slideStack, styles.flex]}>
            {bar("90%", true)}
            {bar("70%")}
            {bar("80%")}
          </View>
        </View>
      ) : (
        <View style={styles.slideCenter}>
          <StellaStarGlyph size={12} color={colors.accent} />
        </View>
      )}
    </Animated.View>
  );
}

function WorkScene({ has }: { has: Has }) {
  const ct = useChapterT("work");
  const styles = useSceneStyles();
  return (
    <MiniAgentWindow title={ct("scene.file")} icon="artifacts" live={!has("work-2-done")}>
      <View style={styles.slideGrid}>
        {SLIDES.map((kind, index) => (
          <Slide
            key={index}
            kind={kind}
            shown={has(`slide-${index + 1}`)}
            title={ct("scene.slideTitle")}
          />
        ))}
      </View>
    </MiniAgentWindow>
  );
}

/* ── Routines: tomorrow, 8:00, the brief arrives ──────────────────── */

function RoutineScene({ has }: { has: Has }) {
  const ct = useChapterT("routines");
  const colors = useColors();
  const styles = useSceneStyles();
  const notify = useSpringFlag(has("notify"), SPRING_SOFT);
  const bannerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(notify.value, [0, 0.4, 1], [0, 1, 1]),
    transform: [
      { translateY: (1 - notify.value) * -26 },
      { scale: 0.94 + 0.06 * notify.value },
    ],
  }));
  const clockStyle = useAnimatedStyle(() => ({
    opacity: 1 - 0.45 * notify.value,
    transform: [{ scale: 1 - 0.06 * notify.value }],
  }));
  return (
    <MiniAgentWindow title={ct("scene.when")} icon="clock" live={false}>
      <View style={styles.lock}>
        <Animated.View style={[styles.lockClock, clockStyle]}>
          <Text style={styles.lockDay}>{ct("scene.day")}</Text>
          <Text style={styles.lockTime}>{ct("scene.time")}</Text>
        </Animated.View>
        <Animated.View style={[styles.banner, bannerStyle]}>
          <View style={styles.bannerIcon}>
            <StellaStarGlyph size={12} color={colors.accentForeground} />
          </View>
          <View style={styles.flex}>
            <View style={styles.bannerHead}>
              <Text style={styles.bannerApp}>Stella</Text>
              <Text style={styles.bannerNow}>{ct("scene.now")}</Text>
            </View>
            <Text style={styles.bannerTitle} numberOfLines={1}>
              {ct("scene.title")}
            </Text>
            <Text style={styles.bannerBody} numberOfLines={2}>
              {ct("scene.body")}
            </Text>
          </View>
        </Animated.View>
      </View>
    </MiniAgentWindow>
  );
}

/* ── Research: read the sources, rank the options ─────────────────── */

function SourceRow({
  icon,
  label,
  count,
  read,
}: {
  icon: IconName;
  label: string;
  count: string;
  read: boolean;
}) {
  const colors = useColors();
  const styles = useSceneStyles();
  const progress = useSpringFlag(read, { damping: 26, stiffness: 90, mass: 1 });
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: Math.max(0.02, progress.value) }],
  }));
  const countStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <View style={styles.sourceRow}>
      <Icon name={icon} size={10} color={colors.textMuted} />
      <Text style={styles.sourceLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.sourceTrack}>
        <Animated.View style={[styles.sourceFill, fillStyle]} />
      </View>
      <Animated.Text style={[styles.sourceCount, countStyle]}>{count}</Animated.Text>
    </View>
  );
}

const RANKS = [
  { key: "scene.rank1", score: "4.8" },
  { key: "scene.rank2", score: "4.5" },
  { key: "scene.rank3", score: "4.3" },
];

function RankRow({
  index,
  label,
  score,
}: {
  index: number;
  label: string;
  score: string;
}) {
  const styles = useSceneStyles();
  return (
    <View style={[styles.rankRow, index === 0 && styles.rankRowTop]}>
      <Text style={[styles.rankIndex, index === 0 && styles.rankTopText]}>{index + 1}</Text>
      <Text style={[styles.rankLabel, index === 0 && styles.rankTopText]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.rankScore, index === 0 && styles.rankTopText]}>★ {score}</Text>
    </View>
  );
}

function ResearchScene({ has }: { has: Has }) {
  const ct = useChapterT("research");
  const styles = useSceneStyles();
  const ranked = has("rank");
  const swap = useSpringFlag(ranked, SPRING_SOFT);
  const sourcesStyle = useAnimatedStyle(() => ({ opacity: 1 - swap.value }));
  const ranksStyle = useAnimatedStyle(() => ({ opacity: swap.value }));
  return (
    <MiniAgentWindow title={ct("scene.title")} icon="search" live={!ranked}>
      <View style={styles.swap}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.gap6, sourcesStyle]}>
          <SourceRow icon="globe" label={ct("scene.source1")} count="9" read={has("src-1")} />
          <SourceRow icon="message-square" label={ct("scene.source2")} count="11" read={has("src-2")} />
          <SourceRow icon="file-text" label={ct("scene.source3")} count="4" read={has("src-3")} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, styles.gap4, ranksStyle]}>
          {RANKS.map((rank, index) => (
            <RankRow
              key={rank.key}
              index={index}
              label={ct(rank.key)}
              score={rank.score}
            />
          ))}
        </Animated.View>
      </View>
    </MiniAgentWindow>
  );
}

const makeSceneStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1, minWidth: 0 },
    gap4: { gap: 4 },
    gap6: { gap: 7 },
    gap8: { gap: 8 },
    /** Holds the taller of the two states so the swap never resizes the window. */
    swap: { height: 86, justifyContent: "center" },
    centerRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      justifyContent: "center",
    },
    formRow: { flexDirection: "row", gap: 6 },
    field: { flex: 1, gap: 3, minWidth: 0 },
    fieldLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 9.5,
      letterSpacing: 0.3,
      textTransform: "uppercase",
    },
    fieldBox: {
      backgroundColor: colors.background,
      borderColor: colors.border,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      height: 26,
      justifyContent: "center",
      paddingHorizontal: 7,
    },
    fieldRing: {
      ...StyleSheet.absoluteFill,
      borderColor: colors.accent,
      borderRadius: 7,
      borderWidth: 1.5,
    },
    fieldValue: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 11,
    },
    sceneButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 9,
      height: 28,
      justifyContent: "center",
    },
    sceneButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 11.5,
    },
    productRow: { alignItems: "center", flexDirection: "row", gap: 9 },
    productThumb: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderCurve: "continuous",
      borderRadius: 10,
      height: 38,
      justifyContent: "center",
      width: 38,
    },
    cartBadge: {
      alignItems: "center",
      backgroundColor: colors.text,
      borderColor: colors.card,
      borderRadius: 8,
      borderWidth: 1.5,
      height: 16,
      justifyContent: "center",
      position: "absolute",
      right: -5,
      top: -5,
      width: 16,
    },
    cartBadgeText: {
      color: colors.background,
      fontFamily: fonts.sans.bold,
      fontSize: 9,
    },
    productName: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 12,
    },
    productPrice: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
    },
    cartButton: {
      alignItems: "center",
      borderColor: colors.selectBorder,
      borderRadius: 12,
      borderWidth: 1,
      height: 24,
      justifyContent: "center",
      minWidth: 74,
      paddingHorizontal: 8,
    },
    cartButtonText: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 10.5,
    },
    sizeRow: { flexDirection: "row", gap: 5 },
    sizeChip: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      height: 22,
      justifyContent: "center",
    },
    sizeChipSelected: {
      backgroundColor: colors.text,
      borderColor: colors.text,
    },
    sizeText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 10.5,
    },
    sizeTextSelected: {
      color: colors.background,
      fontFamily: fonts.sans.semiBold,
    },
    slideGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    slide: {
      aspectRatio: 16 / 10,
      backgroundColor: colors.background,
      borderColor: colors.border,
      borderRadius: 5,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 5,
      width: "31.4%",
    },
    slideCenter: {
      alignItems: "center",
      flex: 1,
      gap: 3,
      justifyContent: "center",
    },
    slideTitle: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 11,
      letterSpacing: -0.2,
    },
    slideLine: { borderRadius: 1.5, height: 3 },
    slideStack: { flex: 1, gap: 3.5, justifyContent: "center" },
    slideBars: {
      alignItems: "flex-end",
      flex: 1,
      flexDirection: "row",
      gap: 3,
      justifyContent: "center",
      paddingHorizontal: 4,
    },
    slideBar: { borderRadius: 1.5, flex: 1 },
    slideSplit: { flex: 1, flexDirection: "row", gap: 4 },
    slideBlock: { borderRadius: 3, width: "40%" },
    lock: {
      backgroundColor: colors.background,
      borderRadius: 10,
      gap: 8,
      overflow: "hidden",
      paddingBottom: 8,
      paddingHorizontal: 8,
      paddingTop: 10,
    },
    lockClock: { alignItems: "center" },
    lockDay: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 10.5,
    },
    lockTime: {
      color: colors.text,
      fontFamily: fonts.display.light,
      fontSize: 38,
      letterSpacing: -1,
      lineHeight: 42,
    },
    banner: {
      alignItems: "flex-start",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      padding: 8,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
    },
    bannerIcon: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderCurve: "continuous",
      borderRadius: 6,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    bannerHead: { flexDirection: "row", justifyContent: "space-between" },
    bannerApp: {
      color: colors.textMuted,
      fontFamily: fonts.sans.semiBold,
      fontSize: 9.5,
      letterSpacing: 0.2,
      textTransform: "uppercase",
    },
    bannerNow: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 9.5,
    },
    bannerTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 11.5,
    },
    bannerBody: {
      color: colors.textBase,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
      lineHeight: 14.5,
    },
    sourceRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    sourceLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      width: 92,
    },
    sourceTrack: {
      backgroundColor: colors.muted,
      borderRadius: 2,
      flex: 1,
      height: 4,
      overflow: "hidden",
    },
    sourceFill: {
      backgroundColor: colors.accent,
      borderRadius: 2,
      height: 4,
      transformOrigin: "left center",
      width: "100%",
    },
    sourceCount: {
      color: colors.textMuted,
      fontFamily: fonts.mono.regular,
      fontSize: 10,
      textAlign: "right",
      width: 16,
    },
    rankRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 7,
      paddingHorizontal: 7,
      paddingVertical: 5,
    },
    rankRowTop: { backgroundColor: colors.accentSoft },
    rankIndex: {
      color: colors.textMuted,
      fontFamily: fonts.mono.medium,
      fontSize: 10.5,
      width: 10,
    },
    rankLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 11.5,
    },
    rankScore: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 10.5,
    },
    rankTopText: { color: colors.text, fontFamily: fonts.sans.semiBold },
  });
