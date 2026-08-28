import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PetOverlayStatus } from "@stella/contracts/desktop/pet";
import type { VoiceRuntimeSnapshot } from "@/shared/types/electron";
import { StellaCharacter } from "@/ui/stella-character/StellaCharacter";
import { getPetCharacterState, type PetVoiceMode } from "./pet-character-state";
import "./pet-overlay.css";

const MASCOT_SIZE = 76;

const PET_DISPLAY_NAME = "Stella";

const DRAG_THRESHOLD_PX = 4;

const VOICE_OUTPUT_LEVEL_THRESHOLD = 0.02;
const ASSISTANT_BUBBLE_VISIBLE_MS = 4_000;

const derivePetVoiceMode = (
  state: VoiceRuntimeSnapshot | null | undefined,
  voiceActive: boolean,
): PetVoiceMode => {

  if (!voiceActive) return "idle";
  if (
    state?.isSpeaking ||
    (state?.outputLevel ?? 0) > VOICE_OUTPUT_LEVEL_THRESHOLD
  ) {
    return "speaking";
  }
  return "listening";
};

export type PetOverlayProps = {
  open: boolean;
  status: PetOverlayStatus;
  onClose: () => void;
};

type ContextMenuState = {
  left: number;
  top: number;
};

type BubbleSlots = { slots: [string, string]; active: 0 | 1 };

const PetBubbleMessage = ({ message }: { message: string }) => {
  const [{ slots, active }, setBubble] = useState<BubbleSlots>(() => ({
    slots: [message, ""],
    active: 0,
  }));

  if (slots[active] !== message) {
    const nextActive: 0 | 1 = active === 0 ? 1 : 0;
    const nextSlots: [string, string] = [...slots] as [string, string];
    nextSlots[nextActive] = message;
    setBubble({ slots: nextSlots, active: nextActive });
  }

  return (
    <div className="pet-overlay-bubble-message">
      <span
        className="pet-overlay-bubble-message-slot"
        data-active={active === 0 ? "true" : "false"}
      >
        {slots[0]}
      </span>
      <span
        className="pet-overlay-bubble-message-slot"
        data-active={active === 1 ? "true" : "false"}
      >
        {slots[1]}
      </span>
    </div>
  );
};

