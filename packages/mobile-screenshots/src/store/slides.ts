export const slides = [
  {
    slug: "computer",
    title: "Your computer.\nFrom your phone.",
    subtitle: "Work with your apps and files.",
    background: "#182820",
    ink: "#f4f1e7",
    accent: "#c8deb5",
  },
  {
    slug: "browser",
    title: "Leave the browsing\nto Stella.",
    subtitle: "Find a place. Make a plan.",
    background: "#f4efdf",
    ink: "#293529",
    accent: "#a8ba79",
  },
  {
    slug: "shopping",
    title: "Let Stella\nhandle checkout.",
    subtitle: "You approve the purchase.",
    background: "#e7d3c8",
    ink: "#392926",
    accent: "#c16c55",
  },
  {
    slug: "memory",
    title: "It remembers\nwhat matters.",
    subtitle: "One conversation that keeps going.",
    background: "#23263c",
    ink: "#f3ecdf",
    accent: "#bdb7e7",
  },
] as const;

export const devices = {
  iphone: {
    label: "iPhone",
    width: 1242,
    height: 2688,
    group: "APP_IPHONE_65",
    platform: "ios",
  },
  ipad: {
    label: "iPad",
    width: 2064,
    height: 2752,
    group: "APP_IPAD_PRO_3GEN_129",
    platform: "ios",
  },
  android7: {
    label: "Android 7-inch tablet",
    width: 1080,
    height: 1920,
    group: "sevenInchScreenshots",
    platform: "android",
  },
  android10: {
    label: "Android 10-inch tablet",
    width: 1440,
    height: 2560,
    group: "tenInchScreenshots",
    platform: "android",
  },
  android: {
    label: "Android",
    width: 1080,
    height: 1920,
    group: "phoneScreenshots",
    platform: "android",
  },
} as const;
export type Device = keyof typeof devices;
