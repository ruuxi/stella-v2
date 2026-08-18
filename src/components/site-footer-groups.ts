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
      { label: "Install for Linux", href: "/download/linux" },
      { label: "Install for Arch / Omarchy", href: "/download/arch" },
    ],
  },
  {
    title: "Community",
    items: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];
