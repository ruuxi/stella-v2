import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Icon } from "./Icon";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { notifyError } from "../lib/haptics";
import { userFacingError } from "../lib/user-facing-error";
import { type StoredPhoneAccess } from "../lib/phone-access";
import { type DesktopBridgeConnection } from "../lib/desktop-bridge-chat";
import {
  ENGINE_OPTIONS,
  REASONING_OPTIONS,
  STELLA_DEFAULT_MODEL,
  buildRuntimeAssignPatch,
  buildRuntimeSetEffortPatch,
  buildStellaAssignPatch,
  buildStellaClearPatch,
  buildStellaProviderGroups,
  buildStellaSetEffortPatch,
  fetchDirectProviderModels,
  getDesktopModelPrefs,
  listDesktopConnectedProviders,
  listDesktopRuntimeModels,
  openDesktopBridge,
  runtimeSelectedEffort,
  runtimeSelectedModelId,
  setDesktopModelPrefs,
  stellaSelectedEffort,
  stellaSelectedModelId,
  type AgentRuntimeEngine,
  type DesktopModelSnapshot,
  type ProviderModelGroup,
  type ReasoningEffort,
  type RuntimeEngine,
  type RuntimeModelOption,
  type StellaCatalog,
} from "../lib/desktop-model-prefs";

type Props = {
  visible: boolean;
  onClose: () => void;
  access: StoredPhoneAccess | null;
  catalog: StellaCatalog;
  /** Called whenever the desktop snapshot changes, so the quick menu label can stay in sync. */
  onApplied?: (snapshot: DesktopModelSnapshot) => void;
};

const isRuntimeEngine = (engine: AgentRuntimeEngine): engine is RuntimeEngine =>
  engine === "codex_cli" || engine === "claude_code_local";

/** Which provider tab a selected Stella-engine model belongs to. */
const providerKeyForModel = (modelId: string): string => {
  if (!modelId || modelId.startsWith("stella/")) return "stella";
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "stella";
};

/**
 * Advanced model picker for the Computer chat — mirrors the desktop
 * display-sidebar engine/model picker and writes the paired desktop's real
 * local model preferences over the bridge. Opens as an iOS page sheet like
 * the pairing sheet.
 */
