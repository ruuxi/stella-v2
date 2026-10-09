import { Doto, Fredoka, Martian_Mono, Mona_Sans, Silkscreen } from "next/font/google";

export const mona = Mona_Sans({
  variable: "--l-sans",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  preload: true,
});

export const martian = Martian_Mono({
  variable: "--l-mono",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  preload: false,
});

export const doto = Doto({
  variable: "--l-doto",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

export const silkscreen = Silkscreen({
  variable: "--l-pixel",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  preload: false,
});

export const fredoka = Fredoka({
  variable: "--l-round",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  preload: false,
});

export const landingFontVars = [
  mona.variable,
  martian.variable,
  doto.variable,
  silkscreen.variable,
  fredoka.variable,
].join(" ");
