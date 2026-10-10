import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { File, Paths } from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { configurePlaybackAudioSession } from "../lib/mobile-audio-session";
import type { Colors } from "../theme/colors";

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const PLAYER_SCRIPT = String.raw`
(() => {
  const video = document.getElementById("v");
  const post = (state) => {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "stella:video", state }));
    }
  };
  video.addEventListener("playing", () => post("playing"));
  video.addEventListener("error", () => post("error"));
  const start = () => {
    const attempt = video.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => post("blocked"));
    }
  };
  if (video.readyState >= 2) start();
  else video.addEventListener("canplay", start, { once: true });
})();
`;

const playerHtml = (colors: Colors, uri: string, posterUri: string | null) =>
  `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ${colors.background}; }
video { position: fixed; inset: 0; display: block; width: 100%; height: 100%; object-fit: contain; background: ${colors.background}; }
</style>
</head>
<body>
<video id="v" src="${escapeAttribute(uri)}"${posterUri ? ` poster="${escapeAttribute(posterUri)}"` : ""} autoplay playsinline controls preload="auto"></video>
<script>${PLAYER_SCRIPT}</script>
</body>
</html>`;

let sequence = 0;

/**
 * The viewer's video surface: the platform's own `<video>` player, sized to
 * the sheet with aspect-fit so nothing is clipped or scrolls at any size, and
 * started as soon as it can play. Until the first frame is actually playing,
 * the poster sits over it with a spinner instead of an empty black box.
 *
 * The page is written next to the media in the cache directory and loaded as
 * a file, because WKWebView only lets a page read local video and poster
 * files when it was itself loaded from a file with read access to them.
 */
export function VideoPlayerView({
  uri,
  posterUri,
  colors,
}: {
  uri: string;
  posterUri: string | null;
  colors: Colors;
}) {
  const [generatedPoster, setGeneratedPoster] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const poster = posterUri ?? generatedPoster;

  useEffect(() => {
    void configurePlaybackAudioSession().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (posterUri) return;
    let alive = true;
    let made: string | null = null;
    void VideoThumbnails.getThumbnailAsync(uri, { time: 0, quality: 0.7 })
      .then((frame) => {
        made = frame.uri;
        if (alive) setGeneratedPoster(frame.uri);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (made) {
        try {
          new File(made).delete();
        } catch {
          // Already purged with the cache.
        }
      }
    };
  }, [uri, posterUri]);

  const [page] = useState(() => {
    sequence += 1;
    const file = new File(
      Paths.cache,
      `stella-video-player-${Date.now()}-${sequence}.html`,
    );
    try {
      file.create({ overwrite: true, intermediates: true });
      file.write(playerHtml(colors, uri, posterUri));
      return file;
    } catch {
      return null;
    }
  });

  useEffect(
    () => () => {
      try {
        page?.delete();
      } catch {
        // Already purged with the cache.
      }
    },
    [page],
  );

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as {
        type?: unknown;
        state?: unknown;
      };
      if (message.type === "stella:video" && typeof message.state === "string") {
        setStarted(true);
      }
    } catch {
      // Not ours.
    }
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {page ? (
        <WebView
          key={page.uri}
          originWhitelist={["*"]}
          source={{ uri: page.uri }}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowingReadAccessToURL={Paths.cache.uri}
          allowsInlineMediaPlayback
          allowsFullscreenVideo
          mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          onMessage={onMessage}
          style={[styles.web, { backgroundColor: colors.background }]}
        />
      ) : null}
      {started && page ? null : <PosterCover posterUri={poster} colors={colors} />}
    </View>
  );
}

/**
 * The poster, aspect-fit, under a spinner: what a video shows while it is
 * fetched and until its first frame plays.
 */
export function PosterCover({
  posterUri,
  colors,
}: {
  posterUri: string | null;
  colors: Colors;
}) {
  return (
    <View
      pointerEvents="none"
      style={[styles.cover, { backgroundColor: colors.background }]}
    >
      {posterUri ? (
        <Image
          source={{ uri: posterUri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={120}
        />
      ) : null}
      <View style={[styles.spinner, { backgroundColor: colors.overlay }]}>
        <ActivityIndicator size="large" color="#ffffff" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  root: { flex: 1, overflow: "hidden" },
  spinner: {
    alignItems: "center",
    borderRadius: 32,
    height: 64,
    justifyContent: "center",
    width: 64,
  },
  web: { flex: 1 },
});
