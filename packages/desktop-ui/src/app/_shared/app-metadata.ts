import type { ComponentType, SVGProps } from "react";

type AppSlot = "top" | "bottom";

type AppIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

export type AppMetadata = {

  id: string;

  label: string;

  icon: AppIcon;

  route: string;

  slot: AppSlot;

  order?: number;

  hideFromSidebar?: boolean;

  onActiveClick?: () => void;

  resolveClickRoute?: () => string;
};
