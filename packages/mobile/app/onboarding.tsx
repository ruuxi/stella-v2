import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated as RNAnimated,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
  withSpring,
} from "react-native-reanimated";
import { AppBackdrop } from "../src/components/AppBackdrop";
import { AssistantBubble, SENT_BUBBLE_POP, useBubblePop } from "../src/components/BubblePop";
import { AssistantMarkdown } from "../src/components/AssistantMarkdown";
import { GlassSurface } from "../src/components/glass";
import { WorkingIndicator } from "../src/components/WorkingIndicator";
import { StellaMarkHero } from "../src/components/stella-mark/StellaMarkHero";
import { OnboardingComposer } from "../src/components/onboarding/OnboardingComposer";
import {
  cardEntering,
  fadeEntering,
  popEntering,
  SPRING_SOFT,
  SpringPressable,
} from "../src/components/onboarding/motion";
import { AccountCard } from "../src/components/onboarding/cards/AccountCard";
import { ComputerCard } from "../src/components/onboarding/cards/ComputerCard";
import { GmailCard } from "../src/components/onboarding/cards/GmailCard";
import { HelloCard } from "../src/components/onboarding/cards/HelloCard";
import { ReadyCard } from "../src/components/onboarding/cards/ReadyCard";
import { ThemeCard } from "../src/components/onboarding/cards/ThemeCard";
import { ShowcaseCard } from "../src/components/onboarding/showcase/ShowcaseCard";
import {
  useOnboardingChat,
  type OnboardingEntry,
} from "../src/components/onboarding/use-onboarding-chat";
import { usePairingStepNeeded } from "../src/components/onboarding/use-pairing-step";
import {
  createViewportStore,
  useOnScreen,
  ViewportContext,
} from "../src/components/onboarding/viewport";
import { authClient } from "../src/lib/auth-client";
import { tapMedium } from "../src/lib/haptics";
import {
  markOnboardingSeen,
  type OnboardingStep,
} from "../src/lib/onboarding";
import { setPendingComposerDraft } from "../src/lib/onboarding-handoff";
import { useSplashHidden } from "../src/lib/splash-state";
import { type Colors } from "../src/theme/colors";
import { fonts } from "../src/theme/fonts";
import { useColors } from "../src/theme/theme-context";
import { useT } from "../src/i18n";

const HERO_SIZE = 76;
const HERO_ID = "hero";
/** Same inset the chat list uses, so bubbles sit where they will in chat. */
const HORIZONTAL_INSET = 12;

/**
 * First run, as a conversation. Stella introduces herself in scripted
 * messages that look exactly like the chat; each carries a card the user
 * answers (or skips), and typing anything into the composer goes straight
 * to the real chat with that message sent.
 */
