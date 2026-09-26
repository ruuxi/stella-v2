import { describe, expect, test } from "bun:test";
import {
  CHAT_APP_PATH,
  CHAT_FRAME_BOOT_SCRIPT,
  CHAT_FRAME_ID,
} from "@/app/chat/chat-frame-source";

/** Runs the inline boot script against a stubbed frame and location. */
const runBootScript = (hash: string, existingSrc: string | null = null) => {
  const attributes = new Map<string, string>();
  if (existingSrc !== null) attributes.set("src", existingSrc);
  const frame = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
  };
  const replaced: string[] = [];
  const document = {
    getElementById: (id: string) => (id === CHAT_FRAME_ID ? frame : null),
  };
  const window = {
    location: { hash, pathname: "/chat", search: "?ref=nav" },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => {
        replaced.push(url);
      },
    },
  };
  new Function("document", "window", CHAT_FRAME_BOOT_SCRIPT)(document, window);
  return { src: attributes.get("src") ?? null, replaced };
};

describe("chat frame boot script", () => {
  test("points the frame at the renderer during HTML parse", () => {
    expect(runBootScript("")).toEqual({ src: CHAT_APP_PATH, replaced: [] });
  });

  test("hands an OAuth one-time token to the frame and scrubs the address bar", () => {
    expect(runBootScript("#ott=abc123")).toEqual({
      src: `${CHAT_APP_PATH}#ott=abc123`,
      replaced: ["/chat?ref=nav"],
    });
  });

  test("ignores unrelated fragments", () => {
    expect(runBootScript("#section")).toEqual({
      src: CHAT_APP_PATH,
      replaced: [],
    });
  });

  test("never re-navigates a frame that already has a source", () => {
    expect(runBootScript("#ott=abc123", CHAT_APP_PATH)).toEqual({
      src: CHAT_APP_PATH,
      replaced: [],
    });
  });
});
