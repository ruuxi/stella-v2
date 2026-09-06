import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "expo-crypto";
import { getConvexClient } from "../lib/convex";
import type { CloudConversationAuthority } from "../lib/cloud-conversation-authority";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useT } from "../i18n";
import { fonts } from "../theme/fonts";
import { Icon } from "./Icon";
import { TopSheet } from "./TopSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../theme/theme-context";

type Conversation = { conversationId: string; title: string };
const createConversation = makeFunctionReference<"mutation", {
  clientCreateId: string; expectedOwnerGeneration: string; title: string;
}, Conversation>("cloud_apps:createMyConversation");
const getConversation = makeFunctionReference<"query", { conversationId: string }, Conversation | null>("cloud_apps:getMyConversation");
const historySnapshot = makeFunctionReference<"query", Record<string, never>, {
  snapshotUpdatedAt: number;
}>("cloud_apps:getMyConversationHistorySnapshot");
const historyPage = makeFunctionReference<"query", {
  snapshotUpdatedAt: number;
  paginationOpts: { numItems: number; cursor: string | null };
}, { page: Conversation[]; isDone: boolean; continueCursor: string }>("cloud_apps:listMyConversationsPage");

/** Selection is scoped by the parent's account/generation key. The original
 * long-running chat always remains reachable, including outside history pages. */
export function ConversationSwitcher({ authority, children }: {
  authority: CloudConversationAuthority;
  children: (authority: CloudConversationAuthority) => ReactNode;
}) {
  const colors = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const storageKey = `stella.mobile.selected-chat.v1:${JSON.stringify([authority.accountScope, authority.ownerGeneration])}`;
  const [restoring, setRestoring] = useState(true);
  const persistence = useRef(Promise.resolve());
  const [selected, setSelected] = useState<Conversation>({ conversationId: authority.conversationId, title: "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const createId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Conversation[]>([]);
  const pageRef = useRef<{ snapshotUpdatedAt: number; cursor: string | null } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    let active = true;
    // A cached preference must not strand startup when Convex is offline.
    const timeout = setTimeout(() => {
      if (active) setRestoring(false);
      active = false;
    }, 8_000);
    void (async () => {
      try {
        const conversationId = await AsyncStorage.getItem(storageKey);
        if (conversationId && conversationId !== authority.conversationId) {
          const restored = await getConvexClient().query(getConversation, { conversationId });
          if (active && restored) setSelected(restored);
        }
      } catch {
        // Storage/offline failures still leave the main chat available.
      } finally {
        clearTimeout(timeout);
        if (active) setRestoring(false);
      }
    })();
    return () => { active = false; clearTimeout(timeout); };
  }, [authority.conversationId, storageKey]);
  const selectConversation = (conversation: Conversation) => {
    setSelected(conversation);
    persistence.current = persistence.current.then(() =>
      AsyncStorage.setItem(storageKey, conversation.conversationId),
    ).catch(() => undefined);
  };
  const titleFor = (conversation: Conversation) =>
    conversation.conversationId === authority.conversationId
      ? t("mobile.chat.mainChat") : conversation.title || t("mobile.nav.chat");
  const button = { paddingHorizontal: 16, paddingVertical: 12, minHeight: 44 };
  const text = { color: colors.text, fontSize: 14, fontFamily: fonts.sans.medium };

  const startChat = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Retain this identifier on failure so retry cannot create duplicates.
      createId.current ??= `mobile-new-chat:${randomUUID()}`;
      const conversation = await getConvexClient().mutation(createConversation, {
        clientCreateId: createId.current,
        expectedOwnerGeneration: authority.ownerGeneration,
        title: t("sidebar.newChat"),
      });
      createId.current = null;
      selectConversation(conversation);
      setOpen(false);
    } catch {
      setError(t("mobile.chat.createFailed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const loadHistory = async (reset: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (reset || !pageRef.current) {
        const snapshot = await getConvexClient().query(historySnapshot, {});
        pageRef.current = { ...snapshot, cursor: null };
      }
      const page = await getConvexClient().query(historyPage, {
        snapshotUpdatedAt: pageRef.current.snapshotUpdatedAt,
        paginationOpts: { cursor: pageRef.current.cursor, numItems: 25 },
      });
      pageRef.current.cursor = page.continueCursor;
      setRows((previous) => reset ? page.page : [...previous, ...page.page]);
      setHasMore(!page.isDone);
    } catch {
      setError(t("shell.topbar.conversation.historyRetry"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <View style={{ flex: 1 }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("shell.topbar.conversation.history")} disabled={busy || restoring}
        style={{ ...button, flex: 1 }} onPress={() => { setOpen(true); void loadHistory(true); }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Text style={{ ...text, flexShrink: 1 }} numberOfLines={1}>{titleFor(selected)}</Text><Icon name="chevron-down" size={14} color={colors.textMuted} /></View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("sidebar.newChat")} disabled={busy || restoring}
        accessibilityState={{ disabled: busy || restoring }} style={button} onPress={() => void startChat()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name="plus" size={16} color={colors.textMuted} /><Text style={text}>{busy && !open ? t("common.loading") : t("sidebar.newChat")}</Text></View>
      </Pressable>
    </View>
    {error && !open ? <Text accessibilityRole="alert" style={{ ...text, paddingHorizontal: 16 }}>{error}</Text> : null}
    {restoring ? <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator color={colors.textMuted} /></View> : children({ ...authority, conversationId: selected.conversationId })}
    <TopSheet visible={open} onClose={() => setOpen(false)}>
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top + 12 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ ...text, flex: 1, padding: 16, fontSize: 26, fontFamily: fonts.display.regular }}>{t("shell.topbar.conversation.history")}</Text>
          <Pressable accessibilityRole="button" style={button} onPress={() => setOpen(false)}><Text style={text}>{t("mobile.common.done")}</Text></Pressable>
        </View>
        <ScrollView>
          {[{ conversationId: authority.conversationId, title: "" }, ...rows.filter((row) => row.conversationId !== authority.conversationId)].map((row) =>
            <Pressable key={row.conversationId} accessibilityRole="button" accessibilityState={{ selected: row.conversationId === selected.conversationId }}
              style={button} onPress={() => { selectConversation(row); setError(null); setOpen(false); }}>
              <Text style={text}>{titleFor(row)}{row.conversationId === selected.conversationId ? " ✓" : ""}</Text>
            </Pressable>)}
          {busy ? <ActivityIndicator color={colors.textMuted} /> : null}
          {error ? <Pressable accessibilityRole="button" style={button} onPress={() => void loadHistory(true)}><Text style={text}>{error}</Text></Pressable> : null}
          {hasMore && !busy && !error ? <Pressable accessibilityRole="button" style={button} onPress={() => void loadHistory(false)}><Text style={text}>{t("mobile.chat.loadMore")}</Text></Pressable> : null}
        </ScrollView>
      </View>
    </TopSheet>
  </View>;
}
