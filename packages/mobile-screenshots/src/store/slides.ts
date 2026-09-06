export const slides = [
  {
    slug: "computer",
    title: "Your computer.\nFrom your phone.",
    subtitle: "Work with your apps and files.",
    background: "#f0ede6",
    ink: "#292922",
    accent: "#bab7ed",
  },
  {
    slug: "browser",
    title: "Leave the browsing\nto Stella.",
    subtitle: "Find a place. Make a plan.",
    background: "#e7ede5",
    ink: "#29392c",
    accent: "#a7b99c",
  },
  {
    slug: "shopping",
    title: "Let Stella\nhandle checkout.",
    subtitle: "You approve the purchase.",
    background: "#e9e5f1",
    ink: "#3b3149",
    accent: "#b9a8ce",
  },
  {
    slug: "memory",
    title: "It remembers\nwhat matters.",
    subtitle: "One conversation that keeps going.",
    background: "#f2e5da",
    ink: "#50372a",
    accent: "#d8af90",
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
  android: {
    label: "Android",
    width: 1080,
    height: 1920,
    group: "phoneScreenshots",
    platform: "android",
  },
} as const;
export type Device = keyof typeof devices;
