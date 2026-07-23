import { useEffect, useRef } from "react";
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  type EmitterSubscription,
} from "react-native";
import type { WebView } from "react-native-webview";

type CarVoiceModule = {
  startListening(): void;
  stopListening(): void;
  speak(text: string): void;
};

type CarVoiceTranscript = {
  text?: string;
};

const dispatchTranscript = (
  webview: React.RefObject<WebView | null>,
  text: string,
) => {
  webview.current?.injectJavaScript(
    `window.dispatchEvent(new CustomEvent("stella:carplay-prompt",{detail:{prompt:${JSON.stringify(
      text,
    )}}}));true;`,
  );
};

export function CarPlayBridge({
  webview,
}: {
  webview: React.RefObject<WebView | null>;
}) {
  const listening = useRef(false);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let disposed = false;
    let transcriptSubscription: EmitterSubscription | undefined;
    try {
      const { CarPlay, ListTemplate } =
        require("react-native-carplay") as typeof import("react-native-carplay");
      const voice = NativeModules.StellaCarVoice as CarVoiceModule | undefined;
      const voiceEmitter = voice
        ? new NativeEventEmitter(NativeModules.StellaCarVoice)
        : null;
      let home: InstanceType<typeof ListTemplate> | null = null;
      const sections = (status: string) => [
        {
          header: "Cloud chat",
          items: [
            {
              text: listening.current ? "Stop and send" : "Talk to Stella",
              detailText: status,
            },
            {
              text: "Canonical cloud conversation",
              detailText:
                "Replies sync through Convex and work without a desktop awake.",
            },
          ],
        },
      ];
      const update = (status: string) => {
        home?.updateSections(sections(status));
      };
      const install = () => {
        if (disposed) return;
        home = new ListTemplate({
          title: "Stella",
          sections: sections("Tap to dictate a request."),
          async onItemSelect({ index }) {
            if (index !== 0 || !voice) return;
            if (listening.current) {
              listening.current = false;
              voice.stopListening();
              update("Sending to Stella…");
            } else {
              listening.current = true;
              voice.startListening();
              update("Listening… tap again to send.");
            }
          },
        });
        void CarPlay.setRootTemplate(home, false);
      };
      transcriptSubscription = voiceEmitter?.addListener(
        "StellaCarVoiceTranscript",
        ({ text }: CarVoiceTranscript) => {
          listening.current = false;
          const prompt = text?.trim();
          if (!prompt) {
            update("I didn't catch that. Tap to try again.");
            return;
          }
          update("Stella is working in the cloud…");
          dispatchTranscript(webview, prompt);
        },
      );
      CarPlay.registerOnConnect(install);
      if (CarPlay.connected) install();
      return () => {
        disposed = true;
        transcriptSubscription?.remove();
      };
    } catch {
      transcriptSubscription?.remove();
      return;
    }
  }, [webview]);
  return null;
}
