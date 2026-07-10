import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Icon } from "./Icon";
import { Image } from "expo-image";
import { WebView } from "react-native-webview";
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
  resolveArtifactBridge,
} from "../lib/desktop-artifact-data";
import { readLocalPdfDataUri, sharePdf } from "../lib/chat-pdf";
import {
  DOCUMENT_PAGE_BACKGROUND,
  prepareDocumentHtml,
} from "../lib/html-document-preview";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

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
  /**
   * A print-style HTML *document* (canvas HTML, office preview). Rendered on
   * a paper-white surface regardless of app theme; see html-document-preview.
   */
  | { kind: "html-document"; html: string }
  | { kind: "url"; uri: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "image"; uri: string }
  | { kind: "web-media"; html: string };

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

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
video, audio, iframe { width: 100%; border: 0; border-radius: 12px; background: ${colors.muted}; }
video, iframe { min-height: 70vh; }
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
  const onShare = useCallback(async () => {
    if (!localPdf || sharing) return;
    setSharing(true);
    try {
      const result = await sharePdf(localPdf);
      if (!result.ok) Alert.alert("Couldn't share the PDF", result.error);
    } finally {
      setSharing(false);
    }
  }, [localPdf, sharing]);

  useEffect(() => {
    if (!artifact) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setLoading(true);

    const load = async () => {
      const payload = artifact.payload;
      if (payload.kind === "url") {
        return { kind: "url" as const, uri: payload.url };
      }
      if (payload.kind === "media" && payload.asset.kind === "text") {
        return { kind: "text" as const, text: payload.asset.text };
      }
      // On-device PDF (cloud chat's `pdf` tool) — read the local file straight
      // off disk and preview it inline; no desktop bridge is involved.
      if (payload.kind === "pdf" && payload.localUri) {
        const uri = await readLocalPdfDataUri(payload.localUri);
        return {
          kind: "web-media" as const,
          html: mediaHtml(
            colors,
            title,
            `<iframe src="${uri}" title="${escapeHtml(title)}"></iframe>`,
          ),
        };
      }
      if (!access) {
        throw new Error("Pair this phone with your desktop again.");
      }
      const bridge = await resolveArtifactBridge(access);

      if (payload.kind === "office") {
        return {
          kind: "html-document" as const,
          html: prepareDocumentHtml(
            await loadExistingOfficePreviewHtml(
              bridge,
              artifact.conversationId,
              payload.previewRef.sessionId,
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
              bridge,
              artifact.conversationId,
              payload.filePath,
            ),
          ),
        };
      }

      const filePath = artifactPrimaryFilePath(payload);
      if (!filePath) {
        throw new Error("This artifact does not have a mobile preview yet.");
      }
      const result = await readDesktopArtifactFile(
        bridge,
        artifact.conversationId,
        filePath,
      );
      if (result.missing) throw new Error("This file is no longer available.");

      if (payload.kind === "canvas-html") {
        return {
          kind: "html-document" as const,
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
        const uri = bytesToDataUri(result.bytes, result.mimeType);
        return {
          kind: "web-media" as const,
          html: mediaHtml(
            colors,
            title,
            `<iframe src="${uri}" title="${escapeHtml(title)}"></iframe>`,
          ),
        };
      }
      if (payload.kind === "media") {
        const uri = bytesToDataUri(result.bytes, result.mimeType);
        if (payload.asset.kind === "image") {
          return { kind: "image" as const, uri };
        }
        if (payload.asset.kind === "audio") {
          return {
            kind: "web-media" as const,
            html: mediaHtml(
              colors,
              title,
              `<audio controls src="${uri}"></audio>`,
            ),
          };
        }
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
        {localPdf ? (
          <Pressable
            onPress={onShare}
            disabled={sharing}
            accessibilityRole="button"
            accessibilityLabel="Save or share PDF"
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
          ) : loaded?.kind === "html-document" ? (
            <WebView
              originWhitelist={["*"]}
              source={{ html: loaded.html }}
              style={styles.documentWebview}
              // Documents render on their own paper-white surface; never let
              // Android WebView force-darken them into unreadability.
              forceDarkOn={false}
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
