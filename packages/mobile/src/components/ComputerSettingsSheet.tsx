import { useEffect } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { GlassToggle } from "./glass";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { REASONING_OPTIONS } from "../lib/stella-model-catalog";
import {
  MODEL_ENGINE_OPTIONS,
  type ModelOption,
  type ModelSettings,
} from "../lib/use-cloud-model-settings";

type Props = {
  visible: boolean;
  onClose: () => void;
  settings: ModelSettings;
  composerModelPinned: boolean;
  onComposerModelPinnedChange: (next: boolean) => void;
};

/**
 * Engine and model picker. Lists and the saved choice come from the server,
 * so it never waits on a paired computer; the computer mirrors the saved
 * choice for its own turns.
 */
export function ComputerSettingsSheet({
  visible,
  onClose,
  settings,
  composerModelPinned,
  onComposerModelPinnedChange,
}: Props) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { refresh } = settings;

  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);

  const ready = settings.execution !== null;
  const engine = settings.engine;
  const rows = settings.modelsFor(engine);
  const cloudDisconnected =
    engine !== "stella" &&
    settings.connectedProviders !== undefined &&
    !settings.connectedProviders.includes(engine);

  const renderModelRow = (model: ModelOption) => (
    <Pressable
      key={model.id}
      onPress={() => settings.selectEngineModel(engine, model.id)}
      disabled={!ready || !model.available}
      accessibilityLabel={`Use ${model.label}`}
      accessibilityState={{ selected: model.selected }}
      style={({ pressed }) => [
        styles.modelRow,
        model.selected && styles.modelRowSelected,
        pressed && styles.modelRowPressed,
        !model.available && styles.modelRowDisabled,
      ]}
    >
      <View style={styles.modelText}>
        <Text style={styles.modelName} numberOfLines={1}>
          {model.label}
        </Text>
        {model.description ? (
          <Text style={styles.modelSub} numberOfLines={1}>
            {model.description}
          </Text>
        ) : null}
      </View>
      {model.selected ? (
        <Icon name="check" size={16} color={colors.accent} />
      ) : null}
    </Pressable>
  );

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
          {settings.saving ? (
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
        <View style={styles.pinRow}>
          <View style={styles.pinCopy}>
            <Text style={styles.pinLabel}>Show in composer</Text>
            <Text style={styles.pinDescription}>
              Keep a compact model picker beside the composer controls.
            </Text>
          </View>
          <GlassToggle
            value={composerModelPinned}
            onValueChange={onComposerModelPinnedChange}
            accessibilityLabel="Show model picker in composer"
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.sheetContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.sectionLabel}>Engine</Text>
          <View style={styles.segmentRow}>
            {MODEL_ENGINE_OPTIONS.map((option) => {
              const active = option.id === engine;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => settings.selectEngine(option.id)}
                  disabled={!ready}
                  accessibilityLabel={`Use ${option.label} engine`}
                  accessibilityState={{ selected: active }}
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

          {settings.supportsEffortSelection ? (
            <>
              <Text style={styles.sectionLabel}>Thinking</Text>
              <View style={styles.segmentRow}>
                {REASONING_OPTIONS.map((option) => {
                  const active = option.id === settings.effort;
                  return (
                    <Pressable
                      key={option.id}
                      onPress={() => settings.selectEffort(option.id)}
                      disabled={!ready}
                      accessibilityLabel={`Thinking ${option.label}`}
                      accessibilityState={{ selected: active }}
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
            </>
          ) : null}

          <Text style={styles.sectionLabel}>Model</Text>
          {!ready ? (
            <View style={styles.modelLoading}>
              <ActivityIndicator size="small" color={colors.textMuted} />
            </View>
          ) : rows.length === 0 ? (
            <Text style={styles.emptyText}>No models available.</Text>
          ) : (
            <View style={styles.modelList}>{rows.map(renderModelRow)}</View>
          )}
          {ready && cloudDisconnected ? (
            <Text style={styles.emptyText}>
              Your computer uses its own{" "}
              {engine === "anthropic" ? "Claude Code" : "Codex"} login. To run
              this engine in the cloud, connect{" "}
              {engine === "anthropic" ? "Claude" : "ChatGPT"} in Settings.
            </Text>
          ) : null}
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
    pinRow: {
      alignItems: "center",
      borderBottomColor: fadeHex(colors.border, 0.55),
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 16,
      marginHorizontal: 20,
      paddingBottom: 14,
      paddingTop: 14,
    },
    pinCopy: { flex: 1, gap: 3 },
    pinLabel: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    pinDescription: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    sheetContent: {
      gap: 10,
      paddingBottom: 36,
      paddingHorizontal: 24,
      paddingTop: 16,
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
