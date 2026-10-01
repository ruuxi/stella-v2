import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { isLowMemoryWindowsDevice } from '../resource-profile.js'
import { resolveRendererRoot } from '../renderer-location.js'
import { RENDERER_ORIGIN } from '../source/origin.js'

export type WindowLoadMode = 'full' | 'overlay' | 'companion' | 'companion-panel'

const getWindowEntryFile = (windowMode: WindowLoadMode) => {
  switch (windowMode) {
    case 'overlay':
      return 'overlay.html'
    case 'companion':
    case 'companion-panel':
      return 'companion.html'
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

/** The renderer served from source (see `source/renderer-source.ts`). */
export const getSourceUrl = (windowMode: WindowLoadMode) => {
  const url = new URL(getWindowEntryFile(windowMode), `${RENDERER_ORIGIN}/`)
  applyWindowQueryParams(url, windowMode)
  return url.toString()
}

export const loadWindow = (
  window: BrowserWindow,
  options: {
    electronDir: string
    isDev: boolean
    mode: WindowLoadMode
  },
) => {
  if (options.isDev) {
    window.loadURL(getSourceUrl(options.mode))
    return
  }

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
  window.loadFile(filePath, {
    query: {
      window: options.mode,
      ...(isLowMemoryWindowsDevice() ? { lowPower: '1' } : {}),
    },
  })
}