export const PetOverlay = ({
  open,
  status,
  onClose,
}: PetOverlayProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const voiceActiveRef = useRef(false);
  const [voiceMode, setVoiceMode] = useState<PetVoiceMode>("idle");
  const [assistantBubbleVisible, setAssistantBubbleVisible] = useState(true);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const applyVoiceActive = (nextActive: boolean) => {
      voiceActiveRef.current = nextActive;
      if (nextActive) {
        setVoiceMode((previous) =>
          previous === "idle" ? "listening" : previous,
        );
      } else {
        setVoiceMode("idle");
      }
    };
    const applyRuntimeState = (
      state: VoiceRuntimeSnapshot | null | undefined,
    ) => {
      setVoiceMode(derivePetVoiceMode(state, voiceActiveRef.current));
    };
    const ui = window.electronAPI?.ui;
    if (ui?.onState) {

      void ui.getState?.().then((state) => {
        applyVoiceActive(Boolean(state?.isVoiceRtcActive));
      });
      const off = ui.onState((state) => {
        applyVoiceActive(Boolean(state?.isVoiceRtcActive));
      });
      if (off) cleanups.push(off);
    }
    const voice = window.electronAPI?.voice;
    if (voice?.onRuntimeState) {
      void voice.getRuntimeState?.().then(applyRuntimeState);
      const off = voice.onRuntimeState(applyRuntimeState);
      if (off) cleanups.push(off);
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  useEffect(() => {
    if (!open) {
      window.electronAPI?.pet?.setInteractive?.(false);
      return;
    }
    let lastInteractive: boolean | null = null;
    const setInteractive = (next: boolean) => {
      if (lastInteractive === next) return;
      lastInteractive = next;
      window.electronAPI?.pet?.setInteractive?.(next);
    };
    const isInteractiveAtPoint = (clientX: number, clientY: number) => {
      const root = rootRef.current;
      if (!root) return false;
      const ownerDoc = root.ownerDocument ?? document;

      const stack = ownerDoc.elementsFromPoint(clientX, clientY);
      for (const node of stack) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest("[data-pet-hit=\"true\"]")) return true;
      }
      return false;
    };
    const handleMouseMove = (event: MouseEvent) => {
      setInteractive(isInteractiveAtPoint(event.clientX, event.clientY));
    };
    const handleMouseLeave = () => {
      setInteractive(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);
    document.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
      document.removeEventListener("mouseleave", handleMouseLeave);
      window.electronAPI?.pet?.setInteractive?.(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!contextMenu && !dragging) return;
    window.electronAPI?.pet?.setInteractive?.(true);
  }, [contextMenu, dragging, open]);

  const dragStateRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;

      if (target.closest("button")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStateRef.current = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      };
      setDragging(true);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.screenX - drag.startScreenX;
      const dy = event.screenY - drag.startScreenY;
      if (
        !drag.moved &&
        Math.abs(dx) < DRAG_THRESHOLD_PX &&
        Math.abs(dy) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      drag.moved = true;

      const newWindowX = event.screenX - drag.startClientX;
      const newWindowY = event.screenY - drag.startClientY;
      window.electronAPI?.pet?.moveWindow?.({
        x: newWindowX,
        y: newWindowY,
      });
    },
    [],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragStateRef.current = null;
      setDragging(false);
      if (drag.moved) {

        const newWindowX = event.screenX - drag.startClientX;
        const newWindowY = event.screenY - drag.startClientY;
        window.electronAPI?.pet?.moveWindow?.({
          x: newWindowX,
          y: newWindowY,
        });
      }
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {

      }
    },
    [],
  );

  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      setContextMenu({
        left: event.clientX - rect.left,
        top: event.clientY - rect.top,
      });
    },
    [],
  );

  useLayoutEffect(() => {
    if (!contextMenu) return;
    const node = contextMenuRef.current;
    const root = rootRef.current;
    if (!node || !root) return;
    const margin = 8;
    const rootRect = root.getBoundingClientRect();
    const menuRect = node.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let nextLeft = contextMenu.left;
    let nextTop = contextMenu.top;

    const absoluteRight = rootRect.left + nextLeft + menuRect.width;
    if (absoluteRight > viewportWidth - margin) {
      nextLeft = Math.max(
        margin - rootRect.left,
        nextLeft - menuRect.width,
      );
    }

    const absoluteBottom = rootRect.top + nextTop + menuRect.height;
    if (absoluteBottom > viewportHeight - margin) {
      nextTop = Math.max(
        margin - rootRect.top,
        nextTop - menuRect.height,
      );
    }

    if (nextLeft === contextMenu.left && nextTop === contextMenu.top) return;
    setContextMenu({ left: nextLeft, top: nextTop });
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const dismiss = () => setContextMenu(null);
    window.addEventListener("mousedown", handler);
    document.addEventListener("mouseleave", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("mousedown", handler);
      document.removeEventListener("mouseleave", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (status.state !== "idle" || !status.message.trim()) {
      setAssistantBubbleVisible(true);
      return;
    }

    setAssistantBubbleVisible(true);
    const timer = window.setTimeout(() => {
      setAssistantBubbleVisible(false);
    }, ASSISTANT_BUBBLE_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [status.message, status.state]);

  const handleClosePet = useCallback(() => {
    setContextMenu(null);
    onClose();
    window.electronAPI?.pet?.setOpen?.(false);
  }, [onClose]);

  if (!open) {
    return null;
  }

  const characterState = getPetCharacterState({
    state: status.state,
    voiceMode,
    dragging,
    hover,
  });
  const hasBubbleContent =
    Boolean(status.message?.trim()) || Boolean(status.title?.trim());
  const showBubble =
    hasBubbleContent && (status.state !== "idle" || assistantBubbleVisible);

  return (
    <div
      ref={rootRef}
      className="pet-overlay-root"
      data-dragging={dragging ? "true" : "false"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className="pet-overlay-mascot"
        data-dragging={dragging ? "true" : "false"}
        data-pet-hit="true"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onContextMenu={handleContextMenu}
        title={PET_DISPLAY_NAME}
      >
        <div
          className="pet-overlay-bubble"
          data-visible={showBubble ? "true" : "false"}
          data-pet-hit={showBubble ? "true" : "false"}
          aria-hidden={showBubble ? "false" : "true"}
        >
          <PetBubbleMessage message={status.message} />
        </div>
        <StellaCharacter
          className="pet-overlay-character"
          size={MASCOT_SIZE}
          state={characterState}
          shape="star"
          ink="aurora"
          glow
          followPointer
        />
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="pet-overlay-context-menu"
          data-pet-hit="true"
          style={{ left: contextMenu.left, top: contextMenu.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="pet-overlay-context-item pet-overlay-context-item-danger"
            onClick={handleClosePet}
          >
            Close pet
          </button>
        </div>
      )}
    </div>
  );
};
