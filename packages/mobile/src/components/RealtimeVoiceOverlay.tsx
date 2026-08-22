import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ChatMessage, MobileTask } from "../types";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import {
  INITIAL_REALTIME_VOICE_SNAPSHOT,
  MobileRealtimeVoiceSession,
  type RealtimeVoiceSnapshot,
} from "../lib/realtime-voice";
import type { RealtimeVoiceActionDispatch } from "../lib/realtime-voice-protocol";
import type { StoredPhoneAccess } from "../lib/phone-access";
import { Icon } from "./Icon";
import { RealtimeVoiceVisualizer } from "./RealtimeVoiceVisualizer";

type Props = {
  visible: boolean;
  conversationId: string | null;
  execution: "phone" | "computer";
  desktopAccess?: StoredPhoneAccess | null;
  signInRequired?: boolean;
  messages: ChatMessage[];
  tasks: readonly MobileTask[];
  chatBusy: boolean;
  onPerformAction: (request: string) => Promise<RealtimeVoiceActionDispatch>;
  onClose: () => void;
};

const phaseCopy = (snapshot: RealtimeVoiceSnapshot): string => {
  switch (snapshot.phase) {
    case "connecting":
      return "Connecting";
    case "assistant-speaking":
      return "Stella is speaking";
    case "user-speaking":
      return "Listening";
    case "listening":
      return "Listening";
    case "error":
      return "Voice disconnected";
  }
};

const animationMode = (
  snapshot: RealtimeVoiceSnapshot,
): "idle" | "listening" | "speaking" => {
  if (!snapshot.isConnected) return "idle";
  return snapshot.isAssistantSpeaking ? "speaking" : "listening";
};

