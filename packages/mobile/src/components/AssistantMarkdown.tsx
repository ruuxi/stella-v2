/**
 * Renders assistant message text with markdown formatting.
 *
 * Uses `react-native-nitro-markdown` — a native md4c parser bridged via
 * JSI. Streaming messages flow through a `MarkdownSession`: every text
 * update computes the delta and pushes it via `session.append(delta)`.
 * The native parser handles incremental updates and unclosed fences
 * correctly (per CommonMark spec), so we don't need the string-level
 * shimming the previous markdown-it-based renderer required.
 *
 * The mobile chat dispatcher (`chat.tsx`) smooths raw provider deltas into
 * small cadence-based text updates, so parser work stays bounded and visible
 * text does not inherit upstream token burst timing.
 *
 * Stream fade reveal lives in `StreamingMarkdownText.tsx` as a custom
 * `text` renderer; we attach it only for messages that ever streamed in
 * this instance (latched via `hasStreamedRef`).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import {
  Markdown,
  MarkdownStream,
  createMarkdownSession,
  type CustomRenderers,
  type CustomRendererProps,
  type MarkdownSession,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import * as WebBrowser from "expo-web-browser";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import type { Colors } from "../theme/colors";
import { streamingTextRenderers } from "./StreamingMarkdownText";
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
});

export function AssistantMarkdown({
  text,
  colors,
  isStreaming = false,
}: {
  text: string;
  colors: Colors;
  /**
   * True while this message is mid-stream. Latched true for the row's
   * lifetime once it flips on — finishing the stream keeps the same
   * session-backed component so in-flight word fades complete instead
   * of snapping when the renderer would otherwise swap.
   */
  isStreaming?: boolean;
}) {
  const theme = useMemo(() => buildTheme(colors), [colors]);
  const nodeStyles = useMemo(() => buildNodeStyles(colors), [colors]);

  const hasStreamedRef = useRef(false);
  if (isStreaming) hasStreamedRef.current = true;
  const useStreamingMode = hasStreamedRef.current;

  // Latest text via ref so the session-creation memo can prime
  // synchronously without listing `text` as a dep (which would
  // recreate the session on every token).
  const textRef = useRef(text);
  textRef.current = text;

  const session = useMemo<MarkdownSession | null>(() => {
    if (!useStreamingMode) return null;
    const s = createMarkdownSession();
    if (textRef.current.length > 0) s.reset(textRef.current);
    return s;
  }, [useStreamingMode]);

  // Push monotonic deltas into the session. Reset on any non-prefix
  // change (e.g. an error path that overwrites the text wholesale).
  const lastSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    if (lastSyncedRef.current === null) {
      // First effect run — session was already primed in useMemo.
      lastSyncedRef.current = text;
      return;
    }
    const prev = lastSyncedRef.current;
    if (text === prev) return;
    if (text.startsWith(prev)) {
      const delta = text.slice(prev.length);
      if (delta.length > 0) session.append(delta);
    } else {
      session.reset(text);
    }
    lastSyncedRef.current = text;
  }, [session, text]);

  useEffect(() => {
    return () => {
      session?.dispose();
    };
  }, [session]);

  const renderers = useMemo<CustomRenderers>(
    () => ({
      ...(useStreamingMode ? streamingTextRenderers : {}),
      table: ({ node, Renderer }: CustomRendererProps) => (
        <AssistantMarkdownTable
          node={node}
          Renderer={Renderer}
          colors={colors}
        />
      ),
    }),
    [colors, useStreamingMode],
  );

  const onLinkPress = useCallback((url: string): boolean => {
    void openLink(url);
    return false;
  }, []);

  let content: ReactNode;
  if (session) {
    content = (
      <MarkdownStream
        session={session}
        options={PARSER_OPTIONS}
        theme={theme}
        styles={nodeStyles}
        stylingStrategy="minimal"
        renderers={renderers}
        onLinkPress={onLinkPress}
        updateStrategy="raf"
      />
    );
  } else {
    content = (
      <Markdown
        options={PARSER_OPTIONS}
        theme={theme}
        styles={nodeStyles}
        stylingStrategy="minimal"
        renderers={renderers}
        onLinkPress={onLinkPress}
      >
        {text}
      </Markdown>
    );
  }

  return <View style={containerStyle.wrapper}>{content}</View>;
}
