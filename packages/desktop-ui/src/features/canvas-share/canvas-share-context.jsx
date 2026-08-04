/**
 * Wiring for the "canvas share" feature (publish a canvas to a public URL,
 * list your active shares, revoke them).
 *
 * The Convex function references are declared with `makeFunctionReference`
 * rather than reaching into the generated `api` object, so the desktop side
 * is decoupled from when the backend regenerates the shared API type — only
 * the module paths below need to match what the backend deploys.
 *
 * publish/revoke are Node ("use node") ACTIONS under `data/canvas_shares_actions`,
 * and listMine is a QUERY under `data/canvas_shares`.
 *
 * The provider is mounted once inside the main app tree under the Convex
 * provider. Consumers render nothing when `useCanvasShare()` returns `null`,
 * so shared canvas rendering remains safe outside that provider.
 *
 * Backend contract:
 *   publish({ html, title? }) -> { url, slug, expiresAt }   (action)
 *   revoke({ slug })          -> { revoked }                (action)
 *   listMine()                -> SharedCanvasLink[]          (query)
 */
import { createContext, useCallback, useContext, useMemo, useState, } from "react";
import { useAction, useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { canvasShareBaseUrl } from "@/shared/lib/canvas-share";
const canvasSharePublishRef = makeFunctionReference("data/canvas_shares_actions:publish");
const canvasShareRevokeRef = makeFunctionReference("data/canvas_shares_actions:revoke");
const canvasShareListMineRef = makeFunctionReference("data/canvas_shares:listMine");
const CanvasShareContext = createContext(null);
export function CanvasShareProvider({ children }) {
    const convex = useConvex();
    const publishAction = useAction(canvasSharePublishRef);
    const revokeAction = useAction(canvasShareRevokeRef);
    const [version, setVersion] = useState(0);
    const baseUrl = useMemo(() => canvasShareBaseUrl(), []);
    const publish = useCallback(async (args) => {
        const result = await publishAction(args);
        setVersion((current) => current + 1);
        return result;
    }, [publishAction]);
    const revoke = useCallback(async ({ slug }) => {
        await revokeAction({ slug });
        setVersion((current) => current + 1);
    }, [revokeAction]);
    const listMine = useCallback(() => convex.query(canvasShareListMineRef, {}), [convex]);
    const value = useMemo(() => ({ baseUrl, publish, revoke, listMine, version }), [baseUrl, publish, revoke, listMine, version]);
    return (<CanvasShareContext.Provider value={value}>
      {children}
    </CanvasShareContext.Provider>);
}
/**
 * Returns the canvas-share API, or `null` when rendered outside the provider.
 * Callers must no-op or hide UI on `null`.
 */
export const useCanvasShare = () => useContext(CanvasShareContext);
