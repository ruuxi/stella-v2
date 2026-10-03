import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import cormorantLight from "@fontsource/cormorant-garamond/files/cormorant-garamond-latin-300-normal.woff";
import cormorantRegular from "@fontsource/cormorant-garamond/files/cormorant-garamond-latin-400-normal.woff";
import manropeRegular from "@fontsource/manrope/files/manrope-latin-400-normal.woff";
import manropeMedium from "@fontsource/manrope/files/manrope-latin-500-normal.woff";
import manropeSemibold from "@fontsource/manrope/files/manrope-latin-600-normal.woff";
import satori, { init as initSatori, type Font } from "satori/standalone";
import yogaWasm from "satori/yoga.wasm";
import {
  buildXBotCardTree,
  X_BOT_CARD_FONT_FAMILIES,
  X_BOT_CARD_HEIGHT,
  X_BOT_CARD_WIDTH,
} from "./card-tree";
import { X_BOT_LOGO_DATA_URI } from "./logo";
import type { XBotReplyPlan } from "./mentions";

const FONTS: Font[] = [
  {
    name: X_BOT_CARD_FONT_FAMILIES.display,
    data: cormorantLight,
    weight: 300,
    style: "normal",
  },
  {
    name: X_BOT_CARD_FONT_FAMILIES.display,
    data: cormorantRegular,
    weight: 400,
    style: "normal",
  },
  {
    name: X_BOT_CARD_FONT_FAMILIES.sans,
    data: manropeRegular,
    weight: 400,
    style: "normal",
  },
  {
    name: X_BOT_CARD_FONT_FAMILIES.sans,
    data: manropeMedium,
    weight: 500,
    style: "normal",
  },
  {
    name: X_BOT_CARD_FONT_FAMILIES.sans,
    data: manropeSemibold,
    weight: 600,
    style: "normal",
  },
];

let ready: Promise<void> | null = null;
const ensureWasm = (): Promise<void> => {
  ready ??= Promise.all([initSatori(yogaWasm), initWasm(resvgWasm)]).then(
    () => undefined,
  );
  return ready;
};

export const renderXBotCard = async (input: {
  headline: string;
  handle: string;
  exchanges: XBotReplyPlan["exchanges"];
}): Promise<Uint8Array<ArrayBuffer>> => {
  await ensureWasm();
  // Satori types its input as a React element; the template builds the same
  // plain {type, props} shape without pulling React into the bundle.
  const element = buildXBotCardTree({
    ...input,
    logoDataUri: X_BOT_LOGO_DATA_URI,
  }) as unknown as Parameters<typeof satori>[0];
  const svg = await satori(element, {
    width: X_BOT_CARD_WIDTH,
    height: X_BOT_CARD_HEIGHT,
    fonts: FONTS,
  });
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: X_BOT_CARD_WIDTH },
    background: "#ffffff",
  });
  // Copy into a fresh ArrayBuffer-backed view so it can feed Blob and FormData.
  return new Uint8Array(rendered.render().asPng());
};
