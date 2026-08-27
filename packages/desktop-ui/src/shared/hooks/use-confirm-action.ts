import { useCallback, useEffect, useRef, useState } from "react";

export const useConfirmAction = (
  action: () => void,
  { armedMs = 3000 }: { armedMs?: number } = {},
): { armed: boolean; trigger: () => void; reset: () => void } => {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clear();
    setArmed(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  const trigger = useCallback(() => {
    if (!armed) {
      clear();
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), armedMs);
      return;
    }
    reset();
    action();
  }, [action, armed, armedMs, clear, reset]);

  return { armed, trigger, reset };
};
