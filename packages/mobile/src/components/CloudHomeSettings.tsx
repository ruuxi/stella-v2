import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { GlassToggle } from "./glass";
import { PrimaryButton } from "./PrimaryButton";
import {
  MobileCloudHomeError,
  summarizeCloudMemory,
  type MobileCloudMemoryAuthority,
  type MobileCloudMemoryDocument,
  type MobileCloudMemorySummary,
} from "../lib/cloud-home";
import type { CloudConversationIdentity } from "../lib/cloud-conversation-auth";
import { useMobileCloudHome } from "../lib/use-cloud-home";
import { useCloudMemoryPreference } from "../lib/use-cloud-memory-preference";
import { type Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";
import { useT } from "../i18n";

type CloudHomeSettingsProps = {
  identity: CloudConversationIdentity | null;
  onBack: () => void;
  onSignIn: () => void;
};

type VisibleProblem = {
  code: MobileCloudHomeError["code"] | "missing";
  message: string;
};

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

const visibleProblem = (error: unknown, t: Translate): VisibleProblem => {
  if (error instanceof MobileCloudHomeError) {
    return {
      code: error.code,
      message: t(`mobile.cloudHome.errors.${error.code}`),
    };
  }
  return {
    code: "network",
    message: t("mobile.cloudHome.errors.network"),
  };
};

const summaryForDocument = (
  document: MobileCloudMemoryDocument,
): MobileCloudMemorySummary => ({
  name: document.name,
  displayPath: document.displayPath,
  kind: document.kind,
  revision: document.revision,
  sizeBytes: document.sizeBytes,
  updatedAt: document.updatedAt,
});

const formatBytes = (sizeBytes: number, t: Translate): string =>
  sizeBytes < 1024
    ? t("mobile.cloudHome.sizes.bytes", { count: sizeBytes })
    : sizeBytes < 1024 * 1024
      ? t("mobile.cloudHome.sizes.kilobytes", {
          count: Math.ceil(sizeBytes / 1024),
        })
      : t("mobile.cloudHome.sizes.megabytes", {
          count: (sizeBytes / (1024 * 1024)).toFixed(1),
        });

const formatKind = (
  kind: MobileCloudMemorySummary["kind"],
  t: Translate,
): string => t(`mobile.cloudHome.kinds.${kind}`);

export function CloudHomeSettings({
  identity,
  onBack,
  onSignIn,
}: CloudHomeSettingsProps) {
  const identityFence = identity
    ? JSON.stringify([
        identity.accountScope,
        identity.identityKey,
        identity.revision,
        identity.expectedSubject,
      ])
    : null;
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const {
    available: cloudHomeAvailable,
    loading: cloudHomeLoading,
    unavailable: cloudHomeUnavailable,
    listMemory,
    readMemory,
    writeMemory,
  } = useMobileCloudHome(identity);
  const memoryPreference = useCloudMemoryPreference(identity);
  const identityRef = useRef(identityFence);
  useLayoutEffect(() => {
    identityRef.current = identityFence;
    return () => {
      if (identityRef.current === identityFence) identityRef.current = null;
    };
  }, [identityFence]);
  const requestEpoch = useRef(0);
  const [summaries, setSummaries] = useState<MobileCloudMemorySummary[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [openingName, setOpeningName] = useState<string | null>(null);
  const [selected, setSelected] = useState<MobileCloudMemoryDocument | null>(
    null,
  );
  const [selectedAuthority, setSelectedAuthority] =
    useState<MobileCloudMemoryAuthority | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<VisibleProblem | null>(null);
  const [conflict, setConflict] = useState<
    MobileCloudMemoryDocument | null | undefined
  >(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshSummaries = useCallback(async () => {
    if (!identityFence || !cloudHomeAvailable) return;
    const identityAtStart = identityFence;
    const epoch = ++requestEpoch.current;
    setLoadingDocuments(true);
    setProblem(null);
    try {
      const snapshot = await listMemory();
      if (
        requestEpoch.current !== epoch ||
        identityRef.current !== identityAtStart
      ) {
        return;
      }
      setSummaries(summarizeCloudMemory(snapshot));
    } catch (error) {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setProblem(visibleProblem(error, t));
      }
    } finally {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setLoadingDocuments(false);
      }
    }
  }, [cloudHomeAvailable, identityFence, listMemory, t]);

  useEffect(() => {
    requestEpoch.current += 1;
    setSummaries([]);
    setSelected(null);
    setSelectedAuthority(null);
    setDraft("");
    setConflict(undefined);
    setProblem(null);
    setNotice(null);
    if (identityFence && cloudHomeAvailable) void refreshSummaries();
    return () => {
      requestEpoch.current += 1;
    };
  }, [cloudHomeAvailable, identityFence, refreshSummaries]);

  const openDocument = async (summary: MobileCloudMemorySummary) => {
    if (!identityFence) return;
    const identityAtStart = identityFence;
    const epoch = ++requestEpoch.current;
    setOpeningName(summary.name);
    setProblem(null);
    setNotice(null);
    setConflict(undefined);
    try {
      const read = await readMemory(summary.name);
      if (
        requestEpoch.current !== epoch ||
        identityRef.current !== identityAtStart
      ) {
        return;
      }
      if (!read.document) {
        setProblem({
          code: "missing",
          message: t("mobile.cloudHome.errors.missingFromList"),
        });
        void refreshSummaries();
        return;
      }
      setSelected(read.document);
      setSelectedAuthority(read.authority);
      setDraft(read.document.content);
    } catch (error) {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setProblem(visibleProblem(error, t));
      }
    } finally {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setOpeningName(null);
      }
    }
  };

  const saveDocument = async () => {
    if (
      !selected ||
      !selectedAuthority ||
      !identityFence ||
      draft === selected.content
    ) {
      return;
    }
    const base = selected;
    const identityAtStart = identityFence;
    const epoch = ++requestEpoch.current;
    setSaving(true);
    setProblem(null);
    setNotice(null);
    setConflict(undefined);
    try {
      const result = await writeMemory({
        authority: selectedAuthority,
        name: base.name,
        kind: base.kind,
        content: draft,
        expectedRevision: base.revision,
        source: "mobile_user",
        writer: "user_edit",
      });
      if (
        requestEpoch.current !== epoch ||
        identityRef.current !== identityAtStart
      ) {
        return;
      }
      if (result.status === "committed") {
        setSelected(result.document);
        setDraft(result.document.content);
        setSummaries((current) =>
          current.map((summary) =>
            summary.name === result.document.name
              ? summaryForDocument(result.document)
              : summary,
          ),
        );
        setNotice(t("mobile.cloudHome.notices.saved"));
        return;
      }
      setConflict(result.document);
    } catch (error) {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setProblem(visibleProblem(error, t));
      }
    } finally {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setSaving(false);
      }
    }
  };

  const reloadCloudVersion = async () => {
    if (!selected || !identityFence) return;
    const identityAtStart = identityFence;
    const epoch = ++requestEpoch.current;
    setOpeningName(selected.name);
    setProblem(null);
    setNotice(null);
    try {
      const read = await readMemory(selected.name);
      if (
        requestEpoch.current !== epoch ||
        identityRef.current !== identityAtStart
      ) {
        return;
      }
      if (!read.document) {
        setSelected(null);
        setSelectedAuthority(null);
        setDraft("");
        setConflict(undefined);
        setProblem({
          code: "missing",
          message: t("mobile.cloudHome.errors.removedWhileEditing"),
        });
        void refreshSummaries();
        return;
      }
      const latest = read.document;
      setSelected(latest);
      setSelectedAuthority(read.authority);
      setDraft(latest.content);
      setConflict(undefined);
      setSummaries((current) =>
        current.map((summary) =>
          summary.name === latest.name ? summaryForDocument(latest) : summary,
        ),
      );
      setNotice(t("mobile.cloudHome.notices.loadedLatest"));
    } catch (error) {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setProblem(visibleProblem(error, t));
      }
    } finally {
      if (
        requestEpoch.current === epoch &&
        identityRef.current === identityAtStart
      ) {
        setOpeningName(null);
      }
    }
  };

  const closeEditor = () => {
    requestEpoch.current += 1;
    setSelected(null);
    setSelectedAuthority(null);
    setDraft("");
    setConflict(undefined);
    setProblem(null);
    setNotice(null);
    setOpeningName(null);
    setSaving(false);
  };

  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={selected ? closeEditor : onBack}
        hitSlop={10}
        accessibilityLabel={
          selected
            ? t("mobile.cloudHome.backToDocumentsLabel")
            : t("mobile.cloudHome.backToSettingsLabel")
        }
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <Icon name="chevron-left" size={22} color={colors.text} />
      </Pressable>
      <View style={styles.headerCopy}>
        <Text style={styles.title} numberOfLines={1}>
          {selected ? selected.name : t("mobile.cloudHome.title")}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {selected
            ? t("mobile.cloudHome.editorMeta", {
                kind: formatKind(selected.kind, t),
                revision: selected.revision,
              })
            : t("mobile.cloudHome.subtitle")}
        </Text>
      </View>
    </View>
  );

  if (!identityFence) {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        {header}
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>
            {t("mobile.cloudHome.signInTitle")}
          </Text>
          <Text style={styles.stateBody}>
            {t("mobile.cloudHome.signInBody")}
          </Text>
          <PrimaryButton
            label={t("mobile.cloudHome.signIn")}
            onPress={onSignIn}
            style={styles.stateButton}
          />
        </View>
      </ScrollView>
    );
  }

  if (selected) {
    const dirty = draft !== selected.content;
    const conflictVisible = conflict !== undefined;
    return (
      <ScrollView
        style={styles.screen}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        {header}
        <Text style={styles.path}>{selected.displayPath}</Text>
        {conflictVisible ? (
          <View style={[styles.messageCard, styles.conflictCard]}>
            <Text style={styles.conflictTitle}>
              {t("mobile.cloudHome.conflict.title")}
            </Text>
            <Text style={styles.messageText}>
              {conflict
                ? t("mobile.cloudHome.conflict.changedBody", {
                    revision: conflict.revision,
                  })
                : t("mobile.cloudHome.conflict.removedBody")}
            </Text>
            <Pressable
              onPress={() => void reloadCloudVersion()}
              disabled={openingName === selected.name}
              accessibilityLabel={t("mobile.cloudHome.conflict.reloadLabel")}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {openingName === selected.name
                  ? t("mobile.cloudHome.conflict.reloading")
                  : t("mobile.cloudHome.conflict.reload")}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {problem ? (
          <View style={styles.messageCard}>
            <Text style={styles.errorText}>{problem.message}</Text>
            {problem.code === "unauthorized" ? (
              <PrimaryButton
                label={t("mobile.cloudHome.signInAgain")}
                onPress={onSignIn}
                style={styles.stateButton}
              />
            ) : null}
          </View>
        ) : null}
        {notice ? (
          <View style={styles.messageCard}>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}
        <TextInput
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            setNotice(null);
          }}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textAlignVertical="top"
          selectionColor={colors.accent}
          accessibilityLabel={t("mobile.cloudHome.editor.editLabel", {
            name: selected.name,
          })}
          style={styles.editor}
        />
        <View style={styles.editorActions}>
          <PrimaryButton
            label={
              saving
                ? t("mobile.cloudHome.editor.saving")
                : t("mobile.cloudHome.editor.save")
            }
            onPress={() => void saveDocument()}
            disabled={
              !dirty || !selectedAuthority || saving || openingName !== null
            }
          />
          <Text style={styles.draftStatus}>
            {dirty
              ? t("mobile.cloudHome.editor.unsaved")
              : t("mobile.cloudHome.editor.upToDate")}
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: 32 + insets.bottom },
      ]}
    >
      {header}
      <View style={styles.memoryPreferenceCard}>
        <View style={styles.memoryPreferenceCopy}>
          <Text style={styles.memoryPreferenceTitle}>
            {t("settings.memory.title")}
          </Text>
          <Text style={styles.memoryPreferenceBody}>
            {t("settings.memory.description")}
          </Text>
        </View>
        <View style={styles.memoryPreferenceControl}>
          {memoryPreference.status === "loading" ||
          memoryPreference.status === "saving" ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : null}
          <GlassToggle
            value={memoryPreference.memoryEnabled}
            disabled={memoryPreference.disabled}
            onValueChange={memoryPreference.setMemoryEnabled}
            accessibilityLabel={t("settings.memory.title")}
          />
        </View>
      </View>
      {memoryPreference.issue ? (
        <View style={styles.messageCard}>
          <Text style={styles.errorText}>
            {t(
              memoryPreference.issue === "load"
                ? "settings.errors.loadMemory"
                : "settings.errors.saveMemory",
            )}
          </Text>
          <Pressable
            onPress={memoryPreference.retry}
            accessibilityLabel={t("common.tryAgain")}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>
              {t("common.tryAgain")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {cloudHomeLoading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.stateBody}>{t("mobile.cloudHome.loading")}</Text>
        </View>
      ) : cloudHomeUnavailable ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>
            {t("mobile.cloudHome.unavailableTitle")}
          </Text>
          <Text style={styles.stateBody}>
            {t("mobile.cloudHome.unavailableBody")}
          </Text>
        </View>
      ) : problem ? (
        <View style={styles.messageCard}>
          <Text style={styles.errorText}>{problem.message}</Text>
          {problem.code === "unauthorized" ? (
            <PrimaryButton
              label={t("mobile.cloudHome.signInAgain")}
              onPress={onSignIn}
              style={styles.stateButton}
            />
          ) : (
            <Pressable
              onPress={() => void refreshSummaries()}
              accessibilityLabel={t("mobile.cloudHome.list.retryLabel")}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {t("mobile.cloudHome.list.retry")}
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {loadingDocuments ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.stateBody}>
            {t("mobile.cloudHome.list.loading")}
          </Text>
        </View>
      ) : summaries.length === 0 && !problem ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>
            {t("mobile.cloudHome.list.emptyTitle")}
          </Text>
          <Text style={styles.stateBody}>
            {t("mobile.cloudHome.list.emptyBody")}
          </Text>
        </View>
      ) : (
        <View style={styles.documentList}>
          {summaries.map((summary) => (
            <Pressable
              key={summary.name}
              onPress={() => void openDocument(summary)}
              disabled={openingName !== null}
              accessibilityLabel={t("mobile.cloudHome.list.openDocumentLabel", {
                name: summary.name,
              })}
              style={({ pressed }) => [
                styles.documentRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.documentCopy}>
                <Text style={styles.documentName} numberOfLines={1}>
                  {summary.name}
                </Text>
                <Text style={styles.documentPath} numberOfLines={1}>
                  {summary.displayPath}
                </Text>
                <Text style={styles.documentMeta}>
                  {t("mobile.cloudHome.listMeta", {
                    kind: formatKind(summary.kind, t),
                    revision: summary.revision,
                    size: formatBytes(summary.sizeBytes, t),
                  })}
                </Text>
              </View>
              {openingName === summary.name ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Icon name="chevron-right" size={18} color={colors.textMuted} />
              )}
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },
    centered: {
      alignItems: "center",
      gap: 10,
      justifyContent: "center",
      paddingHorizontal: 28,
    },
    content: { paddingBottom: 32, paddingTop: 8 },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      marginBottom: 20,
    },
    backButton: {
      alignItems: "center",
      height: 40,
      justifyContent: "center",
      marginLeft: -8,
      width: 40,
    },
    headerCopy: { flex: 1 },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 26,
      letterSpacing: -1,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      marginTop: 1,
    },
    stateCard: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 18,
    },
    stateTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    stateBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
    },
    stateButton: { alignSelf: "flex-start", marginTop: 16 },
    memoryPreferenceCard: {
      alignItems: "center",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 14,
      marginBottom: 12,
      padding: 16,
    },
    memoryPreferenceCopy: { flex: 1 },
    memoryPreferenceTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    memoryPreferenceBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 4,
    },
    memoryPreferenceControl: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
    },
    loadingRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      paddingVertical: 24,
    },
    documentList: { gap: 8 },
    documentRow: {
      alignItems: "center",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    documentCopy: { flex: 1, gap: 2 },
    documentName: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    documentPath: {
      color: colors.textMuted,
      fontFamily: fonts.mono.regular,
      fontSize: 11,
    },
    documentMeta: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      marginTop: 3,
      textTransform: "capitalize",
    },
    pressed: { opacity: 0.68 },
    path: {
      color: colors.textMuted,
      fontFamily: fonts.mono.regular,
      fontSize: 11,
      marginBottom: 10,
    },
    editor: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      fontFamily: fonts.mono.regular,
      fontSize: 13,
      lineHeight: 20,
      minHeight: 340,
      padding: 14,
    },
    editorActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      marginTop: 14,
    },
    draftStatus: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
    },
    messageCard: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 9,
      marginBottom: 12,
      padding: 12,
    },
    conflictCard: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.warning,
    },
    conflictTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
    },
    messageText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    errorText: {
      color: colors.danger,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      lineHeight: 18,
    },
    noticeText: {
      color: colors.ok,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
    },
    secondaryButton: {
      alignSelf: "flex-start",
      borderColor: colors.borderStrong,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    secondaryButtonText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
    },
  } as const);