export function ComputerSettingsSheet({
  visible,
  onClose,
  access,
  catalog,
  onApplied,
}: Props) {
  const colors = useColors();
  const styles = makeStyles(colors);

  const bridgeRef = useRef<DesktopBridgeConnection | null>(null);
  const [snapshot, setSnapshot] = useState<DesktopModelSnapshot | null>(null);
  const [engine, setEngine] = useState<AgentRuntimeEngine>("default");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeModels, setRuntimeModels] = useState<
    Partial<Record<RuntimeEngine, RuntimeModelOption[]>>
  >({});
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const [directModels, setDirectModels] = useState<
    Record<string, RuntimeModelOption[]>
  >({});
  // Active provider tab within the Stella engine (null = follow selection).
  const [activeProviderKey, setActiveProviderKey] = useState<string | null>(
    null,
  );

  const loadRuntimeModels = useCallback(
    async (target: RuntimeEngine) => {
      const bridge = bridgeRef.current;
      if (!bridge || runtimeModels[target]) return;
      setRuntimeLoading(true);
      try {
        const models = await listDesktopRuntimeModels(bridge, target);
        setRuntimeModels((prev) => ({ ...prev, [target]: models }));
      } catch (e) {
        setError(userFacingError(e));
      } finally {
        setRuntimeLoading(false);
      }
    },
    [runtimeModels],
  );

  // Resolve the bridge and load the live desktop snapshot when the sheet opens.
  useEffect(() => {
    if (!visible) {
      bridgeRef.current = null;
      setSnapshot(null);
      setRuntimeModels({});
      setConnectedProviders([]);
      setActiveProviderKey(null);
      setError(null);
      return;
    }
    if (!access) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // models.dev catalog (BYOK model lists) is plain HTTP — load independently.
    void fetchDirectProviderModels().then((models) => {
      if (!cancelled) setDirectModels(models);
    });
    void (async () => {
      try {
        const bridge = await openDesktopBridge(access);
        if (cancelled) return;
        bridgeRef.current = bridge;
        const next = await getDesktopModelPrefs(bridge);
        if (cancelled) return;
        setSnapshot(next);
        setEngine(next.agentRuntimeEngine);
        onApplied?.(next);
        if (isRuntimeEngine(next.agentRuntimeEngine)) {
          void loadRuntimeModels(next.agentRuntimeEngine);
        }
        void listDesktopConnectedProviders(bridge).then((providers) => {
          if (!cancelled) setConnectedProviders(providers);
        });
      } catch (e) {
        if (!cancelled) setError(userFacingError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-run only when the sheet opens / the device changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, access]);

  const apply = useCallback(
    async (patch: Parameters<typeof setDesktopModelPrefs>[1]) => {
      const bridge = bridgeRef.current;
      if (!bridge) return;
      setSaving(true);
      setError(null);
      try {
        const next = await setDesktopModelPrefs(bridge, patch);
        setSnapshot(next);
        setEngine(next.agentRuntimeEngine);
        onApplied?.(next);
      } catch (e) {
        notifyError();
        setError(userFacingError(e));
      } finally {
        setSaving(false);
      }
    },
    [onApplied],
  );

  const onSelectEngine = useCallback(
    (next: AgentRuntimeEngine) => {
      if (next === engine || saving) return;
      setEngine(next);
      if (isRuntimeEngine(next)) void loadRuntimeModels(next);
      void apply({ agentRuntimeEngine: next });
    },
    [apply, engine, loadRuntimeModels, saving],
  );

  const onSelectModel = useCallback(
    (modelId: string) => {
      if (!snapshot || saving) return;
      if (isRuntimeEngine(engine)) {
        void apply(
          buildRuntimeAssignPatch(
            snapshot,
            engine,
            catalog.agentKeys,
            modelId,
            runtimeSelectedEffort(snapshot, engine),
          ),
        );
        return;
      }
      if (modelId === STELLA_DEFAULT_MODEL) {
        void apply(buildStellaClearPatch(snapshot, catalog.agentKeys));
        return;
      }
      void apply(
        buildStellaAssignPatch(
          snapshot,
          catalog.agentKeys,
          modelId,
          stellaSelectedEffort(snapshot),
        ),
      );
    },
    [apply, catalog.agentKeys, engine, saving, snapshot],
  );

  const onSelectEffort = useCallback(
    (effort: ReasoningEffort) => {
      if (!snapshot || saving) return;
      if (isRuntimeEngine(engine)) {
        void apply(buildRuntimeSetEffortPatch(engine, effort));
        return;
      }
      void apply(buildStellaSetEffortPatch(snapshot, catalog.agentKeys, effort));
    },
    [apply, catalog.agentKeys, engine, saving, snapshot],
  );

  const runtime = isRuntimeEngine(engine) ? engine : null;
  const selectedModelId = snapshot
    ? runtime
      ? runtimeSelectedModelId(snapshot, runtime)
      : stellaSelectedModelId(snapshot)
    : "";
  const selectedEffort: ReasoningEffort = snapshot
    ? runtime
      ? runtimeSelectedEffort(snapshot, runtime)
      : stellaSelectedEffort(snapshot)
    : "default";

  const runtimeRows: RuntimeModelOption[] = runtime
    ? (runtimeModels[runtime] ?? [])
    : [];
  // Stella engine groups models by provider: Stella always, then each
  // connected BYOK provider (Anthropic, OpenRouter, …) with its models.
  const stellaGroups: ProviderModelGroup[] = runtime
    ? []
    : buildStellaProviderGroups(catalog, connectedProviders, directModels);

  // Default the provider tab to whichever provider owns the selected model;
  // a user tap (activeProviderKey) overrides until it's no longer valid.
  const selectedProviderKey = providerKeyForModel(selectedModelId);
  const activeProvider =
    activeProviderKey &&
    stellaGroups.some((group) => group.key === activeProviderKey)
      ? activeProviderKey
      : selectedProviderKey;
  const activeGroup =
    stellaGroups.find((group) => group.key === activeProvider) ??
    stellaGroups[0] ??
    null;

  const isRowSelected = (rowId: string) => {
    if (rowId === selectedModelId) return true;
    // No Stella override means the desktop is on its default model.
    if (!runtime && selectedModelId === "" && rowId === STELLA_DEFAULT_MODEL) {
      return true;
    }
    return false;
  };

  const showModelLoading = loading || (Boolean(runtime) && runtimeLoading);

  const renderModelRow = (model: RuntimeModelOption) => {
    const selected = isRowSelected(model.id);
    const disabled = !model.allowedForAudience || loading || saving;
    return (
      <Pressable
        key={model.id}
        onPress={() => {
          if (model.allowedForAudience) onSelectModel(model.id);
        }}
        disabled={disabled}
        accessibilityLabel={`Use ${model.name}`}
        style={({ pressed }) => [
          styles.modelRow,
          selected && styles.modelRowSelected,
          pressed && styles.modelRowPressed,
          !model.allowedForAudience && styles.modelRowDisabled,
        ]}
      >
        <View style={styles.modelText}>
          <Text style={styles.modelName} numberOfLines={1}>
            {model.name}
          </Text>
          {model.subtitle ? (
            <Text style={styles.modelSub} numberOfLines={1}>
              {model.subtitle}
            </Text>
          ) : null}
        </View>
        {selected ? (
          <Icon name="check" size={16} color={colors.accent} />
        ) : null}
      </Pressable>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.sheetSafe}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Models</Text>
          {saving ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : null}
          <Pressable
            onPress={onClose}
            accessibilityLabel="Close models sheet"
            style={styles.sheetClose}
          >
            <Text style={styles.sheetCloseText}>Done</Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={styles.sheetContent}
          keyboardShouldPersistTaps="handled"
        >
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Text style={styles.sectionLabel}>Engine</Text>
          <View style={styles.segmentRow}>
            {ENGINE_OPTIONS.map((option) => {
              const active = option.id === engine;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => onSelectEngine(option.id)}
                  disabled={loading || saving}
                  accessibilityLabel={`Use ${option.label} engine`}
                  style={({ pressed }) => [
                    styles.segment,
                    active && styles.segmentActive,
                    pressed && styles.segmentPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && styles.segmentTextActive,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Thinking</Text>
          <View style={styles.segmentRow}>
            {REASONING_OPTIONS.map((option) => {
              const active = option.id === selectedEffort;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => onSelectEffort(option.id)}
                  disabled={loading || saving || !snapshot}
                  accessibilityLabel={`Thinking ${option.label}`}
                  style={({ pressed }) => [
                    styles.effortSegment,
                    active && styles.segmentActive,
                    pressed && styles.segmentPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && styles.segmentTextActive,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {showModelLoading ? (
            <>
              <Text style={styles.sectionLabel}>Model</Text>
              <View style={styles.modelLoading}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            </>
          ) : runtime ? (
            <>
              <Text style={styles.sectionLabel}>Model</Text>
              {runtimeRows.length === 0 ? (
                <Text style={styles.emptyText}>
                  No models available. Make sure this engine is installed on
                  your computer.
                </Text>
              ) : (
                <View style={styles.modelList}>
                  {runtimeRows.map(renderModelRow)}
                </View>
              )}
            </>
          ) : (
            <>
              {stellaGroups.length > 1 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.providerTabs}
                >
                  {stellaGroups.map((group) => {
                    const active = group.key === activeProvider;
                    return (
                      <Pressable
                        key={group.key}
                        onPress={() => setActiveProviderKey(group.key)}
                        accessibilityLabel={`${group.name} models`}
                        style={({ pressed }) => [
                          styles.providerTab,
                          active && styles.segmentActive,
                          pressed && styles.segmentPressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.segmentText,
                            active && styles.segmentTextActive,
                          ]}
                        >
                          {group.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : (
                <Text style={styles.sectionLabel}>Model</Text>
              )}
              {activeGroup && activeGroup.models.length > 0 ? (
                <View style={styles.modelList}>
                  {activeGroup.models.map(renderModelRow)}
                </View>
              ) : (
                <Text style={styles.emptyText}>No models available.</Text>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sheetSafe: {
      backgroundColor: colors.background,
      // Soft hairline on the leading (top) edge so the sheet reads against
      // the page beneath, matching the TopSheet primitive's edge treatment.
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flex: 1,
    },
    sheetHandle: {
      alignSelf: "center",
      backgroundColor: colors.border,
      borderRadius: 3,
      height: 5,
      marginTop: 8,
      width: 40,
    },
    sheetHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 12,
    },
    sheetTitle: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.semiBold,
      fontSize: 18,
      letterSpacing: -0.4,
    },
    sheetClose: {
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    sheetCloseText: {
      color: colors.accent,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    sheetContent: {
      gap: 10,
      paddingBottom: 36,
      paddingHorizontal: 24,
      paddingTop: 16,
    },
    errorText: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: 0.4,
      marginTop: 10,
      textTransform: "uppercase",
    },
    segmentRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    segment: {
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 16,
    },
    effortSegment: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 38,
      minWidth: 52,
      paddingHorizontal: 12,
    },
    segmentActive: {
      backgroundColor: colors.panel,
      borderColor: colors.accent,
    },
    segmentPressed: {
      opacity: 0.7,
    },
    segmentText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    segmentTextActive: {
      color: colors.text,
    },
    providerTabs: {
      flexDirection: "row",
      gap: 8,
      paddingVertical: 2,
    },
    providerTab: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 36,
      paddingHorizontal: 14,
    },
    modelLoading: {
      alignItems: "center",
      paddingVertical: 24,
    },
    emptyText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      paddingVertical: 8,
    },
    modelList: {
      gap: 6,
    },
    modelRow: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      minHeight: 50,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    modelRowSelected: {
      borderColor: colors.accent,
    },
    modelRowPressed: {
      opacity: 0.7,
    },
    modelRowDisabled: {
      opacity: 0.4,
    },
    modelText: {
      flex: 1,
      gap: 2,
      minWidth: 0,
    },
    modelName: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    modelSub: {
      color: fadeHex(colors.textMuted, 0.85),
      fontFamily: fonts.sans.regular,
      fontSize: 12,
    },
  });
