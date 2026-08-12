export type FooterLink = {
  label: string;
  href: string;
  external?: boolean;
};

export type FooterGroup = {
  title: string;
  items: FooterLink[];
};

export const chromeExtensionLink: FooterLink = {
  label: "Chrome Extension",
  href: "https://chromewebstore.google.com/detail/stella-browser/kfnchfpocpmdblhfgcnpfaaebaioojnl",
  external: true,
};

export const openSourceFooterItems: FooterLink[] = [
  {
    label: "GitHub",
    href: "https://github.com/ruuxi/stella-v2",
    external: true,
  },
];

export const homeFooterGroups: FooterGroup[] = [
  {
    title: "Product",
    items: [
      { label: "Learn More", href: "/learn-more" },
      { label: "Storage", href: "/storage" },
      { label: "Agents", href: "/agents" },
      { label: "Voice", href: "/voice" },
      { label: "Pricing", href: "/pricing" },
      { label: "Sign In", href: "/sign-in" },
    ],
  },
  {
    title: "Resources",
    items: [
      { label: "What's New", href: "/learn-more/whats-new" },
      chromeExtensionLink,
      { label: "Install for macOS", href: "/install.sh" },
      { label: "Install for Windows", href: "/install.ps1" },
    ],
  },
  {
    title: "Open Source",
    items: openSourceFooterItems,
  },
  {
    title: "Community",
    items: [
      { label: "Store", href: "/store" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];
