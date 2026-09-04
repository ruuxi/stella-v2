// @vitest-environment jsdom
// Exercise the native component's layout/animation contract; native drawing is
// verified in Simulator when its build is available.
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BubbleMorphProvider,
  MorphingAssistantBubble,
  useBubbleMorphSource,
} from "../../../../mobile/src/components/BubbleMorph";

vi.mock(
  "../../../../mobile/node_modules/react",
  async () => await import("react"),
);

const native = vi.hoisted(() => ({
  reduced: false,
  height: 100,
  timing: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  hide: vi.fn(),
}));
vi.mock("../../../../mobile/node_modules/react-native", () => {
  function View({
    children,
    onLayout,
  }: {
    children?: ReactNode;
    onLayout?: (event: unknown) => void;
  }) {
    useLayoutEffect(() => {
      onLayout?.({
        nativeEvent: { layout: { width: 280, height: native.height } },
      });
    }, [onLayout]);
    return <div>{children}</div>;
  }
  return {
    View,
    StyleSheet: { absoluteFill: {} },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    Easing: { out: (value: unknown) => value, cubic: "cubic" },
    Animated: {
      View,
      Value: class {
        interpolate() {
          return 0;
        }
      },
      timing: native.timing,
    },
  };
});
vi.mock("../../../../mobile/node_modules/expo-linear-gradient", () => ({
  LinearGradient: () => <div />,
}));
vi.mock("../../../../mobile/node_modules/react-native-reanimated", () => ({
  useReducedMotion: () => native.reduced,
}));
vi.mock("../../../../mobile/src/theme/theme-context", () => ({
  useColors: () => ({
    assistantBubbleFillTop: "#eee",
    assistantBubbleFillBottom: "#ddd",
  }),
}));

function Source() {
  const morph = useBubbleMorphSource();
  useLayoutEffect(() => {
    if (morph) morph.source = { width: 44, height: 38, hide: native.hide };
  }, [morph]);
  return null;
}

describe("native bubble handoff", () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = (reply: boolean, animate = true) =>
    act(() =>
      root.render(
        <BubbleMorphProvider>
          <Source />
          {reply && (
            <MorphingAssistantBubble animate={animate} style={{}}>
              A native reply
            </MorphingAssistantBubble>
          )}
        </BubbleMorphProvider>,
      ),
    );
  beforeEach(() => {
    native.reduced = false;
    native.height = 100;
    native.timing
      .mockReset()
      .mockReturnValue({ start: native.start, stop: native.stop });
    native.hide.mockClear();
    native.stop.mockClear();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("takes over once and runs its 240ms animation on the native driver", () => {
    render(false);
    render(true);
    expect(native.hide).toHaveBeenCalledTimes(1);
    expect(native.timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        duration: 240,
        useNativeDriver: true,
      }),
    );
    render(true);
    expect(native.hide).toHaveBeenCalledTimes(1);
    expect(native.timing).toHaveBeenCalledTimes(1);
  });

  it.each(["history", "reduced", "long"])("skips the morph for %s", (kind) => {
    native.reduced = kind === "reduced";
    native.height = kind === "long" ? 2000 : 100;
    render(false);
    render(true, kind !== "history");
    expect(native.timing).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A native reply");
  });

  it("stops the morph if content changes height", () => {
    render(false);
    render(true);
    native.height = 180;
    render(true);
    expect(native.stop).toHaveBeenCalled();
    expect(container.textContent).toContain("A native reply");
  });
});
