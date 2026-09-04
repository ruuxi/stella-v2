import { LegendList } from "@legendapp/list/react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import { makeFunctionReference } from "convex/server";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { ChatMessage } from "../types";
import type { Colors } from "../theme/colors";
import { getConvexClient } from "../lib/convex";
import { mobileReplyLineage } from "../lib/mobile-reply-context";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { Icon } from "./Icon";

const reportQuery = makeFunctionReference<"query", { conversationId: string; threadId: string }, { resultJson?: string; errorMessage?: string; status: string } | null>("cloud_apps:getMyAgentThread");
export const replyTitle = (ref: ReplyRef) => ref.kind === "agent" ? (ref.title && ref.title !== ref.threadId ? ref.title : "Task") : ref.preview || "Message";

export function ReplyFocus({ root, messages, conversationId, colors, onClose, renderMessage, onLoadOlder, hasOlder }: {
  root: ReplyRef; messages: readonly ChatMessage[]; conversationId: string;
  colors: Colors; onClose: () => void; renderMessage: (message: ChatMessage) => ReactNode;
  onLoadOlder?: () => unknown; hasOlder?: boolean;
}) {
  const [showReport, setShowReport] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const lineage = useMemo(() => mobileReplyLineage(messages, root), [messages, root]);
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => handler.remove();
  }, [onClose]);
  useEffect(() => {
    if (!showReport || root.kind !== "agent") return;
    setReport(null);
    const watch = getConvexClient().watchQuery(reportQuery, { conversationId, threadId: root.threadId });
    const update = () => {
      try {
      const thread = watch.localQueryResult();
      if (thread === undefined) return;
      let text = thread?.errorMessage || "";
      if (thread?.resultJson) {
        try {
          const parsed: unknown = JSON.parse(thread.resultJson);
          if (parsed && typeof parsed === "object" && "finalText" in parsed && typeof parsed.finalText === "string") text = parsed.finalText;
        } catch { text = thread.resultJson; }
      }
      setReport(text || (thread?.status === "running" ? "Working…" : "No report is available yet."));
      } catch { setReport("Couldn’t load the report. Close and reopen it to retry."); }
    };
    const unsubscribe = watch.onUpdate(update);
    update();
    return unsubscribe;
  }, [conversationId, root, showReport]);
  return <View accessibilityViewIsModal style={{ position: "absolute", inset: 0, backgroundColor: colors.background, zIndex: 30 }}>
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, gap: 12 }}>
      <Text numberOfLines={1} style={{ flex: 1, color: colors.textMuted }}>{replyTitle(root)}</Text>
      {root.kind === "agent" && <Pressable accessibilityRole="button" accessibilityLabel={showReport ? "Close report" : "Report"} onPress={() => setShowReport(value => !value)} style={{ padding: 8 }}><Text style={{ color: colors.text }}>{showReport ? "Conversation" : "Report"}</Text></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="Close focused conversation" onPress={onClose} style={{ padding: 8 }}><Icon name="x" size={18} color={colors.text} /></Pressable>
    </View>
    {showReport ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <AssistantMarkdown text={report ?? "Loading report…"} colors={colors} selectable fill={false} />
    </ScrollView> : <LegendList
      style={{ flex: 1 }}
      data={lineage}
      keyExtractor={message => message.id}
      renderItem={({ item }) => <View style={{ marginBottom: 14 }}>{renderMessage(item)}</View>}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
      alignItemsAtEnd
      initialScrollAtEnd
      ListHeaderComponent={hasOlder ? <Pressable accessibilityRole="button" onPress={() => onLoadOlder?.()} style={{ padding: 12 }}><Text style={{ color: colors.textMuted }}>Load earlier messages</Text></Pressable> : null}
    />}

  </View>;
}
