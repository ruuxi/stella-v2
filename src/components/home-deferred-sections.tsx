"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";

const HomeSingleChat = lazy(() =>
  import("./home-single-chat").then((module) => ({ default: module.HomeSingleChat })),
);
const HomeComputerUse = lazy(() =>
  import("./home-computer-use").then((module) => ({ default: module.HomeComputerUse })),
);
const HomePhoneConnectors = lazy(() =>
  import("./home-phone-connectors").then((module) => ({
    default: module.HomePhoneConnectors,
  })),
);
const HomeDocuments = lazy(() =>
  import("./home-documents").then((module) => ({ default: module.HomeDocuments })),
);
const HomeOpenPrivate = lazy(() =>
  import("./home-open-private").then((module) => ({ default: module.HomeOpenPrivate })),
);

function DeferredSection({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setActive(true);
        observer.disconnect();
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="home-deferred-slot">
      {active ? <Suspense fallback={null}>{children}</Suspense> : null}
    </div>
  );
}

export function HomeDeferredSections() {
  return (
    <>
      <DeferredSection><HomeSingleChat /></DeferredSection>
      <DeferredSection><HomeComputerUse /></DeferredSection>
      <DeferredSection><HomePhoneConnectors /></DeferredSection>
      <DeferredSection><HomeDocuments /></DeferredSection>
      <DeferredSection><HomeOpenPrivate /></DeferredSection>
    </>
  );
}
