import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { isGuest } from "../../src/lib/guest-mode";
import { getOrCreateMobileDeviceId } from "../../src/lib/phone-access";
import {
  consumePendingShare,
  subscribePendingShare,
} from "../../src/lib/pending-share";
import { useChatThread, type ChatThread } from "../../src/lib/use-chat-thread";
import {
  useCloudCanonicalChatThread,
  useCloudConversationAuthority,
} from "../../src/lib/use-cloud-canonical-chat-thread";
import { MAX_OFFLINE_CHAT_IMAGES } from "../../src/lib/offline-chat-request";
import { useIsOffline } from "../../src/lib/use-network-status";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import { ChatPane } from "../../src/components/ChatPane";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import { CloudBrowserInterventionCard } from "../../src/components/CloudBrowserInterventionCard";
import type { ChatArtifact } from "../../src/types";
import { useT } from "../../src/i18n";

/**
 * The Chat tab submits portable work. The placement service prefers an
 * eligible paired computer and otherwise commits the exact turn to cloud;
 * guests retain the anonymous cloud responder.
 */
export default function ChatScreen() {
  return isGuest() ? <GuestChatScreen /> : <SignedInChatScreen />;
}

function GuestChatScreen() {
  const transport = useMemo(() => ({ kind: "guest" as const }), []);
  const thread = useChatThread({ threadId: "cloud", transport });
  return <ChatSurface guest thread={thread} />;
}

function SignedInChatScreen() {
  const authority = useCloudConversationAuthority();
  if (authority.status !== "ready") {
    return (
      <CloudAuthorityGate
        loading={authority.status === "loading"}
        issue={authority.issue?.message ?? null}
        retry={
          authority.status === "failed" && authority.issue.retryable
            ? authority.retry
            : null
        }
      />
    );
  }
  return (
    <SignedInCanonicalChat
      key={`${authority.authority.accountScope}:${authority.authority.ownerGeneration}:${authority.authority.conversationId}`}
      authority={authority.authority}
      reloadAuthority={authority.retry}
    />
  );
}

function SignedInCanonicalChat(props: {
  authority: NonNullable<
    ReturnType<typeof useCloudConversationAuthority>["authority"]
  >;
  reloadAuthority: () => void;
}) {
  const thread = useCloudCanonicalChatThread(
    props.authority,
    props.reloadAuthority,
  );
  return <ChatSurface guest={false} thread={thread} />;
}

