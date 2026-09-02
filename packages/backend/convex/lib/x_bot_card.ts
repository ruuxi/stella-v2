// The image the X bot attaches to its reply. X charges link posts, so the
// address lives here rather than in the text. The layout mirrors the site:
// the Open Graph aura on the right with the homepage's mini chat window on
// top of it, and the headline plus address on the left.
//
// This module only builds the element tree; `x_bot.ts` renders it with
// Satori and resvg. Satori supports a flexbox-only CSS subset, so every
// container declares `display: flex` explicitly.

import type { XBotExchange } from "./x_bot";

export const X_BOT_CARD_WIDTH = 1600;
export const X_BOT_CARD_HEIGHT = 900;

export type XBotCardInput = {
  headline: string;
  handle: string;
  exchanges: XBotExchange[];
  logoDataUri: string;
};

export type XBotCardFontFamily = "display" | "sans";

type Style = Record<string, string | number>;

export type XBotCardNode = {
  type: string;
  props: {
    style?: Style;
    src?: string;
    width?: number;
    height?: number;
    children?: XBotCardNode | XBotCardNode[] | string;
  };
};

const INK = "#0f1728";
const MUTED = "#44546c";
const BORDER = "rgba(82, 104, 134, 0.18)";
// Pearl theme of the site's mini chat mock (home-desktop-mock.tsx).
const CHAT_PRIMARY = "#2563eb";
const CHAT_USER_BUBBLE = "#e5edfc";
const CHAT_USER_BORDER = "rgba(37, 99, 235, 0.18)";
const CHAT_TEXT = "rgba(17, 17, 17, 0.95)";
const CHAT_TEXT_WEAK = "rgba(17, 17, 17, 0.5)";

export const X_BOT_CARD_FONT_FAMILIES: Record<XBotCardFontFamily, string> = {
  display: "Cormorant Garamond",
  sans: "Manrope",
};

const el = (
  type: string,
  style: Style,
  children?: XBotCardNode | XBotCardNode[] | string,
): XBotCardNode => ({
  type,
  props: { style, ...(children === undefined ? {} : { children }) },
});

const text = (
  value: string,
  style: Style,
): XBotCardNode => el("div", { display: "flex", ...style }, value);

const aura = (): XBotCardNode[] => [
  el("div", {
    position: "absolute",
    right: -120,
    top: -160,
    width: 900,
    height: 720,
    borderRadius: 9999,
    backgroundImage:
      "radial-gradient(closest-side, rgba(99,212,255,0.34), rgba(79,118,255,0.20) 45%, rgba(79,118,255,0.06) 78%, rgba(255,255,255,0) 100%)",
  }),
  el("div", {
    position: "absolute",
    right: 60,
    top: 380,
    width: 640,
    height: 520,
    borderRadius: 9999,
    backgroundImage:
      "radial-gradient(closest-side, rgba(123,245,219,0.24), rgba(123,245,219,0.08) 60%, rgba(255,255,255,0) 100%)",
  }),
];

const trafficLight = (color: string, left: number): XBotCardNode =>
  el("div", {
    position: "absolute",
    top: 15,
    left,
    width: 12,
    height: 12,
    borderRadius: 9999,
    backgroundColor: color,
    border: "0.5px solid rgba(0,0,0,0.14)",
  });

const userBubble = (value: string): XBotCardNode =>
  el(
    "div",
    {
      display: "flex",
      alignSelf: "flex-end",
      maxWidth: "82%",
      padding: "10px 18px",
      border: `1px solid ${CHAT_USER_BORDER}`,
      borderRadius: "22px 22px 8px 22px",
      backgroundColor: CHAT_USER_BUBBLE,
      color: CHAT_TEXT,
      fontFamily: X_BOT_CARD_FONT_FAMILIES.sans,
      fontSize: 21,
      lineHeight: 1.5,
      letterSpacing: "0.01em",
    },
    value,
  );

const assistantRow = (value: string): XBotCardNode =>
  el(
    "div",
    {
      display: "flex",
      alignSelf: "flex-start",
      maxWidth: "90%",
      color: CHAT_TEXT,
      fontFamily: X_BOT_CARD_FONT_FAMILIES.sans,
      fontSize: 21,
      lineHeight: 1.7,
      letterSpacing: "0.02em",
    },
    value,
  );

