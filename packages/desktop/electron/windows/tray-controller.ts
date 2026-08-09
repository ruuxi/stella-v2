import { Menu, Tray, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'
import { onMainLocaleChanged, t } from '../services/i18n-service.js'

type TrayControllerOptions = {
  electronDir: string
  onShowWindow: () => void
  onQuit: () => void
}

export const resolveTrayIconPath = (
  electronDir: string,
  resourcesPath = process.resourcesPath,
): string | null => {
  // Compiled main lives at desktop/dist-electron/electron, so the desktop
  // package root is two levels up. Packaged builds copy the tray-specific ICO
  // beside app.asar because build/ is intentionally excluded from app files.
  const desktopRoot = path.resolve(electronDir, '..', '..')
  const packagesRoot = path.dirname(desktopRoot)
  const candidates = [
    path.join(resourcesPath, 'stella-tray.ico'),
    path.join(desktopRoot, 'build', 'icon.ico'),
    path.join(desktopRoot, 'build', 'icon.png'),
    path.join(packagesRoot, 'desktop-ui', 'dist', 'stella-app-icon.png'),
    path.join(packagesRoot, 'desktop-ui', 'public', 'stella-app-icon.png'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Windows system-tray presence so the app can keep running after the user
 * closes ("X") the main window. The tray icon restores the window on click
 * and exposes an explicit Quit — without that, hiding-on-close would strand
 * users with no way to either get the window back or fully exit.
 */
export class TrayController {
  private tray: Tray | null = null
  private hintShown = false
  private unsubscribeLocale: (() => void) | null = null

  constructor(private readonly options: TrayControllerOptions) {}

  /**
   * Tooltip + context menu in the active locale. Rebuilt whenever the user
   * switches language — Electron has no way to re-render an existing menu
   * template, so the whole menu is replaced.
   */
  private applyLocalizedChrome(tray: Tray) {
    tray.setToolTip(t('desktop.tray.tooltip'))
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: t('desktop.tray.openStella'),
          click: () => this.options.onShowWindow(),
        },
        { type: 'separator' },
        {
          label: t('desktop.tray.quitStella'),
          click: () => this.options.onQuit(),
        },
      ]),
    )
  }

  create(): Tray | null {
    if (this.tray && !this.tray.isDestroyed()) {
      return this.tray
    }

    const iconPath = resolveTrayIconPath(this.options.electronDir)
    let image = iconPath
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty()
    if (image.isEmpty()) {
      console.warn(
        `[tray] No usable tray icon (resolved: ${iconPath ?? 'none'}); the tray will render a blank glyph.`,
      )
    } else if (iconPath && !iconPath.endsWith('.ico')) {
      // .ico files carry proper 16px tray frames; a raw PNG fallback is the
      // full-size app icon and renders as a smeared blob in the tray unless
      // downscaled.
      image = image.resize({ width: 16, height: 16, quality: 'best' })
    }

    const tray = new Tray(image)
    this.applyLocalizedChrome(tray)
    this.unsubscribeLocale?.()
    this.unsubscribeLocale = onMainLocaleChanged(() => {
      if (tray.isDestroyed()) return
      this.applyLocalizedChrome(tray)
    })
    // Single click is the expected "bring it back" gesture on Windows; the
    // double-click is wired too so either habit works.
    tray.on('click', () => this.options.onShowWindow())
    tray.on('double-click', () => this.options.onShowWindow())

    this.tray = tray
    return tray
  }

  /**
   * Shown once per run the first time the user closes the window to the
   * tray, so the window "disappearing" doesn't read as a crash or a quit.
   */
  notifyMinimizedToTray() {
    if (this.hintShown) return
    this.hintShown = true
    if (!this.tray || this.tray.isDestroyed()) return
    if (process.platform !== 'win32') return
    this.tray.displayBalloon({
      title: t('desktop.tray.balloon.title'),
      content: t('desktop.tray.balloon.content'),
    })
  }

  destroy() {
    this.unsubscribeLocale?.()
    this.unsubscribeLocale = null
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy()
    }
    this.tray = null
  }
}
