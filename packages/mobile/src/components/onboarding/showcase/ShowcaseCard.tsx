/**
 * "Here's what that looks like" — the showcase card, the centerpiece of the
 * onboarding.
 *
 * Five short chapters, each a real request typed into a mini copy of the
 * chat, then Stella's agents visibly doing the work (an agent window
 * animating the job, activity rows ticking in, an approval when money is
 * involved), then the reply. The chapter strip jumps to or replays any
 * chapter, chapters auto-advance after a short hold, and Continue is never
 * gated on watching.
 *
 * Only the active chapter mounts, and its timeline pauses whenever the card
 * scrolls out of view, the app leaves the foreground, or the step is done.
 * Under reduced motion each chapter shows its finished state at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  ZoomIn,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useT } from "../../../i18n";
import { selectionTick } from "../../../lib/haptics";
import { useAppVisible } from "../../../lib/use-app-visible";
import { type Colors } from "../../../theme/colors";
import { fonts } from "../../../theme/fonts";
import { fadeHex } from "../../../theme/oklch";
import { useColors } from "../../../theme/theme-context";
import { Icon } from "../../Icon";
import { fadeEntering, fadeExiting, SpringPressable } from "../motion";
import {
  OnboardingCard,
  PrimaryAction,
  SettledCard,
  useCardStyles,
} from "../OnboardingCard";
import {
  AUTO_ADVANCE_HOLD_MS,
  CHAPTERS,
  TYPE_CHAR_MS,
  TYPE_START_DELAY_MS,
  chapterDuration,
  chapterKey,
  type ChapterSpec,
} from "./chapters";
import {
  MiniAssistantBubble,
  MiniComposer,
  MiniConfirm,
  MiniReceipt,
  MiniUserBubble,
  MiniWorking,
} from "./MiniChat";
import { ChapterScene } from "./scenes";
import { useChoreography } from "./use-choreography";

const STAGE_HEIGHT = 344;

type ShowcaseCardProps = {
  active: boolean;
  answered: boolean;
  /** The card is inside the visible part of the transcript. */
  onScreen: boolean;
  onContinue: () => void;
};

