/**
 * Focus (lineage) overlay — iMessage's thread view for the single chat,
 * matching desktop's `ConversationFocusOverlay`.
 *
 * The selected chain sits above the dimmed, blurred timeline in the same
 * chat column; the composer stays available below it. Three ways out: the
 * close button, a tap on the backdrop outside the chain, or the hardware
 * back gesture. A task root also offers its full report in a sheet.
 */
import { LegendList } from "@legendapp/list/react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { makeFunctionReference } from "convex/server";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { ChatMessage } from "../types";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { getConvexClient } from "../lib/convex";
import {
  mobileReplyContexts,
  mobileReplyLineage,
  type MobileReplyContexts,
} from "../lib/mobile-reply-context";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { GlassSurface, liquidGlassSupported } from "./glass";
import { Icon } from "./Icon";
import { replyTitle } from "./ReplyPreview";

export { replyTitle } from "./ReplyPreview";

export type AgentReplyRef = Extract<ReplyRef, { kind: "agent" }>;

const reportQuery = makeFunctionReference<
  "query",
  { conversationId: string; threadId: string },
  { resultJson?: string; errorMessage?: string; status: string } | null
>("cloud_apps:getMyAgentThread");

/** Live text of a task's report, or a placeholder while it loads or runs. */
function useAgentReport(conversationId: string, threadId: string): string | null {
  const [report, setReport] = useState<string | null>(null);
  useEffect(() => {
    setReport(null);
    const watch = getConvexClient().watchQuery(reportQuery, { conversationId, threadId });
    const update = () => {
      try {
        const thread = watch.localQueryResult();
        if (thread === undefined) return;
        let text = thread?.errorMessage || "";
        if (thread?.resultJson) {
          try {
            const parsed: unknown = JSON.parse(thread.resultJson);
            if (parsed && typeof parsed === "object" && "finalText" in parsed && typeof parsed.finalText === "string") {
              text = parsed.finalText;
            }
          } catch {
            text = thread.resultJson;
          }
        }
        setReport(text || (thread?.status === "running" ? "Working…" : "No report is available yet."));
      } catch {
        setReport("Couldn’t load the report. Close and reopen it to retry.");
      }
    };
    const unsubscribe = watch.onUpdate(update);
    update();
    return unsubscribe;
  }, [conversationId, threadId]);
  return report;
}

/** A task's full report in a floating panel; desktop's report popover. */
export function AgentReportSheet({
  reference,
  conversationId,
  colors,
  onClose,
}: {
  reference: AgentReplyRef;
  conversationId: string;
  colors: Colors;
  onClose: () => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const report = useAgentReport(conversationId, reference.threadId);
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [onClose]);
  return (
    <View style={styles.reportRoot} accessibilityViewIsModal>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close report"
        onPress={onClose}
        style={styles.reportBackdrop}
      />
      <View style={styles.reportPanel}>
        <View style={styles.reportHead}>
          <Text numberOfLines={1} style={styles.reportTitle}>
            {replyTitle(reference)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close report"
            onPress={onClose}
            hitSlop={6}
            style={styles.iconButton}
          >
            <Icon name="x" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
        <ScrollView style={styles.reportBody} contentContainerStyle={styles.reportBodyContent}>
          <AssistantMarkdown
            text={report ?? "Loading report…"}
            colors={colors}
            selectable
            fill={false}
          />
        </ScrollView>
      </View>
    </View>
  );
}

export function ReplyFocus({
  root,
  messages,
  conversationId,
  colors,
  onClose,
  onOpenReport,
  renderMessage,
  onLoadOlder,
  hasOlder,
}: {
  root: ReplyRef;
  messages: readonly ChatMessage[];
  conversationId: string;
  colors: Colors;
  onClose: () => void;
  /** Opens the task's full report (agent roots only). */
  onOpenReport?: (reference: AgentReplyRef) => void;
  renderMessage: (message: ChatMessage, contexts: MobileReplyContexts) => ReactNode;
  onLoadOlder?: () => unknown;
  hasOlder?: boolean;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const lineage = useMemo(() => mobileReplyLineage(messages, root), [messages, root]);
  const contexts = useMemo(() => mobileReplyContexts(lineage), [lineage]);
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [onClose]);
  const title = replyTitle(root);
  return (
    <View style={styles.root} accessibilityViewIsModal>
      {/* Backdrop: Liquid Glass blurs the timeline on iOS 26+; elsewhere a
          strong tint stands in. Tapping it closes focus, like desktop's
          click outside the chain. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close focused conversation"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      >
        <GlassSurface
          glass="regular"
          radius={0}
          pointerEvents="none"
          tintColor={liquidGlassSupported ? fadeHex(colors.background, 0.62) : undefined}
          fallbackColor={fadeHex(colors.background, 0.92)}
          style={StyleSheet.absoluteFill}
        />
      </Pressable>
      <View style={styles.header} pointerEvents="box-none">
        <View style={styles.headerPill}>
          <Text numberOfLines={1} style={styles.headerTitle} accessibilityRole="header">
            {title}
          </Text>
          {root.kind === "agent" && onOpenReport ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="More: open the task's full report"
              onPress={() => onOpenReport(root)}
              hitSlop={6}
              style={styles.reportButton}
            >
              <Text style={styles.reportButtonText}>More</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close focused conversation"
            accessibilityHint="Back to the whole conversation"
            onPress={onClose}
            hitSlop={6}
            style={styles.iconButton}
          >
            <Icon name="x" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>
      <View style={styles.panel} pointerEvents="box-none">
        <LegendList
          style={styles.list}
          data={lineage}
          keyExtractor={(message) => message.id}
          renderItem={({ item }) => (
            <View style={styles.row}>{renderMessage(item, contexts)}</View>
          )}
          contentContainerStyle={styles.listContent}
          alignItemsAtEnd
          initialScrollAtEnd
          ListHeaderComponent={
            hasOlder ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => onLoadOlder?.()}
                style={styles.loadOlder}
              >
                <Text style={styles.loadOlderText}>Load earlier messages</Text>
              </Pressable>
            ) : null
          }
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 30 },
    header: {
      position: "absolute",
      top: 8,
      left: 16,
      right: 16,
      zIndex: 1,
      flexDirection: "row",
      justifyContent: "flex-end",
    },
    headerPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: "100%",
      paddingLeft: 12,
      paddingRight: 4,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    headerTitle: {
      flexShrink: 1,
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12.5,
    },
    reportButton: { paddingVertical: 6, paddingHorizontal: 8, borderRadius: 999 },
    reportButtonText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11.5,
    },
    iconButton: {
      width: 30,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 999,
    },
    panel: { flex: 1, paddingTop: 48 },
    list: { flex: 1 },
    listContent: { paddingHorizontal: 16, paddingBottom: 12 },
    row: { marginBottom: 14 },
    loadOlder: { padding: 12 },
    loadOlderText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12.5,
    },
    reportRoot: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 40 },
    reportBackdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.2)" },
    reportPanel: {
      position: "absolute",
      top: 52,
      left: 12,
      right: 12,
      maxHeight: "65%",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 16,
      overflow: "hidden",
    },
    reportHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingLeft: 14,
      paddingRight: 8,
      paddingVertical: 8,
    },
    reportTitle: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 12.5,
    },
    reportBody: { flexShrink: 1 },
    reportBodyContent: { paddingHorizontal: 14, paddingBottom: 12, paddingTop: 2 },
  });
