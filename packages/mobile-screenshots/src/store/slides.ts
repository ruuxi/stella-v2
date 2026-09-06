export const slides = [
  {
    slug: "assistant",
    captureSlug: "computer",
    title: "Your Personal\nAssistant",
    subtitle: "",
    background: "#faf9f7",
    ink: "#252525",
    accent: "#e7e5e2",
  },
  {
    slug: "browser",
    title: "Leave the browsing\nto Stella.",
    subtitle: "Find a place. Make a plan.",
    background: "#faf9f7",
    ink: "#252525",
    accent: "#e7e5e2",
  },
  {
    slug: "shopping",
    title: "Let Stella\nhandle checkout.",
    subtitle: "You approve the purchase.",
    background: "#faf9f7",
    ink: "#252525",
    accent: "#e7e5e2",
  },
  {
    slug: "memory",
    title: "It remembers\nwhat matters.",
    subtitle: "One conversation that keeps going.",
    background: "#faf9f7",
    ink: "#252525",
    accent: "#e7e5e2",
  },
  {
    slug: "computer",
    title: "Your computer.\nFrom your phone.",
    subtitle: "Work with your apps and files.",
    background: "#faf9f7",
    ink: "#252525",
    accent: "#e7e5e2",
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
