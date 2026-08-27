import { existsSync } from 'node:fs'
import path from 'node:path'

const __dirname = import.meta.dirname
const platformDir = process.platform === 'win32'
  ? 'win32'
  : process.platform === 'darwin'
    ? 'darwin'
    : process.platform

const resolvedHelperPaths = new Map<string, string>()

const NEGATIVE_CACHE_TTL_MS = 30_000
const missingHelperUntil = new Map<string, number>()

export const invalidateNativeHelperPathCache = (): void => {
  missingHelperUntil.clear()
}

export const resolveNativeHelperPath = (baseName: string): string | null => {
  const cached = resolvedHelperPaths.get(baseName)
  if (cached !== undefined) {
    return cached
  }

  const missingUntil = missingHelperUntil.get(baseName)
  if (missingUntil !== undefined && Date.now() < missingUntil) {
    return null
  }

  const ext = process.platform === 'win32' ? '.exe' : ''
  const fileName = `${baseName}${ext}`
  const candidates = [

    path.join(process.resourcesPath, 'native', 'out', platformDir, fileName),

    path.join(__dirname, '..', '..', '..', 'native', 'out', platformDir, fileName),

    path.join(__dirname, '..', '..', 'native', 'out', platformDir, fileName),

    path.join(__dirname, '..', 'native', 'out', platformDir, fileName),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      missingHelperUntil.delete(baseName)
      resolvedHelperPaths.set(baseName, candidate)
      return candidate
    }
  }

  missingHelperUntil.set(baseName, Date.now() + NEGATIVE_CACHE_TTL_MS)
  return null
}
