# Agent Note: Win32 选择器通过 koffi 的 `_Out_ str16 *` 读取显示名

Status: implemented

[English](2026-08-14-win32-dialog-str16-out-read.md) | 中文

## 问题

在打包的桌面应用（Electron 43）里，每次真实选择目录都会让选择器 worker 以退出码 134（SIGABRT）崩溃，driver 报 "win32 folder dialog worker exited (code 134) before reporting a result"。对话框能正常打开和关闭，但选中文件夹会杀死 worker。开发运行时（系统 Node）下同样的流程正常，因此打包版带着未测的缺陷发布：仓库的 win32 覆盖只走"打开并中止"路径，从不调用 `resultPath`。

崩溃点在 `win32-dialog-bindings.ts` 的 `readUtf16`：`GetDisplayName` 把路径以 `CoTaskMemAlloc` 分配的裸地址返回，绑定用 `koffi.view(address, 32768)` 读取——固定读取 32 KiB，远超实际分配大小。越界读在 Electron 的 V8 堆布局下踩到未映射页导致进程 abort；系统 Node 的堆恰好让尾部页面保持可读，因此同样的代码在开发环境从未崩溃。

## 决策

`win32-dialog-bindings.ts` 把 `GetDisplayName` 的输出参数从 `_Out_ void **` 改为 `_Out_ str16 *`。koffi 自行读取 NUL 结尾的缓冲区并返回普通 JS 字符串，同时负责 `CoTaskMemFree`。手写的 `readUtf16` 视图扫描辅助函数和绑定自己的 `CoTaskMemFree` 调用被删除；`resultPath` 直接使用字符串。

## 考虑过的替代方案

**`koffi.decode(address, 'str16')`。** 实测后否决：koffi 会把地址当作"指向字符串的指针"解引用，在真实 Windows 上以访问违例崩溃（这正是原代码手写读取的原因）。

**缩小固定视图（如 4 KiB）。** 否决：对长度未知的分配仍是越读；只是移动崩溃边界。

**逐 2 字节探测直到 NUL。** 否决：慢，且字符串恰好结束于页边界时 2 字节读取仍可能跨页。

## 后果

- 打包应用里真实选择恢复正常：worker 解析所选路径并干净退出；已在打包的 Electron 运行时下用自动化的真实选择端到端验证（`PICK RESULT: <path>`）。
- 中止路径不变，仍以 "native directory picker aborted" 收尾。
- 显示名内存现在由 koffi 管理；mocked-koffi 套件把槽位 5 的 `_Out_ str16 *` 建模为直接返回 JS 字符串，并断言不再有手动释放。

## 测试

- `win32-dialog-bindings.spec.ts` — fake COM 世界对槽位 5 直接写入 JS 字符串，断言 `freed` 保持为空。
- 打包树端到端：打包的 Electron 运行时打开选择器，通过真实选择（WM_SETTEXT + IDOK）驱动并返回所选路径；中止冒烟测试仍以 "native directory picker aborted" 拒绝。
