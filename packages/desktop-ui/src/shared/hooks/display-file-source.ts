import { createContext } from "react";
export type DisplayFileSource = {
  key: string;
  read: (path: string, maxBytes?: number) => Promise<{
    bytes: Uint8Array; mimeType: string; truncated?: boolean;
  }>;
};
export const DisplayFileSourceContext = createContext<DisplayFileSource | null>(null);
