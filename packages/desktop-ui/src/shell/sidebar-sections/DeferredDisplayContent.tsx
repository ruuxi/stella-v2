import { useEffect, useState, type ReactNode } from "react";

export const DeferredDisplayContent = ({
  render,
}: {
  render: () => ReactNode;
}) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return ready ? render() : null;
};
