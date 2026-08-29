/**
 * Renders assistant message text with markdown formatting.
 *
 * Uses `react-native-nitro-markdown` — a native md4c parser bridged via JSI.
 * Assistant messages arrive whole (iMessage-style: one delivery per completed
 * message segment), so this is a single one-shot parse of a settled string —
 * no incremental `MarkdownSession`, no per-token reveal, no re-parse cadence to
 * manage. A message's text only changes if the turn's canonical row later
 * replaces it, which is a normal re-render.
 */
import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Alert, Linking, Platform, StyleSheet, View } from "react-native";
import {
  Markdown,
  type CustomRenderers,
  type CustomRendererProps,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import * as WebBrowser from "expo-web-browser";
import { parseStellaFileUrl } from "../lib/stella-file-links";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import type { Colors } from "../theme/colors";
import { AssistantMarkdownTable } from "./AssistantMarkdownTable";

const BASE_FONT_SIZE = 17;

async function openLink(url: string): Promise<boolean> {
  try {
    if (/^https?:\/\//i.test(url)) {
      await WebBrowser.openBrowserAsync(url);
    } else {
      await Linking.openURL(url);
    }
  } catch {
    // Swallow — link target may be malformed mid-stream.
  }
  return false;
}

function buildTheme(colors: Colors): PartialMarkdownTheme {
  return {
    colors: {
      text: colors.text,
      textMuted: colors.textMuted,
      heading: colors.textStrong,
      link: colors.accent,
      code: colors.text,
      codeBackground: fadeHex(colors.muted, 0.35),
      codeLanguage: colors.textMuted,
      blockquote: colors.borderStrong,
      border: fadeHex(colors.border, 0.6),
      surface: "transparent",
      surfaceLight: "transparent",
      accent: colors.accent,
      tableBorder: colors.border,
      tableHeader: fadeHex(colors.muted, 0.4),
      tableHeaderText: colors.textStrong,
      tableRowEven: "transparent",
      tableRowOdd: fadeHex(colors.muted, 0.2),
    },
    fontSizes: {
      // m is the body size — every other size on this theme is a
      // bullet/heading/code variant of it.
      xs: 12,
      s: 14,
      m: BASE_FONT_SIZE,
      l: 18,
      xl: 20,
      h1: 22,
      h2: 20,
      h3: 18,
      h4: BASE_FONT_SIZE,
      h5: 15,
      h6: 14,
    },
    fontFamilies: {
      regular: fonts.sans.regular,
      heading: fonts.sans.semiBold,
      mono: fonts.mono.regular,
    },
    headingWeight: "600",
    spacing: {
      xs: 4,
      s: 6,
      m: 10,
      l: 14,
      xl: 20,
    },
    borderRadius: {
      s: 4,
      m: 8,
      l: 12,
    },
    showCodeLanguage: false,
  };
}

function buildNodeStyles(colors: Colors): NodeStyleOverrides {
  const codeBg = fadeHex(colors.muted, 0.35);
  const codeBorder = fadeHex(colors.border, 0.6);
  return {
    paragraph: { marginTop: 0, marginBottom: 10 },
    heading: { marginTop: 12, marginBottom: 6 },
    bold: { fontFamily: fonts.sans.semiBold },
    code_inline: {
      backgroundColor: codeBg,
      borderColor: codeBorder,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: Platform.OS === "ios" ? 1 : 0,
      fontFamily: fonts.mono.regular,
      fontSize: BASE_FONT_SIZE - 1,
      color: colors.text,
    },
    code_block: {
      backgroundColor: codeBg,
      borderColor: codeBorder,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      marginVertical: 8,
    },
    blockquote: {
      backgroundColor: fadeHex(colors.muted, 0.35),
      borderLeftColor: colors.borderStrong,
      borderLeftWidth: 3,
      paddingVertical: 6,
      paddingHorizontal: 12,
      marginVertical: 8,
      borderRadius: 6,
    },
    horizontal_rule: {
      backgroundColor: colors.border,
      height: 1,
      marginVertical: 12,
    },
    list: { marginVertical: 4 },
    list_item: { marginBottom: 4 },
    table: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      marginVertical: 8,
    },
  };
}

const PARSER_OPTIONS = { gfm: true, math: false, html: false } as const;
const containerStyle = StyleSheet.create({
  // The wrapping View lets the parent Pressable still receive long-press —
  // markdown children render as Text/Views that don't intercept it.
  wrapper: { width: "100%" },
  // Hugging variant: no width, so the wrapper measures to its widest child and
  // an enclosing bubble can size to the text instead of always filling its
  // max-width. Block children still stretch to whatever width that yields.
  hug: {},
});

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  colors,
  selectable = false,
  fill = true,
  onStellaFileLink,
}: {
  text: string;
  colors: Colors;
  /** Enables native selection on the rendered markdown text nodes. */
  selectable?: boolean;
  /**
   * Stretch to the parent's width (documents, artifact bodies). Pass `false`
   * inside a chat bubble so the bubble hugs the text rather than always
   * rendering at its max width.
   */
  fill?: boolean;
  /**
   * Tap handler for `stella://file/<path>` links — the assistant's way of
   * pointing at a local file. When provided, such links open the in-app
   * file viewer instead of being handed to the OS (which silently drops
   * the unknown scheme).
   */
  onStellaFileLink?: (path: string) => void;
}) {
  const theme = useMemo(() => buildTheme(colors), [colors]);
  const nodeStyles = useMemo(() => buildNodeStyles(colors), [colors]);

  const renderers = useMemo<CustomRenderers>(
    () => ({
      table: ({ node, Renderer }: CustomRendererProps) => (
        <AssistantMarkdownTable
          node={node}
          Renderer={Renderer}
          colors={colors}
          selectable={selectable}
        />
      ),
    }),
    [colors, selectable],
  );

  const onLinkPress = useCallback(
    (url: string): boolean => {
      const stellaFilePath = parseStellaFileUrl(url);
      if (stellaFilePath) {
        if (onStellaFileLink) {
          onStellaFileLink(stellaFilePath);
        } else {
          // Surface something rather than silently dropping the tap — the
          // OS has no handler for the stella:// scheme.
          Alert.alert(
            "File preview unavailable",
            "This file can't be previewed from this chat.",
          );
        }
        return false;
      }
      void openLink(url);
      return false;
    },
    [onStellaFileLink],
  );

  const content: ReactNode = (
    <Markdown
      options={PARSER_OPTIONS}
      theme={theme}
      styles={nodeStyles}
      stylingStrategy="minimal"
      renderers={renderers}
      onLinkPress={onLinkPress}
      selectable={selectable}
    >
      {text}
    </Markdown>
  );

  return (
    <View style={fill ? containerStyle.wrapper : containerStyle.hug}>
      {content}
    </View>
  );
});
