import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { desktopCapturer, systemPreferences } from 'electron'
import { runNativeHelper } from '../native-helper.js'

type ScreenCapturePermissionsModule = {
  hasScreenCapturePermission: () => boolean
  hasPromptedForPermission: () => boolean
  openSystemPreferences: () => Promise<void>
}

let _screenCapturePermissions: ScreenCapturePermissionsModule | null = null
const getScreenCapturePermissions = (): ScreenCapturePermissionsModule | null => {
  if (_screenCapturePermissions) return _screenCapturePermissions
  try {
    const require = createRequire(import.meta.url)
    _screenCapturePermissions = require('mac-screen-capture-permissions') as ScreenCapturePermissionsModule
  } catch {

  }
  return _screenCapturePermissions
}

export type MacPermissionKind = 'accessibility' | 'screen'
export type MacPermissionSettingsKind =
  | MacPermissionKind
  | 'full-disk-access'
  | 'microphone'
export type MicrophonePermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

const permissionCache = new Map<MacPermissionKind, boolean>()
const STELLA_BUNDLE_ID = 'com.stella.app'

const TCC_SERVICE_BY_KIND: Record<
  'accessibility' | 'screen' | 'microphone',
  string
> = {
  accessibility: 'Accessibility',
  screen: 'ScreenCapture',
  microphone: 'Microphone',
}

const checkAccessibility = (prompt: boolean): boolean =>
  systemPreferences.isTrustedAccessibilityClient(prompt)

const checkScreenRecordingViaElectron = (): boolean =>
  systemPreferences.getMediaAccessStatus('screen') === 'granted'

const checkScreenRecordingViaNativeModule = (): boolean | null => {
  const mod = getScreenCapturePermissions()
  if (!mod) return null
  try {
    return mod.hasScreenCapturePermission()
  } catch {
    return null
  }
}

const checkScreenRecording = (): boolean => {
  if (process.platform !== 'darwin') {
    return checkScreenRecordingViaElectron()
  }

  if (checkScreenRecordingViaElectron()) return true
  return checkScreenRecordingViaNativeModule() === true
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const registerStellaForScreenRecording = async () => {
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
  } catch {

  }
}

const requestScreenRecording = async (): Promise<boolean> => {
  await registerStellaForScreenRecording()

  const result = await runNativeHelper('screen_permission', ['request'], {
    timeout: 10_000,
  })

  if (result === 'granted') {
    return true
  }

  await delay(300)
  return checkScreenRecording()
}

const normalizeMicrophonePermissionStatus = (
  value: string,
): MicrophonePermissionStatus => {
  switch (value) {
    case 'not-determined':
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'unknown':
      return value
    default:
      return 'unknown'
  }
}

const runExecFile = (file: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: 5000,
        windowsHide: true,
      },
      (error) => {
        resolve(!error)
      },
    )
  })

export const getMicrophonePermissionStatus = (): MicrophonePermissionStatus => {
  try {
    return normalizeMicrophonePermissionStatus(
      systemPreferences.getMediaAccessStatus('microphone'),
    )
  } catch {
    return 'unknown'
  }
}

export type ResettableMacPermissionKind =
  | 'accessibility'
  | 'screen'
  | 'microphone'

export const resetMacPermission = async (
  kind: ResettableMacPermissionKind,
): Promise<boolean> => {
  if (process.platform !== 'darwin') return false

  const service = TCC_SERVICE_BY_KIND[kind]
  const ok = await runExecFile('tccutil', [
    'reset',
    service,
    STELLA_BUNDLE_ID,
  ])
  if (ok && (kind === 'accessibility' || kind === 'screen')) {
    permissionCache.delete(kind)
  }
  return ok
}

export const resetMacMicrophonePermissions = (): Promise<boolean> =>
  resetMacPermission('microphone')

export const hasMacPermission = (kind: MacPermissionKind, prompt = false): boolean => {
  if (process.platform !== 'darwin') return true

  const cached = permissionCache.get(kind)
  if (cached) return true

  let granted: boolean
  switch (kind) {
    case 'accessibility':
      granted = checkAccessibility(prompt)
      break
    case 'screen':
      granted = checkScreenRecording()
      break
  }

  if (granted) {
    permissionCache.set(kind, true)
  }

  return granted
}

export const clearPermissionCache = (kind?: MacPermissionKind) => {
  if (kind) {
    permissionCache.delete(kind)
  } else {
    permissionCache.clear()
  }
}

export type PermissionRequestResult = {
  granted: boolean
  alreadyGranted: boolean
}

export const requestMacPermission = async (kind: MacPermissionKind): Promise<PermissionRequestResult> => {
  if (process.platform !== 'darwin') return { granted: true, alreadyGranted: true }

  clearPermissionCache(kind)

  switch (kind) {
    case 'accessibility': {
      if (checkAccessibility(false)) return { granted: true, alreadyGranted: true }
      checkAccessibility(true)
      await delay(300)
      const granted = checkAccessibility(false)
      if (granted) permissionCache.set('accessibility', true)
      return { granted, alreadyGranted: false }
    }
    case 'screen': {
      if (checkScreenRecording()) return { granted: true, alreadyGranted: true }
      const granted = await requestScreenRecording()
      if (granted) permissionCache.set('screen', true)
      return { granted, alreadyGranted: false }
    }
  }
}
