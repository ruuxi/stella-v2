import { useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { EngineAccountSection } from "../EngineAccountsSettings";
import { ProviderGlyph } from "./ProviderGlyph";
import { tapLight } from "../../lib/haptics";
import { REASONING_OPTIONS } from "../../lib/stella-model-catalog";
import {
  MODEL_ENGINE_OPTIONS,
  type ModelEngine,
  type ModelSettings,
} from "../../lib/use-cloud-model-settings";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { useColors } from "../../theme/theme-context";

/**
 * The chat's brain as one card per provider: Stella, Claude Code, ChatGPT.
 *
 * Picking a card picks the engine, and its ring is the only mark it needs.
 * The chosen card opens to its models, how hard it thinks, and the accounts
 * that pay for it, so an account sits under the provider it belongs to.
 *
 * Every choice in the sheet reads the same way when picked: filled with the
 * accent, its label inverted.
 *
 * Lists and the saved choice come from the server, so this never waits on a
 * paired computer; the computer mirrors the saved choice for its own turns.
 */
export function ProviderCards({ settings }: { settings: ModelSettings }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { refresh } = settings;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = settings.execution !== null;
  const current = settings.engine;

  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.sectionLabel}>Model</Text>
        {settings.saving || !ready ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : null}
      </View>

      {MODEL_ENGINE_OPTIONS.map((option) => {
        const engine = option.id;
        const selected = ready && engine === current;
        return (
          <View
            key={engine}
            style={[styles.card, selected && styles.cardSelected]}
          >
            <Pressable
              onPress={() => {
                if (selected) return;
                tapLight();
                settings.selectEngine(engine);
              }}
              disabled={!ready}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected, disabled: !ready }}
              style={({ pressed }) => [
                styles.cardHeader,
                pressed && !selected && styles.pressed,
              ]}
            >
              <ProviderGlyph engine={engine} />
              <Text style={styles.title} numberOfLines={1}>
                {option.label}
              </Text>
            </Pressable>

            {selected ? (
              <CardBody engine={engine} settings={settings} styles={styles} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function CardBody({
  engine,
  settings,
  styles,
}: {
  engine: ModelEngine;
  settings: ModelSettings;
  styles: ReturnType<typeof makeStyles>;
}) {
  const rows = settings.modelsFor(engine);
  const effort = settings.effort === "none" ? "default" : settings.effort;

  return (
    <View style={[styles.body, engine === "stella" && styles.bodyEnd]}>
      {rows.length === 0 ? (
        <Text style={styles.empty}>No models available.</Text>
      ) : (
        <View style={styles.models}>
          {rows.map((model) => (
            <Pressable
              key={model.id}
              onPress={() => {
                if (model.selected) return;
                tapLight();
                settings.selectEngineModel(engine, model.id);
              }}
              disabled={!model.available}
              accessibilityRole="radio"
              accessibilityLabel={
                model.description
                  ? `${model.label}, ${model.description}`
                  : model.label
              }
              accessibilityState={{
                checked: model.selected,
                disabled: !model.available,
              }}
              style={({ pressed }) => [
                styles.modelChip,
                model.selected && styles.chosen,
                !model.available && styles.unavailable,
                pressed && !model.selected && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.modelChipLabel,
                  model.selected && styles.chosenLabel,
                ]}
                numberOfLines={1}
              >
                {model.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {settings.supportsEffortSelection ? (
        <View style={styles.thinking}>
          <Text style={styles.thinkingLabel}>Thinking</Text>
          <View style={styles.efforts} accessibilityRole="radiogroup">
            {REASONING_OPTIONS.map((option) => {
              const chosen = option.id === effort;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => {
                    if (chosen) return;
                    tapLight();
                    settings.selectEffort(option.id);
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel={`Thinking ${option.label}`}
                  accessibilityState={{ checked: chosen }}
                  style={({ pressed }) => [
                    styles.effort,
                    chosen && styles.chosen,
                    pressed && !chosen && styles.pressed,
                  ]}
                >
                  <Text
                    style={[styles.effortLabel, chosen && styles.chosenLabel]}
                    numberOfLines={1}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {engine !== "stella" ? (
        <View style={styles.accounts}>
          <EngineAccountSection provider={engine} embedded />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 10,
      marginTop: 26,
      minHeight: 18,
    },
    sectionLabel: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      marginBottom: 10,
      overflow: "hidden",
    },
    cardSelected: {
      borderColor: colors.selectBorder,
      borderWidth: 1.5,
    },
    cardHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: 56,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    title: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 16,
      letterSpacing: -0.2,
    },
    pressed: {
      opacity: 0.6,
    },
    body: {
      paddingTop: 2,
    },
    bodyEnd: {
      paddingBottom: 16,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      paddingHorizontal: 16,
    },
    models: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      paddingHorizontal: 16,
    },
    modelChip: {
      backgroundColor: colors.surfaceInset,
      borderRadius: 999,
      justifyContent: "center",
      minHeight: 40,
      paddingHorizontal: 16,
    },
    modelChipLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    chosen: {
      backgroundColor: colors.accent,
    },
    chosenLabel: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
    },
    unavailable: {
      opacity: 0.4,
    },
    thinking: {
      gap: 8,
      marginTop: 18,
      paddingHorizontal: 16,
    },
    thinkingLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      marginLeft: 2,
    },
    efforts: {
      flexDirection: "row",
      gap: 6,
    },
    effort: {
      alignItems: "center",
      backgroundColor: colors.surfaceInset,
      borderRadius: 999,
      flex: 1,
      height: 40,
      justifyContent: "center",
    },
    effortLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    accounts: {
      marginTop: 18,
    },
  });
