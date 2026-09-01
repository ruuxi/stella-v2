import { describe, expect, it } from "vitest";
import {
  MIN_COMPOSER_SHELL_HEIGHT_PX,
  resolveComposerShellHeight,
} from "@/shared/hooks/use-animated-composer-shell";

describe("animated composer shell height", () => {
  it("never collapses when a hidden surface reports zero or invalid height", () => {
    expect(resolveComposerShellHeight(0, 0)).toBe(
      MIN_COMPOSER_SHELL_HEIGHT_PX,
    );
    expect(resolveComposerShellHeight(Number.NaN, 82)).toBe(82);
    expect(resolveComposerShellHeight(0, 82)).toBe(82);
  });

  it("accepts real form and expanded-content measurements", () => {
    expect(resolveComposerShellHeight(46, 0)).toBe(46);
    expect(resolveComposerShellHeight(128, 46)).toBe(128);
  });
});