export default function OnboardingScreen() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const session = authClient.useSession();
  const anonymous = session.data?.user?.isAnonymous === true;
  const signedIn = Boolean(session.data?.user) && !anonymous;
  const email = signedIn ? (session.data?.user?.email ?? null) : null;

  const splashHidden = useSplashHidden();
  const pairingNeeded = usePairingStepNeeded(signedIn);
  const { entries, steps, currentStep, answers, typing, handoff, answer } =
    useOnboardingChat({
      started: splashHidden,
      skipPairing: pairingNeeded === false,
      skipGmail: !signedIn,
    });
  const [finishing, setFinishing] = useState(false);
  const finishingRef = useRef(false);

  const finish = useCallback(
    (prompt?: string) => {
      if (finishingRef.current) return;
      finishingRef.current = true;
      setFinishing(true);
      tapMedium();
      if (prompt) setPendingComposerDraft({ text: prompt, send: true });
      void markOnboardingSeen().finally(() => router.replace("/chat"));
    },
    [router],
  );

  const goSignIn = useCallback(() => {
    // Progress is already saved on this step, so coming back from sign-in
    // (signed in, or as a guest again) lands on this same message.
    router.replace("/login");
  }, [router]);

  /* ── Viewport + scrolling ─────────────────────────────────────── */
  const [viewport] = useState(createViewportStore);
  const scrollRef = useRef<ScrollView | null>(null);
  const followEndRef = useRef(false);
  const pendingEntryScrollRef = useRef<string | null>(null);

  // Decided while rendering (not in an effect) so the content-size event the
  // new row causes already sees the right intent: a reply or the typing
  // indicator follows the end, a new message scrolls to its own top.
  const lastEntry = entries[entries.length - 1];
  const scrollIntentKeyRef = useRef<string | null>(null);
  const scrollIntentKey = `${lastEntry?.id ?? ""}|${typing ? 1 : 0}`;
  if (scrollIntentKeyRef.current !== scrollIntentKey) {
    const firstRender = scrollIntentKeyRef.current === null;
    scrollIntentKeyRef.current = scrollIntentKey;
    if (firstRender && entries.length > 1) {
      // Resumed mid-flow: open on the message waiting for an answer.
      const waiting = [...entries].reverse().find((entry) => entry.kind === "assistant");
      pendingEntryScrollRef.current = waiting?.id ?? null;
    } else if (typing) {
      followEndRef.current = true;
    } else if (lastEntry?.fresh && lastEntry.kind === "assistant") {
      followEndRef.current = false;
      // The greeting sits right under the hero: leave the opening framed.
      if (entries.length > 1) pendingEntryScrollRef.current = lastEntry.id;
    } else if (lastEntry?.fresh) {
      followEndRef.current = true;
    }
  }

  const onContentSizeChange = useCallback(() => {
    if (followEndRef.current) {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const onEntryLayout = useCallback(
    (id: string, event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      viewport.setLayout(id, y, height);
      if (pendingEntryScrollRef.current !== id) return;
      pendingEntryScrollRef.current = null;
      // Cards are tall: bring a new message in from its top (the scroll view
      // clamps at the end of the transcript).
      const target = Math.max(0, y - 8);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: target, animated: true });
      });
    },
    [viewport],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      viewport.setScroll(event.nativeEvent.contentOffset.y);
    },
    [viewport],
  );

  // Voice-over hears each message as it arrives.
  const lastFreshAssistant =
    lastEntry?.kind === "assistant" && lastEntry.fresh ? lastEntry.step : null;

  /* ── Prose + cards per step ───────────────────────────────────── */
  const proseFor = useCallback(
    (step: OnboardingStep): string =>
      step === "account" && signedIn
        ? t("mobile.onboarding.messages.accountSignedIn")
        : t(`mobile.onboarding.messages.${step}`),
    [signedIn, t],
  );

  useEffect(() => {
    if (!lastFreshAssistant) return;
    AccessibilityInfo.announceForAccessibility(proseFor(lastFreshAssistant));
  }, [lastFreshAssistant, proseFor]);

  const cardFor = (step: OnboardingStep, fresh: boolean) => {
    const active = currentStep === step && !finishing;
    const answered = answers[step];
    switch (step) {
      case "hello":
        return (
          <HelloCard
            active={active}
            answered={answered !== undefined}
            fresh={fresh}
            onContinue={() => answer("hello", "done")}
          />
        );
      case "showcase":
        return (
          <OnScreen id={`assistant:${step}`}>
            {(onScreen) => (
              <ShowcaseCard
                active={active}
                answered={answered !== undefined}
                onScreen={onScreen}
                onContinue={() => answer("showcase", "done")}
              />
            )}
          </OnScreen>
        );
      case "computer":
        return (
          <OnScreen id={`assistant:${step}`}>
            {(onScreen) => (
              <ComputerCard
                active={active}
                answered={answered}
                onScreen={onScreen}
                canPair={signedIn}
                onSignIn={goSignIn}
                onAnswer={(kind) => answer("computer", kind)}
              />
            )}
          </OnScreen>
        );
      case "account":
        return (
          <AccountCard
            active={active}
            answered={answered}
            signedIn={signedIn}
            email={email}
            onSignIn={goSignIn}
            onAnswer={(kind) => answer("account", kind)}
          />
        );
      case "gmail":
        return (
          <GmailCard
            active={active}
            answered={answered}
            onAnswer={(kind) => answer("gmail", kind)}
          />
        );
      case "theme":
        return (
          <ThemeCard
            active={active}
            answered={answered}
            onAnswer={(kind) => answer("theme", kind)}
          />
        );
      case "ready":
        return <ReadyCard active={active} fresh={fresh} onStart={finish} />;
    }
  };

  const renderEntry = (entry: OnboardingEntry) => {
    if (entry.kind === "user") {
      return (
        <View key={entry.id} onLayout={(event) => onEntryLayout(entry.id, event)}>
          <UserBubble text={entry.text} fresh={entry.fresh} styles={styles} />
        </View>
      );
    }
    return (
      <View
        key={entry.id}
        onLayout={(event) => onEntryLayout(entry.id, event)}
        style={styles.assistantRow}
      >
        <AssistantBubble style={styles.assistantBubble} animate={entry.fresh}>
          <AssistantMarkdown
            text={proseFor(entry.step)}
            colors={colors}
            fill={false}
          />
        </AssistantBubble>
        <Animated.View entering={entry.fresh ? cardEntering(220) : undefined}>
          {cardFor(entry.step, entry.fresh)}
        </Animated.View>
      </View>
    );
  };

  const progress =
    (steps.indexOf(currentStep) + (finishing ? 1 : 0)) / steps.length;

  /* ── Keyboard: the composer rides it on the UI thread ─────────── */
  const keyboard = useAnimatedKeyboard();
  const composerLift = useAnimatedStyle(() => ({
    transform: [
      { translateY: -Math.max(0, keyboard.height.value - insets.bottom) },
    ],
  }));
  const [composerHeight, setComposerHeight] = useState(76);

  return (
    <ViewportContext.Provider value={viewport}>
      <View style={styles.root}>
        <AppBackdrop />
        <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
          <View style={styles.topSide} />
          <ProgressTrack value={progress} colors={colors} styles={styles} label={t("mobile.onboarding.progressLabel", {
            current: String(steps.indexOf(currentStep) + 1),
            total: String(steps.length),
          })} />
          <View style={[styles.topSide, styles.topSideEnd]}>
            <GlassSurface glass="regular" interactive radius={999} style={styles.skipGlass}>
              <SpringPressable
                onPress={() => finish()}
                disabled={finishing}
                hitSlop={8}
                pressScale={0.92}
                accessibilityRole="button"
                accessibilityLabel={t("mobile.onboarding.skipLabel")}
                style={styles.skip}
              >
                <Text style={styles.skipText}>{t("mobile.onboarding.skip")}</Text>
              </SpringPressable>
            </GlassSurface>
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: composerHeight + insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={onScroll}
          scrollEventThrottle={64}
          onLayout={(event) => {
            viewport.setHeight(event.nativeEvent.layout.height);
          }}
          onContentSizeChange={onContentSizeChange}
        >
          <View onLayout={(event) => onEntryLayout(HERO_ID, event)}>
            {splashHidden ? <Hero styles={styles} colors={colors} /> : <View style={styles.heroPlaceholder} />}
          </View>
          {entries.map(renderEntry)}
          <View style={styles.indicator}>
            <WorkingIndicator active={typing} exitImmediately={handoff} />
          </View>
        </ScrollView>

        <Animated.View
          style={[
            styles.composerWrap,
            { paddingBottom: insets.bottom + 8 },
            composerLift,
          ]}
          onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
        >
          <OnboardingComposer onSend={finish} disabled={finishing} />
        </Animated.View>
      </View>
    </ViewportContext.Provider>
  );
}

