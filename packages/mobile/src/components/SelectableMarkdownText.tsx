import { memo, useMemo } from "react";
import { Platform, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle } from "react-native";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import type { MarkdownNode } from "react-native-nitro-markdown";
import { fonts } from "../theme/fonts";
import type { Colors } from "../theme/colors";
import { markdownTextRuns, selectableItalicFonts } from "../lib/selectable-markdown-runs";

const italicFontWeights = {
  [fonts.sans.regular]: "400", [fonts.sans.medium]: "500",
  [fonts.sans.semiBold]: "600", [fonts.sans.bold]: "700",
  [fonts.display.light]: "300", [fonts.display.regular]: "400",
  [fonts.display.regularItalic]: "400", [fonts.display.semiBold]: "600",
  [fonts.mono.regular]: "400", [fonts.mono.medium]: "500",
} as const;

const selectionModule = Platform.OS === "ios"
  ? requireOptionalNativeModule<{ supportsSelectionActions?: boolean }>("StellaSelectableText")
  : null;
export const nativeMarkdownSelectionAvailable = Boolean(selectionModule);
const supportsSelectionActions = selectionModule?.supportsSelectionActions === true;
const NativeText = nativeMarkdownSelectionAvailable ? requireNativeViewManager<{
  runsJSON: string; alignment?: string; style: object; askStellaEnabled?: boolean;
  onAskStella?: (event: { nativeEvent: { text: string } }) => void;
  onLinkPress: (event: { nativeEvent: { url: string } }) => void;
}>("StellaSelectableText") : null;

export const SelectableMarkdownText = memo(function SelectableMarkdownText({ node, colors, textStyle, onLinkPress, onAskStella }: {
  node: MarkdownNode; colors: Colors; textStyle?: StyleProp<TextStyle>; onLinkPress?: (url: string) => unknown; onAskStella?: (text: string) => void;
}) {
  const flattened = StyleSheet.flatten(textStyle) ?? {};
  const { fontScale } = useWindowDimensions();
  const fontSize = (flattened.fontSize ?? 17) * fontScale;
  const runs = useMemo(() => selectableItalicFonts(markdownTextRuns(node, colors, fonts, {
    fontSize, fontFamily: flattened.fontFamily ?? fonts.sans.regular,
    color: typeof flattened.color === "string" ? flattened.color : colors.text,
  }), italicFontWeights), [node, colors, fontSize, flattened.fontFamily, flattened.color]);
  const runsJSON = useMemo(() => JSON.stringify(runs), [runs]);
  if (!NativeText) return null;
  // RN's attributed Text measures the complete block synchronously with Yoga.
  // UIKit sits over that same layout, so no JS height callback can move the
  // transcript after mount. The measuring copy is invisible and inaccessible.
  return <View style={{ alignSelf: "stretch", flexShrink: 1 }}>
    <Text allowFontScaling={false} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      pointerEvents="none" style={{ opacity: 0, fontFamily: flattened.fontFamily ?? fonts.sans.regular, fontSize, lineHeight: fontSize * 1.5 }}>
      {runs.map((run, index) => <Text allowFontScaling={false} key={index} style={{ fontFamily: run.fontFamily, fontSize: run.fontSize, fontWeight: run.fontWeight, fontStyle: run.italic ? "italic" : "normal" }}>{run.text}</Text>)}
    </Text>
    <NativeText runsJSON={runsJSON} alignment={flattened.textAlign}
      {...(supportsSelectionActions ? {
        askStellaEnabled: Boolean(onAskStella),
        onAskStella: ({ nativeEvent }: { nativeEvent: { text: string } }) => onAskStella?.(nativeEvent.text),
      } : {})}
      style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
      onLinkPress={({ nativeEvent }) => onLinkPress?.(nativeEvent.url)} />
  </View>;
});
