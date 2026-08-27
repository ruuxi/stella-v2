import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toDataURL: vi.fn(),
  createPairing: vi.fn(),
  removePhone: vi.fn(),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: mocks.toDataURL },
}));

vi.mock("@/global/integrations/ConnectHeroAnimation", () => ({
  ConnectHeroAnimation: () => <div data-testid="connect-hero" />,
}));

vi.mock("@/global/settings/hooks/use-phone-access-controller", () => ({
  usePhoneAccessController: () => ({
    hasConnectedAccount: true,
    desktopDeviceId: "desktop-device",
    deviceLoadError: null,
    activePairing: null,
    qrDataUrl: null,
    pairedDevices: [],
    isCreating: false,
    removingMobileDeviceId: null,
    createPairing: mocks.createPairing,
    removePhone: mocks.removePhone,
  }),
}));

import { PhoneAccessConnectCard } from "@/global/settings/PhoneAccessCard";
import { LocalI18nProvider } from "@/shared/i18n";

describe("phone access store selector", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.toDataURL.mockImplementation((url: string) =>
      Promise.resolve(`data:image/png,${encodeURIComponent(url)}`),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <LocalI18nProvider>
          <PhoneAccessConnectCard />
        </LocalI18nProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("generates both store QRs and switches the visible code by platform", async () => {
    const options = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".connect-store-option"),
    );
    const [iosOption, androidOption] = options;

    expect(options.map((option) => option.textContent)).toEqual([
      "iOS",
      "Android",
    ]);
    expect(
      options.every((option) => option.querySelector("svg") !== null),
    ).toBe(true);
    expect(mocks.toDataURL).toHaveBeenCalledWith(
      "https://apps.apple.com/us/app/stella-your-ai/id6761148311",
      expect.any(Object),
    );
    expect(mocks.toDataURL).toHaveBeenCalledWith(
      "https://play.google.com/store/apps/details?id=com.fromyou.stella",
      expect.any(Object),
    );

    expect(iosOption?.getAttribute("aria-pressed")).toBe("true");
    expect(androidOption?.getAttribute("aria-pressed")).toBe("false");
    expect(
      container.querySelector<HTMLImageElement>(".connect-pair-qr")?.alt,
    ).toBe("Scan to download Stella from the App Store");

    await act(async () => androidOption?.click());

    expect(iosOption?.getAttribute("aria-pressed")).toBe("false");
    expect(androidOption?.getAttribute("aria-pressed")).toBe("true");
    const androidQr =
      container.querySelector<HTMLImageElement>(".connect-pair-qr");
    expect(androidQr?.alt).toBe("Scan to download Stella from Google Play");
    expect(androidQr?.src).toContain(
      encodeURIComponent(
        "https://play.google.com/store/apps/details?id=com.fromyou.stella",
      ),
    );
  });
});
