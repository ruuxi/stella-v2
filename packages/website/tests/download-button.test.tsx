import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LinuxInstallOptions } from "@/components/download-button";
import { INSTALL_COMMAND, RELEASE_ASSETS } from "@/lib/downloads";

describe("Linux download options", () => {
  const markup = renderToStaticMarkup(<LinuxInstallOptions />);

  test("offers the copyable one-line install command as the primary action", () => {
    expect(markup).toContain(INSTALL_COMMAND);
    expect(INSTALL_COMMAND).toBe(
      "curl -fsSL https://stella.sh/install.sh | sh",
    );
    expect(markup).toContain("Copy the Stella install command");

    // The command block is rendered before the raw asset links.
    expect(markup.indexOf("download-menu__install")).toBeLessThan(
      markup.indexOf("download-menu__option"),
    );
  });

  test("keeps the AppImage and Arch package as secondary links", () => {
    expect(markup).toContain('href="/download/linux"');
    expect(markup).toContain('href="/download/arch"');
    expect(markup).toContain("AppImage");
    expect(markup).toContain("Arch / Omarchy package");
  });

  test("the secondary links point at the published release aliases", () => {
    expect(RELEASE_ASSETS.linux).toContain("Stella-linux-x64.AppImage");
    expect(RELEASE_ASSETS.arch).toContain("Stella-arch-x64.pkg.tar.xz");
  });
});
