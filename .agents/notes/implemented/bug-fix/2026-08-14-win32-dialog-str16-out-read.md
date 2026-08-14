# Agent Note: Win32 picker reads display-name strings through koffi's `_Out_ str16 *`

Status: implemented

English | [中文](2026-08-14-win32-dialog-str16-out-read.zh.md)

## Problem

In the packaged desktop app (Electron 43), every real directory selection crashed the picker worker with exit code 134 (SIGABRT) and the driver reported "win32 folder dialog worker exited (code 134) before reporting a result". The dialog opened and closed normally, but selecting a folder killed the worker. Under the development runtime (system Node) the same flow worked, so the packaged failure shipped untested: the repo's win32 coverage only exercised the open-and-abort path, which never calls `resultPath`.

The crash site was `readUtf16` in `win32-dialog-bindings.ts`: `GetDisplayName` surfaces the path as a raw `CoTaskMemAlloc`'d address, and the binding read it with `koffi.view(address, 32768)` — a fixed 32 KiB view of memory far larger than the actual allocation. The over-read crossed into an unmapped page under Electron's V8 heap layout and aborted the process; system Node's heap happened to keep the tail pages readable, which is why the same code never crashed in development.

## Decision

`win32-dialog-bindings.ts` declares `GetDisplayName`'s out parameter as `_Out_ str16 *` instead of `_Out_ void **`. koffi then reads the NUL-terminated buffer itself and returns a plain JS string, owning the `CoTaskMemFree`. The manual `readUtf16` view-and-scan helper and the binding's own `CoTaskMemFree` call are deleted; `resultPath` uses the string directly.

## Alternatives considered

**`koffi.decode(address, 'str16')`.** Rejected after empirical testing: koffi dereferences the address as a pointer-to-string, crashing with an access violation on real Windows (the reason the original code hand-rolled the read).

**Shrink the fixed view (e.g. 4 KiB).** Rejected: still an over-read of an unknown-length allocation; only moves the crash boundary.

**Byte-pair probing reads until NUL.** Rejected: slow, and a 2-byte read can still cross a page boundary when the string ends at one.

## Consequences

- Real selections work in the packaged app: the worker resolves the picked path and exits cleanly; verified end to end under the packaged Electron runtime with an automated real selection (`PICK RESULT: <path>`).
- The abort path is unchanged and still settles on "native directory picker aborted".
- koffi owns display-name memory now; the mocked-koffi suite models `_Out_ str16 *` as a direct JS string and asserts no manual frees.

## Testing

- `win32-dialog-bindings.spec.ts` — the fake COM world writes the path as a JS string for slot 5 and asserts `freed` stays empty.
- Packaged-tree end-to-end: the picker opened by the packaged Electron runtime, driven through a real selection (WM_SETTEXT + IDOK) returns the picked path; the abort smoke still rejects with "native directory picker aborted".