const composer = (): XBotCardNode =>
  el(
    "div",
    {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: "auto",
      height: 56,
      padding: "0 18px 0 22px",
      borderRadius: 16,
      border: "1px solid #e8e8e8",
      backgroundColor: "#ffffff",
      color: CHAT_TEXT_WEAK,
      fontFamily: X_BOT_CARD_FONT_FAMILIES.sans,
      fontSize: 19,
    },
    [
      text("Ask Stella anything", { color: CHAT_TEXT_WEAK }),
      el("div", {
        display: "flex",
        width: 34,
        height: 34,
        borderRadius: 9999,
        backgroundColor: CHAT_PRIMARY,
      }),
    ],
  );

const chatWindow = (exchanges: XBotExchange[]): XBotCardNode =>
  el(
    "div",
    {
      position: "relative",
      display: "flex",
      flexDirection: "column",
      width: 620,
      height: 700,
      overflow: "hidden",
      borderRadius: 18,
      // No box-shadow: satori turns shadows into SVG blur filters, which cost
      // resvg seconds per layer at this size. The border does the lifting.
      border: "1.5px solid rgba(15, 23, 40, 0.16)",
      backgroundColor: "#ffffff",
    },
    [
      trafficLight("#ff5f57", 18),
      trafficLight("#ffbd2e", 40),
      trafficLight("#28c840", 62),
      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          gap: 18,
          flexGrow: 1,
          padding: "64px 26px 24px 26px",
        },
        [
          ...exchanges.flatMap((exchange) => [
            userBubble(exchange.user),
            assistantRow(exchange.stella),
          ]),
          composer(),
        ],
      ),
    ],
  );

const brandMark = (logoDataUri: string): XBotCardNode =>
  el("div", { display: "flex", alignItems: "center", gap: 14 }, [
    {
      type: "img",
      props: { src: logoDataUri, width: 48, height: 48 },
    },
    text("Stella", {
      fontFamily: X_BOT_CARD_FONT_FAMILIES.display,
      fontWeight: 300,
      fontSize: 46,
      letterSpacing: "-0.06em",
      lineHeight: 1,
      color: INK,
    }),
  ]);

export const buildXBotCardTree = (input: XBotCardInput): XBotCardNode =>
  el(
    "div",
    {
      position: "relative",
      display: "flex",
      width: X_BOT_CARD_WIDTH,
      height: X_BOT_CARD_HEIGHT,
      overflow: "hidden",
      backgroundColor: "#ffffff",
      color: INK,
    },
    [
      ...aura(),
      el(
        "div",
        {
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: X_BOT_CARD_WIDTH,
          height: X_BOT_CARD_HEIGHT,
          padding: "72px 88px 64px 88px",
        },
        [
          el(
            "div",
            {
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              width: 720,
              height: 772,
            },
            [
              el("div", { display: "flex", flexDirection: "column", gap: 28 }, [
                brandMark(input.logoDataUri),
                text(input.headline, {
                  fontFamily: X_BOT_CARD_FONT_FAMILIES.display,
                  fontWeight: 300,
                  fontSize: 78,
                  lineHeight: 1.02,
                  letterSpacing: "-0.03em",
                  color: INK,
                }),
                text(
                  "Stella is a desktop assistant that works inside your apps, browser, files, and terminal. You watch every step and approve anything that matters.",
                  {
                    fontFamily: X_BOT_CARD_FONT_FAMILIES.sans,
                    fontSize: 23,
                    lineHeight: 1.5,
                    color: MUTED,
                    maxWidth: 640,
                  },
                ),
              ]),
              el(
                "div",
                {
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  paddingTop: 28,
                  borderTop: `1px solid ${BORDER}`,
                },
                [
                  text("Your plan and the free download", {
                    fontFamily: X_BOT_CARD_FONT_FAMILIES.sans,
                    fontSize: 19,
                    letterSpacing: "0.02em",
                    color: MUTED,
                  }),
                  text(`stella.sh/x/${input.handle}`, {
                    fontFamily: X_BOT_CARD_FONT_FAMILIES.display,
                    fontWeight: 400,
                    fontSize: 60,
                    lineHeight: 1,
                    letterSpacing: "-0.03em",
                    color: INK,
                  }),
                ],
              ),
            ],
          ),
          chatWindow(input.exchanges),
        ],
      ),
    ],
  );
