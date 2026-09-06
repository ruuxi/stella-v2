import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Icon } from "./Icon";
import { AudioPlayerView } from "./AudioPlayerView";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { TopSheet } from "./TopSheet";
import type { ChatArtifact } from "../types";
import type { StoredPhoneAccess } from "../lib/phone-access";
import {
  artifactPrimaryFilePath,
  artifactSubtitle,
  artifactTitle,
} from "../lib/mobile-artifacts";
import {
  bytesToDataUri,
  bytesToText,
  loadExistingOfficePreviewHtml,
  loadOfficePreviewHtml,
  readDesktopArtifactFile,
} from "../lib/desktop-artifact-data";
import { sharePdf } from "../lib/chat-pdf";
import {
  writeArtifactMediaFile,
  type ArtifactMediaFile,
} from "../lib/artifact-media-file";
import {
  DOCUMENT_PAGE_BACKGROUND,
  prepareDocumentHtml,
} from "../lib/html-document-preview";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { classifyCanvasNavigation } from "../lib/canvas-navigation";

type ArtifactViewerProps = {
  artifact: ChatArtifact | null;
  access: StoredPhoneAccess | null;
  visible: boolean;
  onClose: () => void;
};

type ArtifactViewerContentProps = {
  artifact: ChatArtifact | null;
  access: StoredPhoneAccess | null;
  /**
   * When hosted inside another sheet (the activity hub), renders a back
   * chevron in the header for returning to the host's list instead of
   * dismissing the whole sheet.
   */
  onBack?: () => void;
};

type LoadedArtifact =
  | { kind: "html"; html: string }
  | { kind: "canvas-html"; html: string }
  /**
   * A print-style HTML *document* (canvas HTML, office preview). Rendered on
   * a paper-white surface regardless of app theme; see html-document-preview.
   */
  | { kind: "html-document"; html: string }
  | { kind: "url"; uri: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "image"; uri: string }
  /** A `file://` PDF handed to the platform's own full-page PDF renderer. */
  | { kind: "pdf"; uri: string }
  /** A `file://` clip played by the native transport in `AudioPlayerView`. */
  | { kind: "audio"; uri: string }
  | { kind: "web-media"; html: string };

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const CANVAS_NAVIGATION_SCRIPT = String.raw`
(() => {
  const navigate = (rawHref) => {
    const href = rawHref.trim();
    if (href.startsWith("#")) {
      let fragment;
      try { fragment = decodeURIComponent(href.slice(1)); } catch { return; }
      if (!fragment) {
        window.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      const target = document.getElementById(fragment) ||
        document.querySelector('[name="' + CSS.escape(fragment) + '"]');
      target?.scrollIntoView();
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "stella:canvas-navigate",
      href,
    }));
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    const anchor = target && typeof target.closest === "function"
      ? target.closest("a[href]")
      : null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(anchor.getAttribute("href") || "");
  }, true);

  document.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target;
    if (form && typeof form.getAttribute === "function") {
      navigate(form.getAttribute("action") || "");
    }
  }, true);
})();
true;
`;

function CanvasDocumentWebView({ html, style }: { html: string; style: object }) {
  const webViewRef = useRef<WebView>(null);
  const allowedInitialLoadRef = useRef(false);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as {
        type?: unknown;
        href?: unknown;
      };
      if (
        message.type !== "stella:canvas-navigate" ||
        typeof message.href !== "string"
      ) {
        return;
      }
      const navigation = classifyCanvasNavigation(message.href);
      if (navigation.kind === "external") {
        void Linking.openURL(navigation.url).catch(() => undefined);
      }
    } catch {
      // Ignore malformed messages from untrusted canvas code.
    }
  }, []);

  return (
    <WebView
      ref={webViewRef}
      originWhitelist={["*"]}
      source={{ html }}
      style={style}
      forceDarkOn={false}
      injectedJavaScript={CANVAS_NAVIGATION_SCRIPT}
      onMessage={handleMessage}
      onShouldStartLoadWithRequest={(request) => {
        const isCanvasDocument =
          request.url === "about:blank" ||
          request.url.startsWith("data:text/html");
        if (!allowedInitialLoadRef.current && isCanvasDocument) {
          allowedInitialLoadRef.current = true;
          return true;
        }
        return false;
      }}
    />
  );
}

