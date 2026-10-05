import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  EngineAccountSection,
  openChatGptUsage,
} from "./EngineAccountsSettings";
import { Icon } from "./Icon";
import { GlassToggle } from "./glass";
import { SegmentedControl } from "./SegmentedControl";
import type { SettingsStyles } from "./settings/settings-styles";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import {
  REASONING_OPTIONS,
  type ReasoningEffort,
} from "../lib/stella-model-catalog";
import {
  MODEL_ENGINE_OPTIONS,
  type ModelEngine,
  type ModelSettings,
} from "../lib/use-cloud-model-settings";

/** Rows shown before "show more". Six at once was too many to scan. */
const COLLAPSED_MODEL_COUNT = 3;

type Props = {
  settings: ModelSettings;
  composerModelPinned: boolean;
  onComposerModelPinnedChange: (next: boolean) => void;
  styles: SettingsStyles;
};

/**
 * The chat settings sheet's Model section: one header over the engine switch,
 * the engine's models as a grouped list, and the composer shortcut. Lists and
 * the saved choice come from the server, so it never waits on a paired
 * computer; the computer mirrors the saved choice for its own turns.
 */
export function ModelSettingsPanel({
  settings,
  composerModelPinned,
  onComposerModelPinnedChange,
  styles,
}: Props) {
  const colors = useColors();
  const local = useMemo(() => makeStyles(colors), [colors]);
  const { refresh } = settings;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = settings.execution !== null;
  const engine = settings.engine;
  const rows = settings.modelsFor(engine);

  const [modelsExpanded, setModelsExpanded] = useState(false);

  // A different engine is a different list; start it collapsed again.
  useEffect(() => {
    setModelsExpanded(false);
  }, [engine]);

  const visibleRows = useMemo(() => {
    if (modelsExpanded || rows.length <= COLLAPSED_MODEL_COUNT) return rows;
    const head = rows.slice(0, COLLAPSED_MODEL_COUNT);
    // Never fold away the model actually in effect: hiding the checked row
    // behind "show more" hides the current setting, which is the one thing
    // this list exists to report.
    if (!head.some((model) => model.selected)) {
      const selected = rows.find((model) => model.selected);
      if (selected) head.push(selected);
    }
    return head;
  }, [rows, modelsExpanded]);

  const hiddenCount = rows.length - visibleRows.length;
  const cloudDisconnected =
    engine !== "stella" &&
    settings.connectedProviders !== undefined &&
    !settings.connectedProviders.includes(engine);

  return (
    <View style={styles.section}>
      <View style={local.header}>
        <Text style={[styles.sectionLabel, local.headerLabel]}>Model</Text>
        {settings.saving ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : null}
      </View>

      <SegmentedControl<ModelEngine>
        accessibilityLabel="Engine"
        disabled={!ready}
        value={engine}
        onChange={settings.selectEngine}
        options={MODEL_ENGINE_OPTIONS.map((option) => ({
          value: option.id,
          label: option.label,
        }))}
      />

      {settings.supportsEffortSelection ? (
        <View style={local.effort}>
          <Text style={local.effortLabel}>Thinking</Text>
          <SegmentedControl<ReasoningEffort>
            accessibilityLabel="Thinking"
            disabled={!ready}
            value={settings.effort === "none" ? "default" : settings.effort}
            onChange={settings.selectEffort}
            options={REASONING_OPTIONS.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
          />
        </View>
      ) : null}

      <View style={[styles.group, styles.groupGap]}>
        {!ready ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" color={colors.textMuted} />
          </View>
        ) : rows.length === 0 ? (
          <Text style={styles.hint}>No models available.</Text>
        ) : (
          visibleRows.map((model, index) => (
            <Pressable
              key={model.id}
              onPress={() => settings.selectEngineModel(engine, model.id)}
              disabled={!model.available}
              accessibilityRole="button"
              accessibilityLabel={`Use ${model.label}`}
              accessibilityState={{
                selected: model.selected,
                disabled: !model.available,
              }}
              style={({ pressed }) => [
                styles.row,
                local.modelRow,
                index > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
                !model.available && styles.rowDisabled,
              ]}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {model.label}
                </Text>
                {model.description ? (
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {model.description}
                  </Text>
                ) : null}
              </View>
              {model.selected ? (
                <Icon name="check" size={17} color={colors.accent} />
              ) : null}
            </Pressable>
          ))
        )}
        {ready && (hiddenCount > 0 || modelsExpanded) ? (
          <Pressable
            onPress={() => setModelsExpanded((value) => !value)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.row,
              styles.rowDivider,
              pressed && styles.rowPressed,
            ]}
          >
            <Text style={local.moreLabel}>
              {modelsExpanded ? "Show fewer" : `Show ${hiddenCount} more`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {ready && engine === "chatgpt" && !cloudDisconnected ? (
        <Text style={local.note}>
          ChatGPT usage counts against your ChatGPT plan.{" "}
          <Text
            style={local.noteLink}
            onPress={openChatGptUsage}
            accessibilityRole="link"
          >
            Manage usage
          </Text>
        </Text>
      ) : null}

      {/* The engine control above already says which provider this is, so its
          accounts belong here rather than in a second list further down. A
          "Claude" header over an "Add account" row is the whole explanation. */}
      <EngineAccountSection provider={engine} />

      <View style={[styles.group, styles.groupGap]}>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, local.flex]}>Show in composer</Text>
          <GlassToggle
            value={composerModelPinned}
            onValueChange={onComposerModelPinnedChange}
            accessibilityLabel="Show model picker in composer"
          />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    headerLabel: { flex: 1 },
    effort: { gap: 6, marginTop: 12 },
    effortLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      marginLeft: 4,
    },
    modelRow: { minHeight: 48, paddingVertical: 10 },
    note: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
      marginHorizontal: 4,
      marginTop: 8,
    },
    noteLink: { color: colors.accent, fontFamily: fonts.sans.medium },
    moreLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    flex: { flex: 1 },
  });
