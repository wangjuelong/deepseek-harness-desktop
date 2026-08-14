# Agent Note: Win32 dialog worker closes the IPC channel only after the terminal message

Status: implemented

English | [中文](2026-08-14-win32-dialog-worker-channel-lifetime.zh.md)

## Problem

Every Windows workspace-directory selection failed with "win32 folder dialog worker exited before reporting a result" (surfaced doubled as "directory picker failed: …" by the RPC gateway): the dialog opened and closed normally, but the driver never received the outcome.

The worker's single `post` helper closed the IPC channel after **every** message — its `process.send` flush callback ran `process.disconnect()`, and the module's `disconnect` handler exits the process. After the `showing` notice, the child blocks inside the modal `Show`; when the user picks or dismisses, the event loop resumes and the `showing` write's completion callback runs first, disconnecting and exiting (code 0) before the terminal `done`/`error` write — queued behind the in-flight `showing` write — is issued. The driver observes `showing` then `exit` and rejects. The failure is deterministic, not a race: the flush callback and the queued outcome write are serviced in the same loop turn, and the disconnect-and-exit runs before the queued write is issued.

The shipped verification could not see it: the win32 smoke opens the dialog and abort-closes it, and the abort path settles through the driver's own rejection, so the outcome message never matters there; POSIX coverage posts exactly one message (`error`), which masks a close-after-first-post policy.

## Decision

`packages/host/directory-picker-native/src/win32-dialog-worker.ts` now separates the two protocol roles (see the [child-process picker note](../feature/2026-08-02-win32-in-process-folder-dialog.md) for the protocol's design). `postShowing` sends the notice with no flush callback; `postOutcome` sends the terminal message and closes the channel only in the flush callback, and its parameter is typed as the outcome-only union, so posting `showing` through it is a compile error. The `disconnect` handler stays the parent-death orphan guard: a dead driver must not leave a modal dialog on screen. The driver's silent-exit error now carries the exit code, so a self-exit (0) is distinguishable from a native crash (non-zero).

## Alternatives considered

**One `post` helper with a `last` boolean.** Rejected: the terminal-versus-notice distinction is the protocol's spine, and a plain boolean defaults to the dangerous direction; two named functions plus the outcome-only parameter type make the mistake unrepresentable.

**Have the driver tolerate exit-after-`showing`.** Rejected: the terminal message is the contract; the driver cannot tell a delivered outcome from a lost one, and the pick would still fail whenever the outcome write loses the race to the exit.

**Leave the child lingering without disconnecting.** Rejected: the open IPC channel keeps the child's loop alive, so the process never exits after the terminal message.

## Consequences

- Windows selection works again: the outcome write is flushed before the channel closes, so the driver settles on `done`/`error` and the later `exit` event is inert.
- The win32 abort smoke is deterministic again: the `done(null)` outcome is delivered before exit instead of racing it, so the abort always settles on "native directory picker aborted".
- The channel-lifetime policy is pinned by tests on every host (see Testing); the parent-death orphan guard and the abort close-budget behavior are unchanged.

## Testing

- `win32-dialog-bindings.spec.ts` — a new regression test invokes the flush callback against a `process.disconnect` spy and asserts `post:showing → post:done → disconnect`; this exact assertion fails against the pre-fix worker with `disconnect` right after `post:showing`.
- `built-worker.e2e.ts` — asserts the real built worker under plain node flushes its report before exiting (exit code 0, no second message).
- `win32-dialog.spec.ts` — silent-exit assertions updated for the coded message.
- The win32-only open-and-abort-close smoke passes on real Windows with the fix.
