import {
  ChartColumn,
  CreditCard,
  MessageSquare,
  Palette,
  Settings,
} from "@/ui/icons";
import { CustomDevice as Device } from "@/ui/nav-icons";

export const SETTINGS_LOCATIONS = [
  "settings",
  "theme",
  "connect",
  "billing",
  "usage",
  "feedback",
];

export const isSettingsLocation = (value) =>
  value !== null && SETTINGS_LOCATIONS.includes(value);

export const SETTINGS_DESTINATIONS = [
  {
    id: "settings",
    label: "Settings",
    description: "General, shortcuts, memory, account, and audio",
    Icon: Settings,
  },
  {
    id: "theme",
    label: "Theme",
    description: "Appearance, gradients, and colors",
    Icon: Palette,
  },
  {
    id: "connect",
    label: "Connect",
    description: "Phone access and integrations",
    Icon: Device,
  },
  {
    id: "billing",
    label: "Plan & billing",
    description: "Upgrade or manage your Stella plan",
    Icon: CreditCard,
    signedInOnly: true,
  },
  {
    id: "usage",
    label: "Usage",
    description: "Local model usage and cost estimates",
    Icon: ChartColumn,
  },
  {
    id: "feedback",
    label: "Send feedback",
    description: "Tell us what is working and what could be better",
    Icon: MessageSquare,
  },
];

export const getVisibleSettingsDestinations = (hasConnectedAccount) =>
  SETTINGS_DESTINATIONS.filter(
    (item) => !item.signedInOnly || hasConnectedAccount,
  );
