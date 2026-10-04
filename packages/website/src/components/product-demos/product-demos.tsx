"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { SelfModificationPoster } from "./self-mod-poster";

function DeferredSelfModificationShowcase() {
  const [LoadedShowcase, setLoadedShowcase] = useState<ComponentType | null>(null);
  const loadedRef = useRef<ComponentType | null>(null);
  const loadingRef = useRef(false);

  const activate = useCallback(() => {
    if (loadedRef.current || loadingRef.current) return;
    loadingRef.current = true;

    void import("./self-mod-showcase").then((mod) => {
      loadedRef.current = mod.SelfModificationShowcase;
      startTransition(() => {
        setLoadedShowcase(() => mod.SelfModificationShowcase);
      });
    });
  }, []);

  useEffect(() => {
    const requestIdle = window.requestIdleCallback?.bind(window);
    const cancelIdle = window.cancelIdleCallback?.bind(window);
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    let idleId: number | undefined;

    if (requestIdle) {
      idleId = requestIdle(() => {
        activate();
      }, { timeout: 1800 });
    } else {
      timeoutId = globalThis.setTimeout(() => {
        activate();
      }, 1200);
    }

    return () => {
      if (idleId !== undefined && cancelIdle) {
        cancelIdle(idleId);
      }
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId);
      }
    };
  }, [activate]);

  return (
    <div
      onPointerEnter={() => activate()}
      onFocusCapture={() => activate()}
      onTouchStart={() => activate()}
      onClickCapture={() => activate()}
    >
      {LoadedShowcase ? <LoadedShowcase /> : <SelfModificationPoster />}
    </div>
  );
}

export function SelfModDemo() {
  return <DeferredSelfModificationShowcase />;
}