function OnScreen({
  id,
  children,
}: {
  id: string;
  children: (onScreen: boolean) => React.ReactNode;
}) {
  const onScreen = useOnScreen(id);
  return <>{children(onScreen)}</>;
}

function Hero({ styles, colors }: { styles: Styles; colors: Colors }) {
  const onScreen = useOnScreen(HERO_ID);
  return (
    <View style={styles.hero}>
      <Animated.View entering={popEntering(0.6, 8)}>
        <StellaMarkHero size={HERO_SIZE} faceColor={colors.background} paused={!onScreen} />
      </Animated.View>
      <Animated.Text entering={fadeEntering(180, 420)} style={styles.wordmark}>
        Stella
      </Animated.Text>
    </View>
  );
}

function UserBubble({
  text,
  fresh,
  styles,
}: {
  text: string;
  fresh: boolean;
  styles: Styles;
}) {
  const pop = useBubblePop(fresh, SENT_BUBBLE_POP);
  return (
    <View style={styles.userRow}>
      <RNAnimated.View style={[styles.userBubble, pop]}>
        <Text style={styles.userText}>{text}</Text>
      </RNAnimated.View>
    </View>
  );
}

function ProgressTrack({
  value,
  colors,
  styles,
  label,
}: {
  value: number;
  colors: Colors;
  styles: Styles;
  label: string;
}) {
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: withSpring(Math.max(0.04, value), SPRING_SOFT) }],
  }));
  return (
    <View
      style={styles.track}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
    >
      <Animated.View style={[styles.trackFill, { backgroundColor: colors.accent }, fillStyle]} />
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      backgroundColor: colors.background,
      flex: 1,
    },
    topBar: {
      alignItems: "center",
      flexDirection: "row",
      paddingBottom: 8,
      paddingHorizontal: 16,
    },
    topSide: {
      flex: 1,
    },
    topSideEnd: {
      alignItems: "flex-end",
    },
    track: {
      backgroundColor: colors.muted,
      borderRadius: 2,
      height: 4,
      overflow: "hidden",
      width: 96,
    },
    trackFill: {
      borderRadius: 2,
      height: 4,
      transformOrigin: "left center",
      width: "100%",
    },
    skipGlass: {
      borderColor: colors.panelSurfaceBorder,
      borderWidth: StyleSheet.hairlineWidth,
    },
    skip: {
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    skipText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    scroll: {
      flex: 1,
    },
    content: {
      gap: 14,
      paddingHorizontal: HORIZONTAL_INSET,
      paddingTop: 8,
    },
    hero: {
      alignItems: "center",
      gap: 2,
      paddingBottom: 6,
      paddingTop: 10,
    },
    heroPlaceholder: {
      height: HERO_SIZE + 52,
    },
    wordmark: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 30,
      letterSpacing: -0.6,
    },
    assistantRow: {
      gap: 10,
    },
    assistantBubble: {
      alignSelf: "flex-start",
      borderCurve: "continuous",
      borderRadius: 22,
      maxWidth: "92%",
      overflow: "hidden",
      paddingBottom: 0,
      paddingHorizontal: 14,
      paddingTop: 9,
    },
    userRow: {
      alignItems: "flex-end",
    },
    userBubble: {
      backgroundColor: colors.userBubbleFill,
      borderCurve: "continuous",
      borderRadius: 22,
      maxWidth: "80%",
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    userText: {
      color: colors.userBubbleText,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.52,
    },
    indicator: {
      marginTop: -4,
    },
    composerWrap: {
      bottom: 0,
      left: 0,
      paddingHorizontal: HORIZONTAL_INSET,
      paddingTop: 8,
      position: "absolute",
      right: 0,
    },
  });