export function ShowcaseCard({
  active,
  answered,
  onScreen,
  onContinue,
}: ShowcaseCardProps) {
  const t = useT();
  const colors = useColors();
  const cardStyles = useCardStyles();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();
  const appVisible = useAppVisible();
  const [chapterIndex, setChapterIndex] = useState(0);
  const [playNonce, setPlayNonce] = useState(0);
  const [chapterDone, setChapterDone] = useState(false);
  const [played, setPlayed] = useState<ReadonlySet<string>>(() => new Set());
  const advanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const playing = active && onScreen && appVisible && !reducedMotion;

  const clearAdvance = useCallback(() => {
    if (advanceRef.current) {
      clearTimeout(advanceRef.current);
      advanceRef.current = null;
    }
  }, []);
  useEffect(() => clearAdvance, [clearAdvance]);

  const handleDone = useCallback(
    (index: number) => {
      const chapter = CHAPTERS[index]!;
      setPlayed((previous) => {
        if (previous.has(chapter.id)) return previous;
        const next = new Set(previous);
        next.add(chapter.id);
        return next;
      });
      setChapterDone(true);
      if (index >= CHAPTERS.length - 1) return;
      clearAdvance();
      advanceRef.current = setTimeout(() => {
        advanceRef.current = null;
        setChapterDone(false);
        setChapterIndex(index + 1);
      }, AUTO_ADVANCE_HOLD_MS);
    },
    [clearAdvance],
  );

  const playChapter = useCallback(
    (index: number) => {
      selectionTick();
      clearAdvance();
      setChapterDone(false);
      setChapterIndex(index);
      setPlayNonce((nonce) => nonce + 1);
    },
    [clearAdvance],
  );

  if (answered) {
    return (
      <SettledCard
        icon="play"
        title={t("mobile.onboarding.showcase.settledTitle")}
        description={CHAPTERS.map((chapter) =>
          t(chapterKey(chapter.id, "word")),
        ).join(" · ")}
      />
    );
  }

  const chapter = CHAPTERS[chapterIndex]!;
  const runKey = `${chapter.id}:${playNonce}`;

  return (
    <OnboardingCard>
      <View style={styles.titleRow}>
        <Animated.Text
          key={`title:${chapter.id}`}
          entering={fadeEntering(0, 260)}
          style={[cardStyles.title, styles.grow]}
        >
          {t(chapterKey(chapter.id, "title"))}
        </Animated.Text>
        <View style={styles.replaySlot}>
          {chapterDone || reducedMotion ? (
            <Animated.View
              entering={ZoomIn.springify()
                .damping(32)
                .stiffness(260)
                .reduceMotion(ReduceMotion.System)}
              exiting={fadeExiting(120)}
            >
              <SpringPressable
                onPress={() => playChapter(chapterIndex)}
                accessibilityRole="button"
                accessibilityLabel={t("mobile.onboarding.showcase.replay")}
                hitSlop={8}
                pressScale={0.88}
                style={styles.replay}
              >
                <Icon name="rotate-ccw" size={13} color={colors.text} weight="semibold" />
              </SpringPressable>
            </Animated.View>
          ) : null}
        </View>
      </View>

      <View style={styles.stage} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Chapter
          key={runKey}
          spec={chapter}
          playing={playing}
          instant={reducedMotion}
          onDone={() => handleDone(chapterIndex)}
        />
      </View>

      <View
        style={styles.strip}
        accessibilityRole="tablist"
        accessibilityLabel={t("mobile.onboarding.showcase.tablist")}
      >
        {CHAPTERS.map((spec, index) => (
          <ChapterTab
            key={spec.id}
            label={t(chapterKey(spec.id, "word"))}
            active={index === chapterIndex}
            complete={played.has(spec.id)}
            durationMs={chapterDuration(spec)}
            playing={playing}
            instant={reducedMotion}
            runKey={runKey}
            onPress={() => playChapter(index)}
          />
        ))}
      </View>

      <Animated.Text
        key={`caption:${chapter.id}`}
        entering={fadeEntering(80, 300)}
        style={cardStyles.body}
      >
        {t(chapterKey(chapter.id, "caption"))}
      </Animated.Text>

      <View style={cardStyles.actions}>
        <PrimaryAction
          label={t("mobile.common.continue")}
          onPress={onContinue}
          disabled={!active}
          style={styles.grow}
        />
      </View>
    </OnboardingCard>
  );
}

