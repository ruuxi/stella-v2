import path from 'path'
import { spawn } from 'child_process'

export const SCHEDULE_SCRIPTS_DIRNAME = 'schedule-scripts'

export const scheduleScriptsDir = (stellaDataDir: string): string =>
  path.join(stellaDataDir, SCHEDULE_SCRIPTS_DIRNAME)

export const SCRIPT_RUN_TIMEOUT_MS = 30_000

export const SCRIPT_CAPTURE_BYTES = 16 * 1024

export type ScriptRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

const truncateOutput = (value: string): string => {
  if (value.length <= SCRIPT_CAPTURE_BYTES) {
    return value
  }
  const head = value.slice(0, SCRIPT_CAPTURE_BYTES)
  const dropped = value.length - SCRIPT_CAPTURE_BYTES
  return `${head}\n…[${dropped} bytes truncated]`
}

export const createScheduleScriptAuthEnv = (
  auth:
    | { baseUrl?: string | null; authToken?: string | null }
    | null
    | undefined,
): Record<string, string> | null => {
  const baseUrl = auth?.baseUrl?.trim() || null
  const authToken = auth?.authToken?.trim() || null
  if (!baseUrl || !authToken) return null
  return {
    STELLA_SITE_BASE_URL: baseUrl,
    STELLA_SITE_AUTH_TOKEN: authToken,
    STELLA_X_API_BASE_URL: baseUrl,
    STELLA_X_API_AUTH_TOKEN: authToken,
  }
}

export const runScheduleScript = (
  scriptPath: string,
  options?: {
    signal?: AbortSignal
    env?: Record<string, string>
  },
): Promise<ScriptRunResult> =>
  new Promise((resolve) => {
    const startedAt = Date.now()
    const bunExecutable = process.env.STELLA_BUN_PATH?.trim() || 'bun'
    const child = spawn(bunExecutable, ['run', scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        ...(options?.env ?? {}),
        STELLA_SCHEDULE_SCRIPT_PATH: scriptPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (
      exitCode: number,
      tail: { kind: 'exit' | 'kill' | 'error' } & {
        message?: string
      },
    ) => {
      if (settled) return
      settled = true
      const durationMs = Date.now() - startedAt
      const result: ScriptRunResult = {
        exitCode,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(
          tail.kind === 'error' && tail.message
            ? `${stderr}\n[spawn error: ${tail.message}]`
            : stderr,
        ),
        durationMs,
        timedOut,
      }
      resolve(result)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      if (stdout.length > SCRIPT_CAPTURE_BYTES * 2) {
        stdout = stdout.slice(0, SCRIPT_CAPTURE_BYTES * 2)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      if (stderr.length > SCRIPT_CAPTURE_BYTES * 2) {
        stderr = stderr.slice(0, SCRIPT_CAPTURE_BYTES * 2)
      }
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, SCRIPT_RUN_TIMEOUT_MS)
    timer.unref?.()

    const onAbort = () => {
      child.kill('SIGKILL')
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      finish(-1, { kind: 'error', message: error.message })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      const exitCode = typeof code === 'number' ? code : signal ? -1 : 0
      finish(exitCode, { kind: signal ? 'kill' : 'exit' })
    })
  })
