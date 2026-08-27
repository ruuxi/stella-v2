import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAction, useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { canvasShareBaseUrl } from "@/shared/lib/canvas-share";

export type PublishedCanvasShare = {
  url: string;
  slug: string;
  expiresAt: number;
};

export type SharedCanvasLink = {
  slug: string;
  url: string;
  title?: string;
  createdAt: number;
  expiresAt: number;
};

const canvasSharePublishRef = makeFunctionReference<
  "action",
  { html: string; title?: string },
  PublishedCanvasShare
>("data/canvas_shares_actions:publish");

const canvasShareRevokeRef = makeFunctionReference<
  "action",
  { slug: string },
  { revoked: boolean }
>("data/canvas_shares_actions:revoke");

const canvasShareListMineRef = makeFunctionReference<
  "query",
  Record<string, never>,
  SharedCanvasLink[]
>("data/canvas_shares:listMine");

export type CanvasShareContextValue = {

  baseUrl: string | null;
  publish: (args: {
    html: string;
    title?: string;
  }) => Promise<PublishedCanvasShare>;
  revoke: (args: { slug: string }) => Promise<void>;
  listMine: () => Promise<SharedCanvasLink[]>;

  version: number;
};

const CanvasShareContext = createContext<CanvasShareContextValue | null>(null);

export function CanvasShareProvider({ children }: { children: ReactNode }) {
  const convex = useConvex();
  const publishAction = useAction(canvasSharePublishRef);
  const revokeAction = useAction(canvasShareRevokeRef);
  const [version, setVersion] = useState(0);
  const baseUrl = useMemo(() => canvasShareBaseUrl(), []);

  const publish = useCallback(
    async (args: { html: string; title?: string }) => {
      const result = await publishAction(args);
      setVersion((current) => current + 1);
      return result;
    },
    [publishAction],
  );

  const revoke = useCallback(
    async ({ slug }: { slug: string }) => {
      await revokeAction({ slug });
      setVersion((current) => current + 1);
    },
    [revokeAction],
  );

  const listMine = useCallback(
    () => convex.query(canvasShareListMineRef, {}),
    [convex],
  );

  const value = useMemo<CanvasShareContextValue>(
    () => ({ baseUrl, publish, revoke, listMine, version }),
    [baseUrl, publish, revoke, listMine, version],
  );

  return (
    <CanvasShareContext.Provider value={value}>
      {children}
    </CanvasShareContext.Provider>
  );
}

export const useCanvasShare = (): CanvasShareContextValue | null =>
  useContext(CanvasShareContext);
