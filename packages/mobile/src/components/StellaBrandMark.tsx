import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { type Colors } from "../theme/colors";
import { useTheme } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { StellaMark } from "./StellaMark";

type Props = {

  compact?: boolean;
};

export function StellaBrandMark({ compact = false }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={compact ? styles.rootCompact : styles.root}>
      <StellaMark size={compact ? 26 : 28} color={colors.text} />
      <Text style={compact ? styles.wordmarkCompact : styles.wordmark}>
        Stella
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      paddingBottom: 20,
      paddingHorizontal: 20,
    },
    rootCompact: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
    },
    wordmark: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 22,
      letterSpacing: -0.4,
      lineHeight: 24,
    },
    wordmarkCompact: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 22,
      letterSpacing: -0.4,
      lineHeight: 24,
    },
  });
