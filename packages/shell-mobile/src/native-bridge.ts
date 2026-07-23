import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { NativeModules, Platform, Share } from "react-native";
import type { WebView } from "react-native-webview";
import { getMobileConvexToken } from "./auth";

type NativeRequest = {
  type?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
};

const send = (
  webview: React.RefObject<WebView | null>,
  value: Record<string, unknown>,
) => {
  webview.current?.postMessage(JSON.stringify(value));
};

export const handleNativeRequest = async (
  webview: React.RefObject<WebView | null>,
  raw: string,
) => {
  let request: NativeRequest;
  try {
    request = JSON.parse(raw) as NativeRequest;
  } catch {
    return;
  }
  const requestId = request.requestId;
  if (!request.type) return;
  try {
    let result: unknown = null;
    switch (request.type) {
      case "getConvexToken":
        result = { token: await getMobileConvexToken(true) };
        break;
      case "haptics":
        await Haptics.selectionAsync();
        result = { ok: true };
        break;
      case "pushPermission":
        result = await Notifications.requestPermissionsAsync();
        break;
      case "share":
        await Share.share({
          message: String(request.payload?.message ?? ""),
          url:
            typeof request.payload?.url === "string"
              ? request.payload.url
              : undefined,
        });
        result = { ok: true };
        break;
      case "carplaySpeak":
        if (Platform.OS === "ios") {
          NativeModules.StellaCarVoice?.speak(
            String(request.payload?.message ?? ""),
          );
        }
        result = { ok: true };
        break;
      default:
        throw new Error("That native capability is not available.");
    }
    if (requestId) {
      send(webview, { type: "stella:native-response", requestId, result });
    }
  } catch (error) {
    if (requestId) {
      send(webview, {
        type: "stella:native-response",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
