import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";

export type MediaTabItem = {
  id: string;
  asset: Extract<DisplayPayload, { kind: "media" }>["asset"];
  prompt?: string;
  capability?: string;
  createdAt: number;
};
