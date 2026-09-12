// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Modal } from "@/ui/modal";

/**
 * The keyboard contract for the in-house modal shell. These pin the parts a
 * screen-reader or keyboard-only user depends on and that are invisible in a
 * screenshot: the dialog role and name, where focus lands, that Tab cannot
 * leave the panel, that Escape closes the topmost dialog only, and that the
 * opener gets focus back.
 */

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });

describe("Modal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  const Harness = ({
    modal = true,
    label = "Test dialog",
  }: {
    modal?: boolean;
    label?: string;
  }) => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          data-testid="opener"
          onClick={() => setOpen(true)}
        >
          open
        </button>
        {open ? (
          <Modal
            modal={modal}
            label={label}
            onClose={() => setOpen(false)}
            backdropProps={{ "data-testid": "backdrop" }}
          >
            <h2 id="dialog-heading">Heading</h2>
            <button type="button" data-testid="first">
              first
            </button>
            <button type="button" data-testid="last">
              last
            </button>
          </Modal>
        ) : null}
      </>
    );
  };

  const openHarness = (props: Parameters<typeof Harness>[0] = {}) => {
    act(() => root.render(<Harness {...props} />));
    const opener = container.querySelector<HTMLButtonElement>(
      '[data-testid="opener"]',
    )!;
    opener.focus();
    act(() => opener.click());
    return opener;
  };

  const panel = () => container.querySelector<HTMLElement>('[role="dialog"]')!;

  it("marks the panel as a modal dialog with an accessible name", () => {
    openHarness();
    expect(panel()).not.toBeNull();
    expect(panel().getAttribute("aria-modal")).toBe("true");
    expect(panel().getAttribute("aria-label")).toBe("Test dialog");
  });

  it("prefers aria-labelledby / aria-describedby when ids are given", () => {
    act(() =>
      root.render(
        <Modal
          onClose={() => {}}
          labelledBy="title-id"
          label="ignored"
          describedBy="body-id"
        >
          <h2 id="title-id">Title</h2>
          <p id="body-id">Body</p>
        </Modal>,
      ),
    );
    expect(panel().getAttribute("aria-labelledby")).toBe("title-id");
    expect(panel().getAttribute("aria-describedby")).toBe("body-id");
    // A labelledby wins outright — two names would be ambiguous.
    expect(panel().getAttribute("aria-label")).toBeNull();
  });

  it("moves focus to the first tabbable element on open", () => {
    openHarness();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="first"]'),
    );
  });

  it("honours an explicit initial focus target", () => {
    const WithInitialFocus = () => {
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <Modal onClose={() => {}} label="x" initialFocusRef={ref}>
          <button type="button">first</button>
          <button type="button" ref={ref} data-testid="wanted">
            wanted
          </button>
        </Modal>
      );
    };
    act(() => root.render(<WithInitialFocus />));
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="wanted"]'),
    );
  });

  it("falls back to the panel when nothing inside is tabbable", () => {
    act(() =>
      root.render(
        <Modal onClose={() => {}} label="empty">
          <p>nothing to focus</p>
        </Modal>,
      ),
    );
    expect(document.activeElement).toBe(panel());
  });

  it("cycles Tab and Shift+Tab inside the panel", () => {
    openHarness();
    const first = container.querySelector<HTMLElement>(
      '[data-testid="first"]',
    )!;
    const last = container.querySelector<HTMLElement>('[data-testid="last"]')!;

    // Forward off the end wraps to the start.
    last.focus();
    press("Tab");
    expect(document.activeElement).toBe(first);

    // Backward off the start wraps to the end.
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("pulls focus back in when it has wandered outside the panel", () => {
    const opener = openHarness();
    opener.focus();
    press("Tab");
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="first"]'),
    );
  });

  it("closes on Escape and restores focus to the opener", () => {
    const opener = openHarness();
    press("Escape");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes when the backdrop itself is pressed, not the panel", () => {
    openHarness();
    const backdrop = container.querySelector<HTMLElement>(
      '[data-testid="backdrop"]',
    )!;
    act(() => {
      panel().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("inerts the rest of the page while open and restores it on close", () => {
    const sibling = document.createElement("div");
    sibling.id = "page-behind";
    document.body.appendChild(sibling);

    openHarness();
    expect(sibling.getAttribute("aria-hidden")).toBe("true");
    expect(sibling.hasAttribute("inert")).toBe(true);

    press("Escape");
    expect(sibling.hasAttribute("aria-hidden")).toBe(false);
    expect(sibling.hasAttribute("inert")).toBe(false);
    sibling.remove();
  });

  it("leaves the page live and untrapped when modal={false}", () => {
    const sibling = document.createElement("div");
    document.body.appendChild(sibling);
    const opener = openHarness({ modal: false });

    expect(panel().getAttribute("aria-modal")).toBeNull();
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(sibling.hasAttribute("inert")).toBe(false);

    // Tab is left to the browser, so focus may sit outside the panel.
    opener.focus();
    press("Tab");
    expect(document.activeElement).toBe(opener);

    // Escape and focus restore still apply.
    press("Escape");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    sibling.remove();
  });

  it("only closes the topmost dialog on Escape", () => {
    const closed: string[] = [];
    act(() =>
      root.render(
        <>
          <Modal onClose={() => closed.push("outer")} label="outer">
            <button type="button">outer button</button>
          </Modal>
          <Modal onClose={() => closed.push("inner")} label="inner">
            <button type="button">inner button</button>
          </Modal>
        </>,
      ),
    );
    press("Escape");
    expect(closed).toEqual(["inner"]);
  });
});
