import { execFile } from 'node:child_process'
import type { ActiveBrowserTab } from '@stella/contracts/desktop/home'

type ScriptDialect = 'chromium' | 'safari'

type BrowserSpec = {
  bundleId: string
  displayName: string
  dialect: ScriptDialect
}

const KNOWN_BROWSERS: BrowserSpec[] = [
  { bundleId: 'com.google.Chrome', displayName: 'Chrome', dialect: 'chromium' },
  {
    bundleId: 'com.google.Chrome.beta',
    displayName: 'Chrome Beta',
    dialect: 'chromium',
  },
  {
    bundleId: 'com.google.Chrome.dev',
    displayName: 'Chrome Dev',
    dialect: 'chromium',
  },
  {
    bundleId: 'com.google.Chrome.canary',
    displayName: 'Chrome Canary',
    dialect: 'chromium',
  },
  { bundleId: 'com.brave.Browser', displayName: 'Brave', dialect: 'chromium' },
  {
    bundleId: 'com.brave.Browser.beta',
    displayName: 'Brave Beta',
    dialect: 'chromium',
  },
  {
    bundleId: 'com.brave.Browser.nightly',
    displayName: 'Brave Nightly',
    dialect: 'chromium',
  },
  {
    bundleId: 'company.thebrowser.Browser',
    displayName: 'Arc',
    dialect: 'chromium',
  },
  {
    bundleId: 'company.thebrowser.dia',
    displayName: 'Dia',
    dialect: 'chromium',
  },
  {
    bundleId: 'com.microsoft.edgemac',
    displayName: 'Edge',
    dialect: 'chromium',
  },
  {
    bundleId: 'com.vivaldi.Vivaldi',
    displayName: 'Vivaldi',
    dialect: 'chromium',
  },
  {
    bundleId: 'org.chromium.Chromium',
    displayName: 'Chromium',
    dialect: 'chromium',
  },
  {
    bundleId: 'com.operasoftware.Opera',
    displayName: 'Opera',
    dialect: 'chromium',
  },
  { bundleId: 'com.kagi.kagimacOS', displayName: 'Orion', dialect: 'chromium' },
  { bundleId: 'com.apple.Safari', displayName: 'Safari', dialect: 'safari' },
  {
    bundleId: 'com.apple.SafariTechnologyPreview',
    displayName: 'Safari Technology Preview',
    dialect: 'safari',
  },
]

const BUNDLE_ID_TO_BROWSER = new Map(
  KNOWN_BROWSERS.map((spec) => [spec.bundleId, spec] as const),
)

const ACTIVE_TAB_CACHE_MS = 1_500
const activeTabCache = new Map<
  string,
  { expiresAt: number; value: ActiveBrowserTab | null }
>()
const activeTabInFlight = new Map<string, Promise<ActiveBrowserTab | null>>()

const buildScript = (spec: BrowserSpec): string => {

  if (spec.dialect === 'chromium') {
    return `tell application id "${spec.bundleId}"
  if not (exists window 1) then return ""
  set theTab to active tab of window 1
  return (URL of theTab) & (ASCII character 1) & (title of theTab)
end tell`
  }
  return `tell application id "${spec.bundleId}"
  if not (exists window 1) then return ""
  set theTab to current tab of window 1
  return (URL of theTab) & (ASCII character 1) & (name of theTab)
end tell`
}

const runOsascript = (
  script: string,
  timeoutMs: number,
): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', script],
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(typeof stdout === 'string' ? stdout : null)
      },
    )
  })

const queryBrowserMac = async (
  spec: BrowserSpec,
): Promise<ActiveBrowserTab | null> => {
  const stdout = await runOsascript(buildScript(spec), 1_500)
  if (!stdout) return null

  const trimmed = stdout.trim()
  if (!trimmed) return null

  const [url, ...titleParts] = trimmed.split('\u0001')
  const cleanUrl = url?.trim() ?? ''
  if (!cleanUrl) return null

  if (
    cleanUrl.startsWith('chrome://') ||
    cleanUrl.startsWith('chrome-extension://') ||
    cleanUrl.startsWith('about:') ||
    cleanUrl.startsWith('brave://') ||
    cleanUrl.startsWith('edge://') ||
    cleanUrl.startsWith('arc://') ||
    cleanUrl.startsWith('vivaldi://')
  ) {
    return null
  }

  const title = titleParts.join('\u0001').trim() || undefined

  return {
    browser: spec.displayName,
    bundleId: spec.bundleId,
    url: cleanUrl,
    title,
  }
}

export const getActiveBrowserTabForBundleId = async (
  bundleId: string | null | undefined,
): Promise<ActiveBrowserTab | null> => {
  if (process.platform !== 'darwin') return null
  if (!bundleId) return null
  const spec = BUNDLE_ID_TO_BROWSER.get(bundleId)
  if (!spec) return null
  const now = Date.now()
  const cached = activeTabCache.get(bundleId)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  const inFlight = activeTabInFlight.get(bundleId)
  if (inFlight) {
    return await inFlight
  }
  const promise = queryBrowserMac(spec)
  activeTabInFlight.set(bundleId, promise)
  try {
    const value = await promise
    activeTabCache.set(bundleId, {
      expiresAt: Date.now() + ACTIVE_TAB_CACHE_MS,
      value,
    })
    return value
  } finally {
    activeTabInFlight.delete(bundleId)
  }
}

export const isKnownBrowserBundleId = (
  bundleId: string | null | undefined,
): boolean => Boolean(bundleId && BUNDLE_ID_TO_BROWSER.has(bundleId))