function Chapter({
  spec,
  playing,
  instant,
  onDone,
}: {
  spec: ChapterSpec;
  playing: boolean;
  instant: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const has = useChoreography({ cues: spec.cues, playing, instant, onDone });
  const ct = (field: string) => t(chapterKey(spec.id, field));
  const prompt = ct("prompt");
  const sendAt = spec.cues.find((cue) => cue.id === "send")?.at ?? 1500;
  // Long translations type a little faster so the send still lands on cue.
  const charMs = Math.max(
    12,
    Math.min(TYPE_CHAR_MS, (sendAt - TYPE_START_DELAY_MS - 180) / Math.max(1, prompt.length)),
  );
  const workingUntil = spec.workingUntil ?? spec.receipts[0]?.cue ?? "reply";

  const pressed = spec.confirm ? has("confirm-press") : false;
  const pressedRef = useRef(pressed);
  useEffect(() => {
    // The approval tap is the demo's one physical moment: feel it too.
    if (pressed && !pressedRef.current && playing) selectionTick();
    pressedRef.current = pressed;
  }, [pressed, playing]);

  const parts = spec.order.map((part) => {
    switch (part) {
      case "scene":
        return has("scene") ? <ChapterScene key="scene" id={spec.id} has={has} /> : null;
      case "confirm":
        return spec.confirm && has(spec.confirm.cue) ? (
          <MiniConfirm
            key="confirm"
            title={ct("confirmTitle")}
            detail={ct("confirmDetail")}
            amount={ct("amount")}
            action={ct("confirm")}
            doneLabel={ct("confirmed")}
            pressed={pressed}
            done={has(spec.confirm.doneCue)}
          />
        ) : null;
      case "receipts":
        return spec.receipts.map((receipt) =>
          has(receipt.cue) ? (
            <MiniReceipt
              key={receipt.cue}
              icon={receipt.icon}
              label={ct(receipt.key)}
              done={has(`${receipt.cue}-done`)}
            />
          ) : null,
        );
      case "reply":
        return has("reply") ? (
          <MiniAssistantBubble key="reply">{ct("reply")}</MiniAssistantBubble>
        ) : null;
    }
  });

  return (
    <Animated.View
      entering={fadeEntering(0, 220)}
      exiting={fadeExiting(150)}
      style={styles.chapter}
    >
      <View style={styles.thread}>
        {has("send") ? <MiniUserBubble>{prompt}</MiniUserBubble> : null}
        {has("working") && !has(workingUntil) ? (
          <MiniWorking label={ct("working")} animating={playing} />
        ) : null}
        {parts}
      </View>
      <MiniComposer
        text={prompt}
        placeholder={t("mobile.onboarding.showcase.placeholder")}
        typing={playing}
        sent={instant || has("send")}
        charMs={charMs}
        startDelayMs={TYPE_START_DELAY_MS}
      />
    </Animated.View>
  );
}

function ChapterTab({
  label,
  active,
  complete,
  durationMs,
  playing,
  instant,
  runKey,
  onPress,
}: {
  label: string;
  active: boolean;
  complete: boolean;
  durationMs: number;
  playing: boolean;
  instant: boolean;
  runKey: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const progress = useSharedValue(complete ? 1 : 0);

  // A fresh run of this chapter starts the track over.
  useEffect(() => {
    if (!active) return;
    cancelAnimation(progress);
    progress.value = instant ? 1 : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  useEffect(() => {
    if (!active) {
      cancelAnimation(progress);
      progress.value = withTiming(complete ? 1 : 0, { duration: 240 });
      return;
    }
    if (instant) {
      progress.value = 1;
      return;
    }
    if (!playing) {
      cancelAnimation(progress);
      return;
    }
    const remaining = Math.max(0, (1 - progress.value) * durationMs);
    progress.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    return () => cancelAnimation(progress);
  }, [active, complete, durationMs, instant, playing, progress, runKey]);

  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: progress.value }],
  }));

  return (
    <SpringPressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      hitSlop={{ top: 10, bottom: 10 }}
      pressScale={0.94}
      style={styles.tab}
    >
      <Text
        style={[
          styles.tabLabel,
          complete && styles.tabLabelComplete,
          active && styles.tabLabelActive,
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
      >
        {label}
      </Text>
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.fill,
            { backgroundColor: active ? colors.accent : colors.textWeaker },
            fillStyle,
          ]}
        />
      </View>
    </SpringPressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    grow: { flex: 1 },
    stage: {
      backgroundColor: colors.background,
      borderColor: colors.border,
      borderCurve: "continuous",
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      height: STAGE_HEIGHT,
      overflow: "hidden",
    },
    chapter: {
      flex: 1,
    },
    thread: {
      flex: 1,
      gap: 7,
      justifyContent: "flex-end",
      overflow: "hidden",
      paddingHorizontal: 10,
      paddingTop: 10,
    },
    titleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
    },
    replaySlot: {
      height: 30,
      width: 30,
    },
    replay: {
      alignItems: "center",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      height: 30,
      justifyContent: "center",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 6,
      width: 30,
    },
    strip: {
      flexDirection: "row",
      gap: 6,
    },
    tab: {
      flex: 1,
      gap: 6,
      minWidth: 0,
      paddingTop: 2,
    },
    tabLabel: {
      color: fadeHex(colors.textMuted, 0.8),
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
      textAlign: "center",
    },
    tabLabelComplete: {
      color: colors.textMuted,
    },
    tabLabelActive: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
    },
    track: {
      backgroundColor: colors.muted,
      borderRadius: 1.5,
      height: 3,
      overflow: "hidden",
    },
    fill: {
      borderRadius: 1.5,
      height: 3,
      transformOrigin: "left center",
      width: "100%",
    },
  });