/**
 * Wrapper document for media the viewer still renders in a WebView (video).
 * PDFs and audio have their own full-surface treatments — `kind: "pdf"` and
 * `kind: "audio"` — because this centred, capped-height card clipped PDF pages
 * and reduced audio to a floating browser control bar.
 */
const mediaHtml = (colors: Colors, title: string, body: string) =>
  `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<style>
html, body { margin: 0; min-height: 100%; background: ${colors.background}; color: ${colors.text}; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
body { display: flex; align-items: center; justify-content: center; padding: 18px; box-sizing: border-box; }
.frame { width: 100%; }
.title { font-size: 13px; color: ${colors.textMuted}; margin: 0 0 12px; overflow-wrap: anywhere; }
video { width: 100%; border: 0; border-radius: 12px; background: ${colors.muted}; min-height: 70vh; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body><main class="frame"><p class="title">${escapeHtml(title)}</p>${body}</main></body>
</html>`;

const delimitedToHtml = (
  colors: Colors,
  title: string,
  text: string,
  delimiter: "," | "\t",
) => {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(0, 200)
    .map((line) => line.split(delimiter).slice(0, 24));
  const table = rows
    .map(
      (row, rowIndex) =>
        `<tr>${row
          .map((cell) =>
            rowIndex === 0
              ? `<th>${escapeHtml(cell)}</th>`
              : `<td>${escapeHtml(cell)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<style>
html, body { margin: 0; background: ${colors.background}; color: ${colors.text}; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
body { padding: 16px; }
h1 { font-size: 16px; margin: 0 0 12px; }
.wrap { overflow: auto; border: 1px solid ${colors.border}; border-radius: 12px; background: ${colors.surface}; }
table { border-collapse: collapse; min-width: 100%; font-size: 13px; }
th, td { border-bottom: 1px solid ${colors.border}; border-right: 1px solid ${colors.border}; padding: 8px 10px; text-align: left; vertical-align: top; }
th { position: sticky; top: 0; background: ${colors.muted}; font-weight: 600; }
</style>
</head>
<body><h1>${escapeHtml(title)}</h1><div class="wrap"><table>${table}</table></div></body>
</html>`;
};

/**
 * The artifact display itself (header + rendered preview), without any sheet
 * chrome. `ArtifactViewer` wraps it in a `TopSheet` for the chat-card path;
 * the activity hub embeds it directly so artifacts open within that sheet.
 */
export function ArtifactViewerContent({
  artifact,
  access,
  onBack,
}: ArtifactViewerContentProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.top),
    [colors, insets.top],
  );
  const [loaded, setLoaded] = useState<LoadedArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const title = artifact ? artifactTitle(artifact.payload) : "Artifact";
  const subtitle = artifact ? artifactSubtitle(artifact.payload) : "";

  // On-device PDFs carry a local file URI we can hand straight to the OS share
  // sheet (save to Files / open in another app), with no desktop bridge.
  const localPdf =
    artifact &&
    artifact.payload.kind === "pdf" &&
    artifact.payload.localUri
      ? artifact.payload
      : null;
  const [sharing, setSharing] = useState(false);
  const shareableImageUri = loaded?.kind === "image" && loaded.uri.startsWith("file:")
    ? loaded.uri
    : null;
  const onShare = useCallback(async () => {
    if ((!localPdf && !shareableImageUri) || sharing) return;
    setSharing(true);
    try {
      if (localPdf) {
        const result = await sharePdf(localPdf);
        if (!result.ok) Alert.alert("Couldn't share the PDF", result.error);
      } else if (shareableImageUri) {
        await Sharing.shareAsync(shareableImageUri, {
          mimeType: "image/*",
          dialogTitle: "Share generated image",
        });
      }
    } finally {
      setSharing(false);
    }
  }, [localPdf, shareableImageUri, sharing]);

  useEffect(() => {
    if (!artifact) return;
    let cancelled = false;
    const controller = new AbortController();
    // PDFs and audio are handed to native renderers as real files; they live
    // in the cache only as long as this artifact is on screen.
    let materialized: ArtifactMediaFile | null = null;
    setLoaded(null);
    setError(null);
    setLoading(true);

    const materialize = (
      bytes: Uint8Array,
      mimeType: string,
      sourcePath: string,
    ): string => {
      const file = writeArtifactMediaFile(bytes, mimeType, sourcePath);
      if (cancelled) file.remove();
      else materialized = file;
      return file.uri;
    };

    const load = async () => {
      const payload = artifact.payload;
      if (payload.kind === "url") {
        return { kind: "url" as const, uri: payload.url };
      }
      if (payload.kind === "media" && payload.asset.kind === "text") {
        return { kind: "text" as const, text: payload.asset.text };
      }
      // On-device PDF (cloud chat's `pdf` tool) — the file is already on disk,
      // so hand its URI straight to the viewer; no desktop bridge is involved.
      if (payload.kind === "pdf" && payload.localUri) {
        return { kind: "pdf" as const, uri: payload.localUri };
      }
      if (payload.kind === "media" && payload.asset.kind === "image") {
        const filePath = payload.asset.filePaths[0];
        if (filePath && /^(?:file|https?|data):/i.test(filePath)) {
          return { kind: "image" as const, uri: filePath };
        }
      }
      if (!access) {
        throw new Error("Pair this phone with your desktop again.");
      }

      if (payload.kind === "office") {
        return {
          kind: "html-document" as const,
          html: prepareDocumentHtml(
            await loadExistingOfficePreviewHtml(
              access,
              artifact.conversationId,
              payload.previewRef.sessionId,
              controller.signal,
            ),
          ),
        };
      }
      if (
        payload.kind === "file-artifact" &&
        payload.artifactKind !== "delimited-table"
      ) {
        return {
          kind: "html-document" as const,
          html: prepareDocumentHtml(
            await loadOfficePreviewHtml(
              access,
              artifact.conversationId,
              payload.filePath,
              controller.signal,
            ),
          ),
        };
      }

      const filePath = artifactPrimaryFilePath(payload);
      if (!filePath) {
        throw new Error("This artifact does not have a mobile preview yet.");
      }
      const result = await readDesktopArtifactFile(
        access,
        artifact.conversationId,
        filePath,
        controller.signal,
      );
      if (result.missing) throw new Error("This file is no longer available.");

      if (payload.kind === "canvas-html") {
        return {
          kind: "canvas-html" as const,
          html: prepareDocumentHtml(bytesToText(result.bytes)),
        };
      }
      if (payload.kind === "markdown") {
        return { kind: "markdown" as const, text: bytesToText(result.bytes) };
      }
      if (payload.kind === "source-diff") {
        return {
          kind: "text" as const,
          text: payload.patch || bytesToText(result.bytes),
        };
      }
      if (
        payload.kind === "file-artifact" &&
        payload.artifactKind === "delimited-table"
      ) {
        const delimiter = filePath.toLowerCase().endsWith(".tsv") ? "\t" : ",";
        return {
          kind: "html" as const,
          html: delimitedToHtml(
            colors,
            title,
            bytesToText(result.bytes),
            delimiter,
          ),
        };
      }
      if (payload.kind === "pdf") {
        return {
          kind: "pdf" as const,
          uri: materialize(result.bytes, result.mimeType, filePath),
        };
      }
      if (payload.kind === "media") {
        if (payload.asset.kind === "audio") {
          return {
            kind: "audio" as const,
            uri: materialize(result.bytes, result.mimeType, filePath),
          };
        }
        if (payload.asset.kind === "image") {
          return {
            kind: "image" as const,
            uri: materialize(result.bytes, result.mimeType, filePath),
          };
        }
        const uri = bytesToDataUri(result.bytes, result.mimeType);
        if (payload.asset.kind === "video") {
          return {
            kind: "web-media" as const,
            html: mediaHtml(
              colors,
              title,
              `<video controls playsinline src="${uri}"></video>`,
            ),
          };
        }
      }
      return { kind: "text" as const, text: bytesToText(result.bytes) };
    };

    void load()
      .then((next) => {
        if (!cancelled) setLoaded(next);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      materialized?.remove();
    };
  }, [access, artifact, colors, title]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={10}
            style={({ pressed }) => [
              styles.backButton,
              pressed && styles.backButtonPressed,
            ]}
          >
            <Icon name="chevron-left" size={20} color={colors.text} />
          </Pressable>
        ) : null}
        <View style={styles.headerText}>
          <Text
            style={styles.title}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {title}
          </Text>
          <Text
            style={styles.subtitle}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {subtitle}
          </Text>
        </View>
        {localPdf || shareableImageUri ? (
          <Pressable
            onPress={onShare}
            disabled={sharing}
            accessibilityRole="button"
            accessibilityLabel={localPdf ? "Save or share PDF" : "Share generated image"}
            hitSlop={10}
            style={({ pressed }) => [
              styles.shareButton,
              pressed && styles.backButtonPressed,
            ]}
          >
            {sharing ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Icon name="share" size={20} color={colors.text} />
            )}
          </Pressable>
        ) : null}
      </View>
        <View style={styles.body}>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.textMuted} />
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.error}>{error}</Text>
            </View>
          ) : loaded?.kind === "url" ? (
            <WebView
              source={{ uri: loaded.uri }}
              style={styles.webview}
              startInLoadingState
              renderLoading={() => (
                <View style={styles.center}>
                  <ActivityIndicator color={colors.textMuted} />
                </View>
              )}
            />
          ) : loaded?.kind === "canvas-html" ? (
            <CanvasDocumentWebView
              html={loaded.html}
              style={styles.documentWebview}
            />
          ) : loaded?.kind === "html-document" ? (
            <WebView
              originWhitelist={["*"]}
              source={{ html: loaded.html }}
              style={styles.documentWebview}
              // Documents render on their own paper-white surface; never let
              // Android WebView force-darken them into unreadability.
              forceDarkOn={false}
            />
          ) : loaded?.kind === "pdf" ? (
            // Loading the file at the top level (rather than in an iframe)
            // hands it to the platform's own PDF renderer, which fits the page
            // to the width, scrolls through pages, and pinch-zooms — the same
            // full-bleed treatment HTML documents get.
            <WebView
              originWhitelist={["*"]}
              source={{ uri: loaded.uri }}
              style={styles.documentWebview}
              allowFileAccess
              forceDarkOn={false}
            />
          ) : loaded?.kind === "audio" ? (
            <AudioPlayerView
              uri={loaded.uri}
              title={title}
              subtitle={subtitle}
            />
          ) : loaded?.kind === "html" || loaded?.kind === "web-media" ? (
            <WebView
              originWhitelist={["*"]}
              source={{ html: loaded.html }}
              style={styles.webview}
            />
          ) : loaded?.kind === "image" ? (
            <Image
              source={{ uri: loaded.uri }}
              style={styles.image}
              contentFit="contain"
              accessibilityLabel={title}
            />
          ) : loaded?.kind === "markdown" ? (
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <AssistantMarkdown text={loaded.text} colors={colors} />
            </ScrollView>
          ) : loaded?.kind === "text" ? (
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <Text style={styles.monospace}>{loaded.text}</Text>
            </ScrollView>
          ) : null}
      </View>
    </View>
  );
}

/** Standalone top-sheet artifact viewer, opened from agent cards in chat. */
export function ArtifactViewer({
  artifact,
  access,
  visible,
  onClose,
}: ArtifactViewerProps) {
  return (
    <TopSheet visible={visible} onClose={onClose}>
      <ArtifactViewerContent artifact={artifact} access={access} />
    </TopSheet>
  );
}

const makeStyles = (colors: ReturnType<typeof useColors>, topInset: number) =>
  StyleSheet.create({
    root: {
      backgroundColor: colors.background,
      flex: 1,
    },
    header: {
      alignItems: "center",
      backgroundColor: colors.background,
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      paddingBottom: 12,
      paddingHorizontal: 18,
      paddingTop: topInset + 12,
    },
    headerText: {
      flex: 1,
      minWidth: 0,
    },
    backButton: {
      alignItems: "center",
      justifyContent: "center",
      marginLeft: -6,
      width: 28,
    },
    backButtonPressed: {
      opacity: 0.6,
    },
    shareButton: {
      alignItems: "center",
      height: 32,
      justifyContent: "center",
      marginLeft: 8,
      width: 32,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      marginTop: 2,
    },
    body: {
      flex: 1,
    },
    webview: {
      backgroundColor: colors.background,
      flex: 1,
    },
    documentWebview: {
      backgroundColor: DOCUMENT_PAGE_BACKGROUND,
      flex: 1,
    },
    image: {
      flex: 1,
      width: "100%",
    },
    center: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      padding: 24,
    },
    error: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
    },
    scrollContent: {
      padding: 18,
    },
    monospace: {
      color: colors.text,
      fontFamily: fonts.mono.regular,
      fontSize: 12,
      lineHeight: 18,
    },
  });
