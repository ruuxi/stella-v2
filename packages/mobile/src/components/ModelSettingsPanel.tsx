import { useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
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

type Props = {
  settings: ModelSettings;
  composerModelPinned: boolean;
  onComposerModelPinnedChange: (next: boolean) => void;
  styles: SettingsStyles;
  /** Opens the accounts page where the cloud engine can be connected. */
  onManageAccounts?: () => void;
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
  onManageAccounts,
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
          rows.map((model, index) => (
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
      </View>

      {ready && cloudDisconnected ? (
        <Text style={local.note}>
          Your computer uses the{" "}
          {engine === "anthropic" ? "Claude" : "ChatGPT"} accounts set up on
          it. To run this engine in the cloud, connect a{" "}
          {engine === "anthropic" ? "Claude" : "ChatGPT"} account.
          {onManageAccounts ? (
            <>
              {" "}
              <Text
                style={local.noteLink}
                onPress={onManageAccounts}
                accessibilityRole="link"
              >
                Connect account
              </Text>
            </>
          ) : null}
        </Text>
      ) : null}

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
    flex: { flex: 1 },
  });
