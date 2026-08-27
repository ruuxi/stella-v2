import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolveNativeHelperPath } from './native-helper-path.js'
import { getFileLogger } from '@stella/runtime/observability/file-logger'

type DaemonChild = ChildProcessByStdio<Writable, Readable, null>

const REQUEST_TIMEOUT_MS = 2_000

const MAX_CONSECUTIVE_FAILURES = 3
const DISABLE_COOLDOWN_MS = 60_000

const EARLY_EXIT_MS = 1_000
const UNSUPPORTED_COOLDOWN_MS = 30 * 60_000

const MAX_PENDING = 64

const IDLE_EVICT_MS = 3 * 60_000

type PendingRequest = {
  resolve: (value: string | undefined) => void
  timer: ReturnType<typeof setTimeout>
}

class LineDelimitedHelperDaemon {
  private child: DaemonChild | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private stdoutBuf = ''
  private consecutiveFailures = 0
  private disabledUntil = 0
  private childSpawnedAt = 0
  private childAnswered = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly helperName: string,
    private readonly supportedPlatforms: ReadonlySet<NodeJS.Platform>,
  ) {}

  private armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null

      if (this.pending.size === 0) this.kill()
    }, IDLE_EVICT_MS)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private ensureChild(): DaemonChild | null {
    if (this.child) return this.child
    if (Date.now() < this.disabledUntil) return null

    const helperPath = resolveNativeHelperPath(this.helperName)
    if (!helperPath) return null

    let child: DaemonChild
    try {
      child = spawn(helperPath, ['--serve'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      this.noteFailure()
      return null
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))

    child.stdin.on('error', () => {})
    child.on('exit', () => this.onChildGone())
    child.on('error', () => this.onChildGone())

    this.child = child
    this.childSpawnedAt = Date.now()
    this.childAnswered = false

    this.armIdleTimer()
    getFileLogger()?.process('native.helper.daemon.started', {
      helper: this.helperName,
    })
    return child
  }

  private onChildGone() {
    const spawnedAt = this.childSpawnedAt
    const answered = this.childAnswered
    this.child = null
    this.stdoutBuf = ''
    this.childSpawnedAt = 0
    this.childAnswered = false

    this.clearIdleTimer()

    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(undefined)
    }
    this.pending.clear()

    if (!answered && spawnedAt > 0 && Date.now() - spawnedAt < EARLY_EXIT_MS) {
      this.disabledUntil = Date.now() + UNSUPPORTED_COOLDOWN_MS
      getFileLogger()?.process('native.helper.daemon.unsupported', {
        helper: this.helperName,
        cooldownMs: UNSUPPORTED_COOLDOWN_MS,
      })
    }
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk
    let newlineIdx = this.stdoutBuf.indexOf('\n')
    while (newlineIdx >= 0) {
      const line = this.stdoutBuf.slice(0, newlineIdx)
      this.stdoutBuf = this.stdoutBuf.slice(newlineIdx + 1)
      this.handleLine(line)
      newlineIdx = this.stdoutBuf.indexOf('\n')
    }
  }

  private handleLine(rawLine: string) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const tab = line.indexOf('\t')
    if (tab < 0) return
    const id = Number(line.slice(0, tab))
    if (!Number.isFinite(id)) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.consecutiveFailures = 0
    this.childAnswered = true
    pending.resolve(line.slice(tab + 1))
  }

  private noteFailure() {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.disabledUntil = Date.now() + DISABLE_COOLDOWN_MS
      this.consecutiveFailures = 0
      getFileLogger()?.warn('native.helper.daemon.disabled', {
        helper: this.helperName,
        cooldownMs: DISABLE_COOLDOWN_MS,
      })
      this.kill()
    }
  }

  private kill() {
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.kill()
      } catch {

      }
    }
    this.onChildGone()
  }

  request(tokens: string[]): Promise<string | undefined> {
    if (!this.supportedPlatforms.has(process.platform)) {
      return Promise.resolve(undefined)
    }
    if (this.pending.size >= MAX_PENDING) return Promise.resolve(undefined)

    const child = this.ensureChild()
    if (!child || !child.stdin.writable) return Promise.resolve(undefined)

    this.armIdleTimer()

    const id = this.nextId++
    const payload = `${id}\t${tokens.join('\t')}\n`

    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)

        this.noteFailure()
        this.kill()
        resolve(undefined)
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, timer })

      try {
        child.stdin.write(payload)
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        this.noteFailure()
        resolve(undefined)
      }
    })
  }

  stop() {
    this.disabledUntil = 0
    this.consecutiveFailures = 0
    this.kill()
  }
}

const windowInfoDaemon = new LineDelimitedHelperDaemon(
  'window_info',
  new Set<NodeJS.Platform>(['win32', 'darwin']),
)
const recentAppsDaemon = new LineDelimitedHelperDaemon(
  'recent_apps',
  new Set<NodeJS.Platform>(['win32']),
)

export const requestWindowInfoDaemon = (
  tokens: string[],
): Promise<string | undefined> => windowInfoDaemon.request(tokens)

export const requestRecentAppsDaemon = (
  tokens: string[],
): Promise<string | undefined> => recentAppsDaemon.request(tokens)

export const stopNativeHelperDaemons = (): void => {
  windowInfoDaemon.stop()
  recentAppsDaemon.stop()
}
