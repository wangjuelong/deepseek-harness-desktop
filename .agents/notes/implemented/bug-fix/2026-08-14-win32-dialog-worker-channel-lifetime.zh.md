# Agent Note: Win32 对话框 worker 只在终态消息之后关闭 IPC 通道

Status: implemented

[English](2026-08-14-win32-dialog-worker-channel-lifetime.md) | 中文

## 问题

Windows 上每次选择工作区目录都会失败，报错 "win32 folder dialog worker exited before reporting a result"（经 RPC 网关包装后变成双重前缀的 "directory picker failed: …"）：对话框正常打开并关闭，但 driver 从未收到结果。

worker 唯一的 `post` 辅助函数在**每条**消息后都关闭 IPC 通道——其 `process.send` 冲刷回调会调用 `process.disconnect()`，而模块的 `disconnect` 处理器会退出进程。`showing` 通知发出后，子进程阻塞在模态 `Show` 中；用户选择或取消后事件循环恢复，`showing` 写入的完成回调先运行，在终态 `done`/`error` 写入——排在在途 `showing` 写入之后的队列里——发出之前就断开通道并退出（code 0）。driver 看到 `showing` 后跟着 `exit`，于是拒绝本次选择。该失败是确定性的，不是竞态：冲刷回调与排队中的结果写入在同一轮事件循环中被处理，而断开并退出发生在排队的写入发出之前。

已交付的验证无法发现它：win32 冒烟测试打开对话框后用中止将其关闭，而中止路径由 driver 自己的拒绝来收尾，结果消息在那里从不重要；POSIX 覆盖只发一条消息（`error`），掩盖了"首条消息后即关闭"的策略。

## 决策

`packages/host/directory-picker-native/src/win32-dialog-worker.ts` 现在把两种协议角色分开（协议设计见[子进程选择器 Note](../feature/2026-08-02-win32-in-process-folder-dialog.md)）。`postShowing` 发送通知，不带冲刷回调；`postOutcome` 发送终态消息，并且只在冲刷回调里关闭通道，其参数类型被限定为仅结果联合，因此通过它发送 `showing` 会编译失败。`disconnect` 处理器仍是"父进程死亡即防孤儿"的守卫：driver 已死时不能让模态对话框留在屏幕上。driver 的"静默退出"错误现在携带退出码，因此自退出（0）与原生崩溃（非零）可以区分。

## 考虑过的替代方案

**保留单一 `post` 辅助函数并加 `last` 布尔参数。** 否决：终态与通知之分是协议的脊梁，普通布尔默认值朝向危险方向；两个具名函数加上仅结果的参数类型让这种错误在编译期就无法表达。

**让 driver 容忍 `showing` 之后的退出。** 否决：终态消息就是契约；driver 无法区分"结果已送达"与"结果丢失"，只要结果写入在退出竞态中落败，选择仍然每次失败。

**不主动断开、让子进程自行滞留。** 否决：打开的 IPC 通道会让子进程的事件循环保持存活，终态消息发出后进程永远不会退出。

## 后果

- Windows 选择恢复可用：结果写入在通道关闭前已冲刷，driver 依据 `done`/`error` 收尾，之后的 `exit` 事件成为惰性事件。
- win32 中止冒烟测试重新变得确定：`done(null)` 结果在退出前送达而不是与之竞速，因此中止总是以 "native directory picker aborted" 收尾。
- 通道生命周期策略在所有主机上都被测试固定（见测试一节）；父进程死亡防孤儿守卫与中止关闭预算行为不变。

## 测试

- `win32-dialog-bindings.spec.ts` — 新增回归测试对 `process.disconnect` spy 调用冲刷回调，断言 `post:showing → post:done → disconnect`；该断言在修复前的 worker 上恰好失败（`post:showing` 之后紧跟 `disconnect`）。
- `built-worker.e2e.ts` — 断言普通 node 下真实构建的 worker 在退出前已冲刷其报告（退出码 0，且没有第二条消息）。
- `win32-dialog.spec.ts` — 静默退出断言更新为携带退出码的消息。
- 仅 win32 的"打开并用中止关闭"冒烟测试在真实 Windows 上通过修复后的代码。
