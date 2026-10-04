import type { BrowserWindow } from 'electron'
import { isLowMemoryWindowsDevice } from '../resource-profile.js'
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
  options: { mode: WindowLoadMode },
) => {
  window.loadURL(getSourceUrl(options.mode))
}
