/**
 * The onboarding composer: the chat composer's glass pill and send button,
 * without the chat-bound extras (attachments, dictation, voice, models).
 * Anything typed here ends onboarding and becomes the first message of the
 * real conversation.
 */
import { useMemo, useState } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useT } from "../../i18n";
import { type Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { fadeHex } from "../../theme/oklch";
import { useColors } from "../../theme/theme-context";
import { GlassSurface } from "../glass";
import { Icon } from "../Icon";
import { SPRING_SNAPPY, SpringPressable, useSpringFlag } from "./motion";

export function OnboardingComposer({
  onSend,
  disabled = false,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [value, setValue] = useState("");
  const canSubmit = value.trim().length > 0 && !disabled;
  const ready = useSpringFlag(canSubmit, SPRING_SNAPPY);
  const sendStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + 0.6 * ready.value,
    transform: [{ scale: 0.9 + 0.1 * ready.value }],
  }));

  const submit = () => {
    if (!canSubmit) return;
    onSend(value.trim());
  };

  return (
    <GlassSurface
      glass="regular"
      interactive
      tintColor={fadeHex(colors.surface, 0.5)}
      radius={999}
      fallbackColor={colors.surface}
      style={styles.shell}
    >
      <View style={styles.pill}>
        <TextInput
          value={value}
          onChangeText={setValue}
          onSubmitEditing={submit}
          placeholder={t("mobile.onboarding.composerPlaceholder")}
          placeholderTextColor={fadeHex(colors.textMuted, 0.45)}
          selectionColor={colors.accent}
          returnKeyType="send"
          submitBehavior="submit"
          editable={!disabled}
          style={styles.input}
          accessibilityLabel={t("mobile.onboarding.composerPlaceholder")}
        />
        <Animated.View style={sendStyle}>
          <SpringPressable
            onPress={submit}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.onboarding.send")}
            accessibilityState={{ disabled: !canSubmit }}
            hitSlop={6}
            pressScale={0.88}
            style={styles.send}
          >
            <Icon name="arrow-up" size={15} color={colors.accentForeground} weight="heavy" />
          </SpringPressable>
        </Animated.View>
      </View>
    </GlassSurface>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    shell: {
      borderColor: colors.panelSurfaceBorder,
      borderWidth: StyleSheet.hairlineWidth,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.08,
      shadowRadius: 24,
      width: "100%",
    },
    pill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minHeight: 50,
      paddingLeft: 18,
      paddingRight: 9,
      paddingVertical: 8,
    },
    input: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 22,
      paddingVertical: 0,
      ...(Platform.OS === "android" ? { textAlignVertical: "center" as const } : {}),
    },
    send: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
  });
