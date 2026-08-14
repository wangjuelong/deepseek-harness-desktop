/**
 * Child-process entry for the Win32 folder dialog: blocks THIS process
 * inside the modal `Show` so the host event loop stays live, reporting over
 * the IPC channel. Spawned as a child process (not a worker thread) so the
 * dialog is the process's first window and Windows activates it without a
 * manual foreground call. Protocol: `{kind:'showing',threadId}` right
 * before the blocking call (the driver's abort lever needs the native
 * thread id), then exactly one of `{kind:'done',path}` or
 * `{kind:'error',message}`. The IPC channel closes only after the terminal
 * message is flushed: closing after `showing` would exit this process (see
 * the `disconnect` handler) before the outcome write is issued.
 */

import { loadWin32DialogBindings } from './win32-dialog-bindings.ts'
import { runFolderDialog } from './win32-dialog-logic.ts'

/** The driver-to-child payload: the dialog title (passed via env). */
export interface Win32DialogWorkerData { title: string }

/** One notice or outcome posted back to the driver. */
export type Win32DialogWorkerMessage =
  | { kind: 'showing'; threadId: number }
  | { kind: 'done'; path: string | null }
  | { kind: 'error'; message: string }

const title = process.env.DSH_DIALOG_TITLE ?? ''
if (title === '') throw new Error('win32-dialog-worker: DSH_DIALOG_TITLE is required')
if (process.send === undefined) throw new Error('win32-dialog-worker must run as a child process with an IPC channel')
// node's internal `send` reads `this.connected`, so bind the receiver.
const send = process.send.bind(process)

/** A terminal message: the conversation settled, or the surface failed. */
type Win32DialogWorkerOutcome = Exclude<Win32DialogWorkerMessage, { kind: 'showing'; threadId: number }>

/**
 * Post the `showing` notice. The channel stays open: the driver needs the
 * thread id while the dialog blocks, and the terminal outcome is still due.
 * @param threadId - the dialog thread's native id.
 */
const postShowing = (threadId: number): void => {
  send({ kind: 'showing', threadId })
}

/**
 * Post the terminal outcome, then close the channel once the message is
 * flushed — the `disconnect` handler below exits this process, and closing
 * before the write completes would drop the outcome the driver awaits.
 * @param message - the terminal `done` or `error` message.
 */
const postOutcome = (message: Win32DialogWorkerOutcome): void => {
  send(message, () => {
    if (process.connected) process.disconnect()
  })
}

// A settled driver (or a dead parent) must not orphan a dialog still on screen.
/* v8 ignore next 3 -- the handler exits(0), which would kill the unit lane; built-worker.e2e.ts owns the real disconnect lifecycle. */
process.on('disconnect', () => process.exit(0))

// No top-level await: the built worker ships as CJS, which cannot carry TLA.
void (async () => {
  try {
    const bindings = await loadWin32DialogBindings()
    const path = runFolderDialog(bindings, title, postShowing)
    postOutcome({ kind: 'done', path })
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    postOutcome({ kind: 'error', message })
  }
})()
