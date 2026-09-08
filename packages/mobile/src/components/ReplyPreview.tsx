/**
 * iMessage-style reply preview above an assistant bubble, and the
 * "N replies" badge under an original message. Mirrors desktop's
 * `ReplyPreview` / `ReplyCountBadge`: a small muted bubble quotes what Stella
 * is replying to (the cited message, or the task with its live status), joined
 * to the reply by a thin connector; tapping it opens focus on that target.
 *
 * Whether a bubble appears at all is decided upstream by the shared
 * reply-context rule (`@stella/contracts/reply-context`).
 */
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import type { MobileAgentState } from "../lib/mobile-reply-context";
import { Icon } from "./Icon";

export type ReplyAgentStatus = MobileAgentState;

export const replyTitle = (ref: ReplyRef) =>
  ref.kind === "agent"
    ? ref.title && ref.title !== ref.threadId
      ? ref.title
      : "Task"
    : ref.preview || "Message";

const statusLabel = (status: ReplyAgentStatus | undefined) =>
  status === "running" ? "Working" : status === "error" ? "Failed" : "Done";

export function ReplyPreview({
  reference,
  status,
  colors,
  onOpen,
  onOpenReport,
}: {
  reference: ReplyRef;
  status?: ReplyAgentStatus;
  colors: Colors;
  onOpen: () => void;
  /** Agent references only: opens the task's full report. */
  onOpenReport?: () => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const title = replyTitle(reference);
  return (
    <View style={styles.stack}>
      {reference.kind === "message" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show this message and its replies: ${title}`}
          onPress={onOpen}
          style={({ pressed }) => [
            styles.bubble,
            reference.role === "user" ? styles.bubbleUser : styles.bubbleAssistant,
            pressed && styles.bubblePressed,
          ]}
        >
          <Text style={styles.label} numberOfLines={1}>
            {reference.role === "user" ? "Replying to you" : "Replying to Stella"}
          </Text>
          <Text style={styles.text} numberOfLines={2}>
            {reference.preview || "(empty message)"}
          </Text>
        </Pressable>
      ) : (
        <View style={[styles.bubble, styles.bubbleAgent]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show this task and its updates: ${title}, ${statusLabel(status)}`}
            onPress={onOpen}
            style={({ pressed }) => [styles.agentHead, pressed && styles.bubblePressed]}
          >
            {/* The glyph alone carries the task's state (desktop parity). */}
            <View style={styles.agentIcon}>
              {status === "running" ? (
                <ActivityIndicator size="small" color={colors.textMuted} style={styles.spinner} />
              ) : (
                <Icon
                  name={status === "error" ? "alert-circle" : "check"}
                  size={14}
                  color={status === "error" ? colors.danger : colors.textMuted}
                />
              )}
            </View>
            <Text style={styles.agentTitle} numberOfLines={1}>
              {title}
            </Text>
          </Pressable>
          {onOpenReport ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="More: open the task's full report"
              onPress={onOpenReport}
              hitSlop={6}
              style={({ pressed }) => [styles.reportToggle, pressed && styles.bubblePressed]}
            >
              <Text style={styles.reportToggleText}>More</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      <View pointerEvents="none" style={styles.connector} />
    </View>
  );
}

export function ReplyCountBadge({
  count,
  colors,
  onOpen,
}: {
  count: number;
  colors: Colors;
  onOpen: () => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (count <= 0) return null;
  const label = count === 1 ? "1 reply" : `${count} replies`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Show this message and its replies`}
      onPress={onOpen}
      hitSlop={6}
      style={({ pressed }) => [styles.count, pressed && styles.bubblePressed]}
    >
      <View style={styles.countDot} />
      <Text style={styles.countText}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: {
      position: "relative",
      alignSelf: "flex-start",
      maxWidth: "85%",
      marginLeft: 14,
      paddingBottom: 10,
    },
    connector: {
      position: "absolute",
      left: -9,
      bottom: -2,
      width: 14,
      height: 18,
      borderLeftWidth: 1.5,
      borderBottomWidth: 1.5,
      borderColor: colors.borderStrong,
      borderBottomLeftRadius: 10,
      opacity: 0.85,
    },
    bubble: {
      minWidth: 0,
      maxWidth: "100%",
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceInset,
      gap: 2,
    },
    bubblePressed: { backgroundColor: fadeHex(colors.text, 0.06) },
    bubbleUser: { borderBottomRightRadius: 4 },
    bubbleAssistant: { borderBottomLeftRadius: 4 },
    label: {
      color: colors.textMuted,
      fontFamily: fonts.sans.semiBold,
      fontSize: 11,
      letterSpacing: 0.1,
      opacity: 0.85,
    },
    text: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 12.5,
      lineHeight: 17,
      opacity: 0.8,
    },
    bubbleAgent: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 0,
      paddingHorizontal: 0,
      paddingRight: 4,
      overflow: "hidden",
    },
    agentHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexShrink: 1,
      minWidth: 0,
      paddingVertical: 7,
      paddingLeft: 12,
      paddingRight: 8,
      borderRadius: 16,
    },
    agentIcon: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
    spinner: { transform: [{ scale: 0.6 }] },
    agentTitle: {
      flexShrink: 1,
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 12.5,
    },
    reportToggle: {
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderRadius: 999,
    },
    reportToggleText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
    },
    count: {
      alignSelf: "flex-end",
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingVertical: 5,
      paddingHorizontal: 8,
      borderRadius: 999,
    },
    countDot: {
      width: 5,
      height: 5,
      borderRadius: 999,
      backgroundColor: colors.textMuted,
      opacity: 0.6,
    },
    countText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11.5,
    },
  });
