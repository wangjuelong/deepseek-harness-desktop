/**
 * Keyless built-artifact guard (the `dsh-workflow-worker-thread` built-worker
 * shape): plain `node` runs `lib/worker.cjs` and the bundle reaches its
 * real koffi requires. POSIX hosts prove the load path end to end through
 * the deterministic ole32 rejection and the real close lifecycle: the
 * terminal report is flushed before the worker exits. win32 skips (a real
 * dialog would open), where the win32-only smoke in win32-dialog.spec.ts
 * covers the source plane instead. Skips until a build produces the artifact.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

const builtWorker = fileURLToPath(new URL('../lib/worker.cjs', import.meta.url))

describe.skipIf(!existsSync(builtWorker) || process.platform === 'win32')('built dialog worker (lib/worker.cjs)', () => {
  it('loads under plain node, reports the native-surface failure, then exits only after the report', async () => {
    const child = spawn(process.execPath, [builtWorker], {
      env: { ...process.env, DSH_DIALOG_TITLE: 'Built-artifact guard' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const seen: Win32DialogWorkerMessage[] = []
    const first = await new Promise<Win32DialogWorkerMessage>((resolve, reject) => {
      child.on('message', (message: Win32DialogWorkerMessage) => {
        seen.push(message)
        resolve(message)
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        reject(new Error(`worker exited (${code}) before reporting`))
      })
    })
    expect(first.kind).toBe('error')
    expect((first as { kind: 'error'; message: string }).message).toMatch(/ole32|koffi/i)
    // The terminal message is flushed before the channel closes: the driver
    // settles on the report, and a worker that exits first drops it (the
    // "exited before reporting a result" failure class).
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('worker did not exit after reporting')) }, 10_000)
      child.once('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })
    expect(code).toBe(0)
    expect(seen).toHaveLength(1)
  }, 30_000)
})
