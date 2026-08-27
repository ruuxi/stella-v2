import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthBootstrapState } from "@/global/auth/DesktopConvexAuthProvider";

const ModelCatalogUpdatedAtContext = createContext<number | null>(null);

let lastKnownCatalogUpdatedAt: number | null = null;

export function ModelCatalogUpdatedAtProvider({
  children,
}: {
  children: ReactNode;
}) {

  const { runtimeAuthReady } = useAuthBootstrapState();
  const updatedAt =
    (useQuery(
      api.stella_models.getModelCatalogUpdatedAt,
      runtimeAuthReady ? {} : "skip",
    ) as number | undefined) ?? null;

  if (updatedAt !== null) {
    lastKnownCatalogUpdatedAt = updatedAt;
  }

  const lastSentRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (updatedAt === null || lastSentRef.current === updatedAt) return;
    lastSentRef.current = updatedAt;
    void window.electronAPI?.system
      ?.setModelCatalogUpdatedAt?.({ updatedAt })
      ?.catch(() => undefined);
  }, [updatedAt]);

  return (
    <ModelCatalogUpdatedAtContext.Provider value={updatedAt}>
      {children}
    </ModelCatalogUpdatedAtContext.Provider>
  );
}

export function useModelCatalogUpdatedAt(): number | null {
  const value = useContext(ModelCatalogUpdatedAtContext);
  if (value !== null) lastKnownCatalogUpdatedAt = value;
  return value;
}

export function readModelCatalogUpdatedAtSnapshot(): number | null {
  return lastKnownCatalogUpdatedAt;
}
