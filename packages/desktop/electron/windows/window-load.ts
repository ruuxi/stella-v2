import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { isLowMemoryWindowsDevice } from '../resource-profile.js'
import { resolveRendererRoot } from '../renderer-location.js'
import type {
  ResolvedRendererEntrypoint,
  RendererEntryName,
} from '../services/renderer-artifact-service.js'

export type WindowLoadMode = 'full' | 'mini' | 'overlay' | 'pet'

export type PackagedRendererEntrypointResolver = (
  mode: RendererEntryName,
) => Promise<ResolvedRendererEntrypoint>

const getWindowEntryFile = (windowMode: WindowLoadMode) => {
  switch (windowMode) {
    case 'overlay':
      return 'overlay.html'
    case 'pet':
      return 'pet.html'
    case 'mini':
      return 'mini.html'
    case 'full':
    default:
      return 'index.html'
  }
}

const applyWindowQueryParams = (url: URL, windowMode: WindowLoadMode) => {
  url.searchParams.set('window', windowMode)
  if (isLowMemoryWindowsDevice()) {
    url.searchParams.set('lowPower', '1')
  }
}

export const getDevUrl = (
  windowMode: WindowLoadMode,
  getDevServerUrl: () => string,
) => {
  const url = new URL(getWindowEntryFile(windowMode), `${getDevServerUrl()}/`)
  applyWindowQueryParams(url, windowMode)
  return url.toString()
}

export const loadWindow = (
  window: BrowserWindow,
  options: {
    electronDir: string
    isDev: boolean
    mode: WindowLoadMode
    getDevServerUrl: () => string
    resolvePackagedEntrypoint?: PackagedRendererEntrypointResolver
    rendererReadinessToken?: string
  },
) => {
  if (options.isDev) {
    window.loadURL(getDevUrl(options.mode, options.getDevServerUrl))
    return
  }

  const loadFile = (filePath: string) =>
    window.loadFile(filePath, {
      query: {
        window: options.mode,
        ...(options.rendererReadinessToken
          ? { rendererReadiness: options.rendererReadinessToken }
          : {}),
        ...(isLowMemoryWindowsDevice() ? { lowPower: '1' } : {}),
      },
    })

  const loadBundledFallback = () => {
    const entryFile = getWindowEntryFile(options.mode)
    const candidates = [
      path.join(resolveRendererRoot(options.electronDir), entryFile),
      path.resolve(options.electronDir, '../dist', entryFile),
    ]
    const filePath =
      candidates.find((candidate) => {
        try {
          return fs.statSync(candidate).isFile()
        } catch {
          return false
        }
      }) ?? candidates[0]
    return loadFile(filePath)
  }

  if (!options.resolvePackagedEntrypoint) {
    void loadBundledFallback()
    return
  }

  void options
    .resolvePackagedEntrypoint(options.mode)
    .then((resolved) => {
      if (window.isDestroyed()) return
      return loadFile(resolved.filePath)
    })
    .catch((error) => {
      console.error(
        `[renderer-artifact] Failed to resolve ${options.mode}; loading bundled renderer:`,
        error,
      )
      if (window.isDestroyed()) return
      return loadBundledFallback()
    })
}
