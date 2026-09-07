// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WorkingIndicator } from "@/app/chat/WorkingIndicator";
vi.mock("@/shared/hooks/use-window-focus", () => ({ useWindowFocus: () => true }));
vi.mock("@/ui/stella-character/StellaCharacter", () => ({ StellaCharacter: ({ state }: { state: string }) => <span data-pose={state} /> }));
vi.mock("@/app/chat/SwapText", () => ({ SwapText: ({ text }: { text: string }) => <span>{text}</span> }));
it("shows a short tool immediately after dots and holds its label through the next thinking gap", () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<WorkingIndicator isReasoning reasoningSeed="turn" />));
    act(() => vi.advanceTimersByTime(20));
    act(() => root.render(<WorkingIndicator toolName="spawn_agent" toolCallId="call-1" />));
    expect(container.querySelector('.working-indicator')?.getAttribute('data-mode')).toBe('tool');
    const label = container.textContent;
    expect(label?.length).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(20));
    act(() => root.render(<WorkingIndicator isReasoning reasoningSeed="turn" />));
    expect(container.textContent).toBe(label);
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelector('.working-indicator')?.getAttribute('data-mode')).toBe('thinking');
  } finally { act(() => root.unmount()); vi.useRealTimers(); }
});
