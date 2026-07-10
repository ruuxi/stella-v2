import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { isGuest } from "../../src/lib/guest-mode";
import { getOrCreateMobileDeviceId } from "../../src/lib/phone-access";
import {
  consumePendingShare,
  subscribePendingShare,
} from "../../src/lib/pending-share";
import { useChatThread } from "../../src/lib/use-chat-thread";
import { MAX_OFFLINE_CHAT_IMAGES } from "../../src/lib/offline-chat-request";
import { useIsOffline } from "../../src/lib/use-network-status";
import { useTopBarStatus } from "../../src/lib/top-bar-status";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import { ChatPane } from "../../src/components/ChatPane";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import type { ChatArtifact } from "../../src/types";

/**
 * The Chat tab: a cloud conversation with Stella that works anywhere, with no
 * dependency on the paired computer. Computer-routed chat lives on the Computer
 * tab; the two transcripts stay separate so neither's context bleeds into the
 * other.
 */
export default function ChatScreen() {
  const colors = useColors();
  const guest = isGuest();
  const offline = useIsOffline();
  const { setConnection: setTopBarConnection } = useTopBarStatus();
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  // A tapped file artifact (e.g. a PDF the `pdf` tool generated on-device),
  // previewed + saved/shared from the standalone artifact viewer. The cloud
  // chat is self-contained, so the viewer runs with no desktop bridge.
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );

  const transport = useMemo(
    () => ({ kind: "cloud" as const, guest }),
    [guest],
  );
  const thread = useChatThread({ threadId: "cloud", transport });
  const { setDraft, setAttachments } = thread;

  // Cloud chat needs no desktop-connection affordance — keep the top-bar badge
  // clear while this tab is mounted.
  useEffect(() => {
    setTopBarConnection(null);
    return () => setTopBarConnection(null);
  }, [setTopBarConnection]);

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
        setDraft((prev) =>
          prev.trim() ? `${prev.trimEnd()} ${share.text}` : share.text ?? "",
        );
      }
      if (share.assets?.length) {
        setAttachments((prev) => [...prev, ...share.assets!]);
      }
    };
    applyShare();
    return subscribePendingShare(applyShare);
  }, [setDraft, setAttachments]);

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
      }),
    [colors],
  );

  const canSubmit =
    (thread.draft.trim().length > 0 || thread.attachments.length > 0) &&
    !offline &&
    thread.storageLoaded;

  return (
    <View style={styles.root}>
      <ChatPane
        messages={thread.messages}
        streaming={thread.sending}
        workingIndicator={thread.workingIndicator}
        emptyContent={<Text style={styles.emptyText}>Ask Stella anything</Text>}
        historyLoading={!thread.storageLoaded}
        draft={thread.draft}
        onChangeDraft={thread.setDraft}
        canSubmit={canSubmit}
        onSubmit={thread.send}
        onStop={thread.stop}
        placeholder="Message Stella"
        offline={offline}
        enableAttachments
        attachments={thread.attachments}
        onChangeAttachments={thread.setAttachments}
        maxAttachments={MAX_OFFLINE_CHAT_IMAGES}
        dictationAnonymous={guest}
        dictationHeaders={dictationHeaders}
        onOpenArtifact={setSelectedArtifact}
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
