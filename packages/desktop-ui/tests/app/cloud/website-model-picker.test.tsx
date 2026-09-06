// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCloudExecutionSelectionSnapshot,
  resetCloudExecutionSelectionForTests,
} from "@/features/cloud/cloud-execution-store";
import { WebsiteModelPicker } from "@/global/settings/WebsiteModelPicker";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  selected: vi.fn(),
  execution: {
    engine: "stella",
    provider: "stella",
    model: "stella/first",
    reasoningEffort: "high",
  },
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => ({ execution: mocks.execution }),
  useMutation: () => mocks.save,
}));
vi.mock("@/shared/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("@/global/settings/hooks/use-model-catalog", () => ({
  useModelCatalog: () => ({ groups: [], models: [], refresh: vi.fn() }),
}));
vi.mock("@/global/settings/ProviderModelPanel", () => ({
  ProviderModelPanel: (props: { value: string; disabled: boolean; onSelect: (id: string) => void }) => (
    <button disabled={props.disabled} onClick={() => props.onSelect("stella/second")}>
      {props.value}
    </button>
  ),
}));

describe("website model selection", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    resetCloudExecutionSelectionForTests();
    mocks.save.mockReset();
    mocks.selected.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<WebsiteModelPicker onSelected={mocks.selected} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCloudExecutionSelectionForTests();
  });

  it("persists the route and publishes it for immediate sends before the query catches up", async () => {
    let saved!: () => void;
    mocks.save.mockReturnValue(new Promise<void>((resolve) => { saved = resolve; }));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("button")!.disabled).toBe(true);
    expect(getCloudExecutionSelectionSnapshot()).toBeNull();
    await act(async () => saved());
    const expected = { ...mocks.execution, model: "stella/second" };
    expect(mocks.save).toHaveBeenCalledWith({ execution: expected });
    expect(getCloudExecutionSelectionSnapshot()).toEqual(expected);
    expect(container.textContent).toBe("stella/second");
    expect(mocks.selected).toHaveBeenCalledOnce();
  });

  it("keeps the existing route and allows retry when saving fails", async () => {
    mocks.save.mockRejectedValue(new Error("Unable to save model"));
    await act(async () => container.querySelector("button")!.click());
    expect(getCloudExecutionSelectionSnapshot()).toBeNull();
    expect(container.querySelector("button")!.textContent).toBe("stella/first");
    expect(container.querySelector("button")!.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Unable to save model");
    expect(mocks.selected).not.toHaveBeenCalled();
  });
});