export function RealtimeVoiceOverlay({
  visible,
  conversationId,
  execution,
  desktopAccess = null,
  signInRequired = false,
  messages,
  tasks,
  chatBusy,
  onPerformAction,
  onClose,
}: Props) {
  const colors = useColors();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width, height } = useWindowDimensions();
  const creatureSize = Math.min(width - 40, height * 0.46, 360);
  const [snapshot, setSnapshot] = useState<RealtimeVoiceSnapshot>(
    INITIAL_REALTIME_VOICE_SNAPSHOT,
  );
  const [retryKey, setRetryKey] = useState(0);
  const sessionRef = useRef<MobileRealtimeVoiceSession | null>(null);
  const messagesRef = useRef(messages);
  const performActionRef = useRef(onPerformAction);
  const closeRef = useRef(onClose);
  messagesRef.current = messages;
  performActionRef.current = onPerformAction;
  closeRef.current = onClose;

  useEffect(() => {
    if (!visible) return;
    setSnapshot({ ...INITIAL_REALTIME_VOICE_SNAPSHOT });
    if (signInRequired) {
      setSnapshot({
        ...INITIAL_REALTIME_VOICE_SNAPSHOT,
        phase: "error",
        error: "Sign in to Stella to use realtime voice.",
      });
      return;
    }
    if (!conversationId) return;
    const session = new MobileRealtimeVoiceSession({
      conversationId,
      messages: messagesRef.current,
      execution,
      desktopAccess,
      onSnapshot: setSnapshot,
      onPerformAction: (request) => performActionRef.current(request),
      onEndRequested: () => closeRef.current(),
    });
    sessionRef.current = session;
    void session.start();
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      void session.stop("ended");
    };
  }, [
    conversationId,
    desktopAccess,
    execution,
    retryKey,
    signInRequired,
    visible,
  ]);

  useEffect(() => {
    if (!visible) return;
    sessionRef.current?.syncAssistantMessages(messages, tasks, chatBusy);
  }, [chatBusy, messages, tasks, visible]);

  useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener("change", (state) => {
      // iOS becomes briefly `inactive` while its microphone permission sheet
      // owns focus. Keep the voice surface alive through that system prompt;
      // actual backgrounding still closes capture immediately.
      if (state === "background") closeRef.current();
    });
    return () => subscription.remove();
  }, [visible]);

  const error = snapshot.error;
  const needsSignIn = Boolean(error?.toLowerCase().includes("sign in"));
  const needsMicPermission = Boolean(
    error?.toLowerCase().includes("microphone access"),
  );

  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {visible ? (
        <>
          <StatusBar style="auto" />
          <SafeAreaView style={styles.root}>
            <View style={styles.top}>
              <Text style={styles.eyebrow}>REALTIME VOICE</Text>
              <Text style={styles.status}>{phaseCopy(snapshot)}</Text>
            </View>

            <View
              style={[
                styles.creatureStage,
                { width: creatureSize, height: creatureSize },
              ]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <RealtimeVoiceVisualizer
                isUserSpeaking={snapshot.isUserSpeaking}
                micLevel={snapshot.micLevel}
                mode={animationMode(snapshot)}
                outputLevel={snapshot.outputLevel}
                size={creatureSize}
              />
            </View>

            <View style={styles.captionArea}>
              {error ? (
                <>
                  <Text style={styles.errorText}>{error}</Text>
                  <View style={styles.errorActions}>
                    {needsSignIn ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Sign in to use realtime voice"
                        onPress={() => {
                          onClose();
                          router.replace("/login");
                        }}
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionButtonText}>Sign in</Text>
                      </Pressable>
                    ) : needsMicPermission ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Open microphone settings"
                        onPress={() => void Linking.openSettings()}
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionButtonText}>
                          Open Settings
                        </Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Retry realtime voice"
                        onPress={() => setRetryKey((value) => value + 1)}
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionButtonText}>Try again</Text>
                      </Pressable>
                    )}
                  </View>
                </>
              ) : snapshot.transcript ? (
                <Text numberOfLines={3} style={styles.transcript}>
                  {snapshot.transcript}
                </Text>
              ) : (
                <Text style={styles.hint}>
                  {snapshot.isConnected
                    ? "Speak naturally. You can interrupt at any time."
                    : "Starting a secure voice session…"}
                </Text>
              )}
            </View>

            <View style={styles.bottom}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="End realtime voice"
                hitSlop={10}
                onPress={onClose}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.closeButtonPressed,
                ]}
              >
                <Icon
                  name="x"
                  size={24}
                  color={colors.text}
                  weight="semibold"
                />
              </Pressable>
              <Text style={styles.closeLabel}>End</Text>
            </View>
          </SafeAreaView>
        </>
      ) : null}
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      alignItems: "center",
      backgroundColor: colors.background,
      flex: 1,
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    top: {
      alignItems: "center",
      gap: 8,
      minHeight: 72,
      paddingTop: 8,
    },
    eyebrow: {
      color: colors.textMuted,
      fontFamily: fonts.sans.semiBold,
      fontSize: 11,
      letterSpacing: 1.6,
    },
    status: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 17,
      letterSpacing: -0.25,
    },
    creatureStage: {
      alignItems: "center",
      justifyContent: "center",
    },
    captionArea: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 104,
      paddingHorizontal: 20,
      width: "100%",
    },
    transcript: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: -0.25,
      lineHeight: 25,
      maxWidth: 420,
      textAlign: "center",
    },
    hint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 21,
      textAlign: "center",
    },
    errorText: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      lineHeight: 22,
      maxWidth: 380,
      textAlign: "center",
    },
    errorActions: {
      flexDirection: "row",
      gap: 10,
      marginTop: 16,
    },
    actionButton: {
      backgroundColor: colors.accent,
      borderRadius: 18,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    actionButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
    },
    bottom: {
      alignItems: "center",
      gap: 7,
      minHeight: 82,
      paddingBottom: 4,
    },
    closeButton: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.text, 0.08),
      borderColor: fadeHex(colors.borderStrong, 0.7),
      borderRadius: 27,
      borderWidth: StyleSheet.hairlineWidth,
      height: 54,
      justifyContent: "center",
      width: 54,
    },
    closeButtonPressed: {
      backgroundColor: fadeHex(colors.text, 0.14),
      transform: [{ scale: 0.96 }],
    },
    closeLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
    },
  });