function CloudAuthorityGate(props: {
  loading: boolean;
  issue: string | null;
  retry: (() => void) | null;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          alignItems: "center",
          flex: 1,
          gap: 14,
          justifyContent: "center",
          paddingHorizontal: 28,
        },
        message: {
          color: colors.textMuted,
          fontFamily: fonts.sans.regular,
          fontSize: 14,
          lineHeight: 20,
          textAlign: "center",
        },
        retry: {
          borderColor: colors.border,
          borderRadius: 18,
          borderWidth: StyleSheet.hairlineWidth,
          paddingHorizontal: 18,
          paddingVertical: 9,
        },
        retryText: {
          color: colors.text,
          fontFamily: fonts.sans.medium,
          fontSize: 14,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.root}>
      {props.loading ? (
        <ActivityIndicator color={colors.textMuted} />
      ) : (
        <>
          <Text style={styles.message}>{props.issue}</Text>
          {props.retry ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.retry}
              style={styles.retry}
            >
              <Text style={styles.retryText}>
                {t("mobile.common.tryAgain")}
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

function ChatSurface(props: { guest: boolean; thread: ChatThread }) {
  const { guest, thread } = props;
  const colors = useColors();
  const t = useT();
  const offline = useIsOffline();
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );
  const { setDraft, setAttachments } = thread;

  useEffect(() => {
    if (!guest) return;
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, [guest]);

  // Content shared in from another app prefills the composer (it never
  // auto-sends — the user confirms with the send button).
  useEffect(() => {
    const applyShare = () => {
      const share = consumePendingShare();
      if (!share) return;
      if (share.text) {
        setDraft((previous) =>
          previous.trim()
            ? `${previous.trimEnd()} ${share.text}`
            : (share.text ?? ""),
        );
      }
      if (share.assets?.length) {
        setAttachments((previous) => [...previous, ...share.assets!]);
      }
    };
    applyShare();
    return subscribePendingShare(applyShare);
  }, [setAttachments, setDraft]);

  const dictationHeaders = useMemo(() => {
    if (!guest || !mobileDeviceId) return undefined;
    return { "X-Stella-Mobile-Device-Id": mobileDeviceId };
  }, [guest, mobileDeviceId]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1 },
        emptyText: {
          color: colors.textMuted,
          fontFamily: fonts.display.regularItalic,
          fontSize: 22,
          letterSpacing: -0.5,
          opacity: 0.45,
        },
        authorityIssue: {
          alignItems: "center",
          backgroundColor: colors.surface,
          borderBottomColor: colors.border,
          borderBottomWidth: StyleSheet.hairlineWidth,
          flexDirection: "row",
          gap: 10,
          justifyContent: "center",
          paddingHorizontal: 16,
          paddingVertical: 9,
        },
        authorityIssueText: {
          color: colors.textMuted,
          flexShrink: 1,
          fontFamily: fonts.sans.regular,
          fontSize: 12,
          lineHeight: 17,
          textAlign: "center",
        },
        authorityRetry: {
          borderColor: colors.border,
          borderRadius: 14,
          borderWidth: StyleSheet.hairlineWidth,
          paddingHorizontal: 12,
          paddingVertical: 6,
        },
        authorityRetryText: {
          color: colors.text,
          fontFamily: fonts.sans.medium,
          fontSize: 12,
        },
      }),
    [colors],
  );

  const canSubmit =
    (thread.draft.trim().length > 0 ||
      thread.attachments.length > 0 ||
      thread.quotes.length > 0) &&
    !offline &&
    thread.storageLoaded &&
    thread.authorityReady !== false;
  const sendRealtimePrompt = thread.sendPrompt;
  const performRealtimeVoiceAction = useCallback(
    async (request: string) => sendRealtimePrompt?.(request) ?? null,
    [sendRealtimePrompt],
  );

  return (
    <View style={styles.root}>
      {thread.authorityIssue ? (
        <View style={styles.authorityIssue}>
          <Text style={styles.authorityIssueText}>
            {thread.authorityIssue.message}
          </Text>
          {thread.authorityIssue.retryable ? (
            <Pressable
              accessibilityRole="button"
              onPress={thread.authorityIssue.retry}
              style={styles.authorityRetry}
            >
              <Text style={styles.authorityRetryText}>
                {t("mobile.common.tryAgain")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ChatPane
        messages={thread.messages}
        streaming={thread.sending}
        workingIndicator={thread.workingIndicator}
        emptyContent={
          <Text style={styles.emptyText}>{t("mobile.chat.emptyPrompt")}</Text>
        }
        historyLoading={!thread.storageLoaded}
        hasOlderHistory={thread.hasOlderMessages}
        hasNewerHistory={thread.hasNewerMessages}
        historyPageLoading={thread.historyPageLoading}
        onLoadOlderHistory={thread.loadOlderMessages}
        onLoadNewerHistory={thread.loadNewerMessages}
        draft={thread.draft}
        onChangeDraft={thread.setDraft}
        canSubmit={canSubmit}
        onSubmit={thread.send}
        onStop={thread.stop}
        realtimeVoiceConversationId={thread.conversationId}
        realtimeVoiceExecution="phone"
        realtimeVoiceSignInRequired={guest}
        onRealtimeVoiceAction={performRealtimeVoiceAction}
        placeholder={t("mobile.chat.composerPlaceholder")}
        composerIntervention={
          guest ? undefined : (
            <CloudBrowserInterventionCard
              conversationId={thread.conversationId}
            />
          )
        }
        offline={offline}
        enableAttachments
        attachments={thread.attachments}
        onChangeAttachments={thread.setAttachments}
        quotes={thread.quotes}
        onAddQuote={thread.addQuote}
        onRemoveQuote={thread.removeQuote}
        maxAttachments={MAX_OFFLINE_CHAT_IMAGES}
        dictationAnonymous={guest}
        dictationHeaders={dictationHeaders}
        onOpenArtifact={setSelectedArtifact}
        conversationId={thread.conversationId}
        activityTasks={thread.conversationTasks}
        onRewindMessage={guest ? thread.rewindToMessage : undefined}
      />
      <ArtifactViewer
        visible={Boolean(selectedArtifact)}
        artifact={selectedArtifact}
        access={null}
        onClose={() => setSelectedArtifact(null)}
      />
    </View>
  );
}
