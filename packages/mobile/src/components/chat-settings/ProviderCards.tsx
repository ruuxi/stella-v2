import { useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  isEngineConnectionUsable,
  type EngineConnection,
} from "@stella/contracts/backend/engines";
import { EngineAccountSection } from "../EngineAccountsSettings";
import { Icon } from "../Icon";
import { SegmentedControl } from "../SegmentedControl";
import { ProviderGlyph } from "./ProviderGlyph";
import { useBackendView } from "../../lib/backend";
import { tapLight } from "../../lib/haptics";
import {
  REASONING_OPTIONS,
  type ReasoningEffort,
} from "../../lib/stella-model-catalog";
import {
  MODEL_ENGINE_OPTIONS,
  type ModelEngine,
  type ModelSettings,
} from "../../lib/use-cloud-model-settings";
import { useT } from "../../i18n";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { useColors } from "../../theme/theme-context";

const CONNECT_KEYS: Record<Exclude<ModelEngine, "stella">, string> = {
  anthropic: "mobile.engineAccounts.connectClaude",
  chatgpt: "mobile.engineAccounts.connectChatgpt",
};

const titleCase = (value: string) =>
  value ? value[0]!.toUpperCase() + value.slice(1) : value;

/**
 * The chat's brain as one card per provider: Stella, Claude Code, ChatGPT.
 *
 * Picking a card picks the engine. The chosen card opens to show its models,
 * how hard it thinks, and the accounts that pay for it, so an account sits
 * under the provider it belongs to rather than in a list of its own. Closed
 * cards still say which account they would use, or what's wrong with it, so
 * switching is never a surprise.
 *
 * Lists and the saved choice come from the server, so this never waits on a
 * paired computer; the computer mirrors the saved choice for its own turns.
 * A computer signs in to Claude Code and ChatGPT on its own, which the open
 * card says while one is picked.
 */
export function ProviderCards({
  settings,
  deviceLabel,
}: {
  settings: ModelSettings;
  /** The computer turns run on, or `null` in the cloud. */
  deviceLabel: string | null;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { refresh } = settings;
  const { value: engines } = useBackendView("engines.get", {});

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = settings.execution !== null;
  const current = settings.engine;

  const subtitleFor = (
    engine: ModelEngine,
  ): { text: string; warn: boolean } => {
    if (engine === "stella") {
      const selected = settings.modelsFor("stella").find((model) => model.selected);
      const fallback = settings.modelsFor("stella")[0];
      return { text: (selected ?? fallback)?.label ?? "Stella", warn: false };
    }
    const accounts = (engines?.connections ?? []).filter(
      (row: EngineConnection) => row.provider === engine,
    );
    const active = accounts.find((row) => row.active) ?? accounts[0];
    if (!active) return { text: t(CONNECT_KEYS[engine]), warn: false };
    const name = active.email ?? active.name ?? active.label;
    if (engine === "chatgpt" && !isEngineConnectionUsable(active)) {
      const reason =
        active.status === "signed_out"
          ? t("mobile.engineAccounts.statusSignedOut")
          : active.status === "reauth_required"
            ? t("mobile.engineAccounts.statusReauth")
            : t("mobile.engineAccounts.statusPlanUsageOff");
      return { text: `${name} · ${reason}`, warn: true };
    }
    return {
      text: active.plan ? `${name} · ${titleCase(active.plan)}` : name,
      warn: false,
    };
  };

  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.sectionLabel}>Model</Text>
        {settings.saving ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : null}
      </View>

      {MODEL_ENGINE_OPTIONS.map((option) => {
        const engine = option.id;
        const selected = ready && engine === current;
        const subtitle = subtitleFor(engine);
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
              accessibilityLabel={`${option.label}, ${subtitle.text}`}
              accessibilityState={{ checked: selected, disabled: !ready }}
              style={({ pressed }) => [
                styles.cardHeader,
                pressed && !selected && styles.pressed,
              ]}
            >
              <ProviderGlyph engine={engine} />
              <View style={styles.copy}>
                <Text style={styles.title} numberOfLines={1}>
                  {option.label}
                </Text>
                <Text
                  style={[styles.subtitle, subtitle.warn && styles.warn]}
                  numberOfLines={1}
                >
                  {subtitle.text}
                </Text>
              </View>
              {!ready ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : (
                <View style={[styles.radio, selected && styles.radioOn]}>
                  {selected ? (
                    <Icon name="check" size={13} color={colors.accentForeground} />
                  ) : null}
                </View>
              )}
            </Pressable>

            {selected ? (
              <CardBody
                engine={engine}
                settings={settings}
                deviceLabel={deviceLabel}
                styles={styles}
              />
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
  deviceLabel,
  styles,
}: {
  engine: ModelEngine;
  settings: ModelSettings;
  deviceLabel: string | null;
  styles: ReturnType<typeof makeStyles>;
}) {
  const t = useT();
  const rows = settings.modelsFor(engine);
  const picked = rows.find((model) => model.selected);
  const engineLabel =
    MODEL_ENGINE_OPTIONS.find((option) => option.id === engine)?.label ?? engine;

  return (
    <View style={[styles.body, engine === "stella" && styles.bodyEnd]}>
      {rows.length === 0 ? (
        <Text style={styles.caption}>No models available.</Text>
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
                model.selected && styles.modelChipOn,
                !model.available && styles.modelChipOff,
                pressed && !model.selected && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.modelChipLabel,
                  model.selected && styles.modelChipLabelOn,
                ]}
                numberOfLines={1}
              >
                {model.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {picked?.description ? (
        <Text style={styles.caption}>{picked.description}</Text>
      ) : null}

      {settings.supportsEffortSelection ? (
        <View style={styles.thinking}>
          <Text style={styles.thinkingLabel}>Thinking</Text>
          <View style={styles.flex}>
            <SegmentedControl<ReasoningEffort>
              accessibilityLabel="Thinking"
              value={settings.effort === "none" ? "default" : settings.effort}
              onChange={settings.selectEffort}
              options={REASONING_OPTIONS.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
            />
          </View>
        </View>
      ) : null}

      {engine !== "stella" && deviceLabel ? (
        <Text style={styles.caption}>
          {t("mobile.settings.computer.ownSignIn", {
            name: deviceLabel,
            engine: engineLabel,
          })}
        </Text>
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
      minHeight: 60,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    copy: {
      flex: 1,
      gap: 2,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    warn: {
      color: colors.danger,
    },
    radio: {
      alignItems: "center",
      borderColor: colors.borderStrong,
      borderRadius: 12,
      borderWidth: 1.5,
      height: 24,
      justifyContent: "center",
      width: 24,
    },
    radioOn: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    pressed: {
      opacity: 0.6,
    },
    body: {
      paddingBottom: 0,
    },
    bodyEnd: {
      paddingBottom: 16,
    },
    models: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 7,
      paddingHorizontal: 16,
    },
    modelChip: {
      backgroundColor: colors.surfaceInset,
      borderRadius: 999,
      paddingHorizontal: 13,
      paddingVertical: 7,
    },
    modelChipOn: {
      backgroundColor: colors.accent,
    },
    modelChipOff: {
      opacity: 0.4,
    },
    modelChipLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    modelChipLabelOn: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
    },
    caption: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
      marginTop: 10,
      paddingHorizontal: 16,
    },
    thinking: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      marginTop: 14,
      paddingHorizontal: 16,
    },
    thinkingLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
    },
    flex: {
      flex: 1,
    },
    accounts: {
      marginTop: 14,
    },
  });
