import { memo, useMemo, useState } from "react";
import {
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import { Icon, type IconName } from "./Icon";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import type {
  ToolActivityCategory,
  ToolActivityGroup,
  ToolActivityStep,
} from "../lib/tool-activity";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const CATEGORY_ICON: Record<ToolActivityCategory, IconName> = {
  read: "file-text",
  edit: "edit-3",
  search: "search",
  web: "globe",
  command: "terminal",
  create: "sparkles",
  memory: "cpu",
  schedule: "clock",
  message: "message-square",
  other: "box",
};

/**
 * Inline tool-activity trace — the muted, collapsible "Read 3 files and
 * searched code" line under an assistant turn (mobile port of the desktop
 * `ToolActivityTrace`). Tapping the summary expands the individual settled
 * tool calls; the in-flight call is owned by the working indicator.
 */
export const ToolActivityTrace = memo(function ToolActivityTrace({
  group,
  colors,
}: {
  group: ToolActivityGroup;
  colors: Colors;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    LayoutAnimation.configureNext(
      LayoutAnimation.create(
        180,
        LayoutAnimation.Types.easeInEaseOut,
        LayoutAnimation.Properties.opacity,
      ),
    );
    setExpanded((value) => !value);
  };

  return (
    <View style={styles.container}>
      <Pressable
        onPress={toggle}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={group.summary}
        hitSlop={6}
      >
        <Icon
          name={CATEGORY_ICON[group.icon]}
          size={15}
          color={colors.textMuted}
        />
        <Text
          style={styles.label}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {group.summary}
        </Text>
        <View
          style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}
        >
          <Icon name="chevron-right" size={13} color={colors.textMuted} />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.steps}>
          {group.steps.map((step) => (
            <StepRow key={step.id} step={step} styles={styles} colors={colors} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

function StepRow({
  step,
  styles,
  colors,
}: {
  step: ToolActivityStep;
  styles: ReturnType<typeof makeStyles>;
  colors: Colors;
}) {
  const isError = step.status === "error";
  return (
    <View style={styles.step}>
      <Icon
        name={isError ? "alert-circle" : "check"}
        size={12}
        color={isError ? colors.danger : colors.ok}
      />
      <Icon
        name={CATEGORY_ICON[step.category]}
        size={12}
        color={colors.textMuted}
      />
      <Text
        style={styles.stepTitle}
        numberOfLines={1}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
      >
        {step.title}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: {
      marginTop: 6,
      alignSelf: "stretch",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      maxWidth: "100%",
      gap: 7,
      paddingVertical: 2,
      paddingRight: 4,
    },
    label: {
      flexShrink: 1,
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    steps: {
      marginLeft: 8,
      paddingLeft: 10,
      paddingVertical: 4,
      gap: 4,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.border,
    },
    step: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    stepTitle: {
      flexShrink: 1,
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 11.5,
      letterSpacing: -0.1,
      fontVariant: ["tabular-nums"],
    },
  });
