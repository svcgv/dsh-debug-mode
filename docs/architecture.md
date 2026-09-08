# 架构规范

## 目标形态

`dsh-debug-mode` 是独立安装的 DeepSeek Harness Bundle，不直接修改 Harness checkout。Bundle 最终同时导出 Host 插件和 Browser 插件，并通过 patch 接管现有 `ui-plan` roster 行，在原 single seat 中组合 Normal、Plan、Debug。

## 模块图

```text
Mode UI ──commands/projections──> DebugModeController
                                      │
                                      v
                               DebugRunManager
                               /       |        \
                    SourceAdapter  TraceTransport  DebuggerAdapter
                                     /      \             |
                                LocalLog  TraceListener  ProcessAdapter
                                              |
                                          TraceStore
```

## 外部 seam

### DebugModeController

拥有 `/debug` 命令、模式投影和 Debug policy prompt。激活状态从已知的 `command/run`/`command/done` 记录折叠，不写仓库外自定义事件（ADR 0003）。它不直接修改源码、启动监听器或管理后端进程。

### DebugRunManager

每个 Harness Session 最多一个活动 `DebugRun`。它是运行资源的唯一所有者，并通过少量操作隐藏前端和后端的差异：

- `start`
- `control`
- `finish`
- `recover`

状态至少覆盖 preparing、waiting-for-reproduction、paused、diagnosing、finishing、finished 和 failed。每次状态变更只有一个提交点；通知、持久 manifest 和可观察状态在操作成功后发布。

### SourceAdapter

统一语言适配器接口：

```ts
interface SourceAdapter {
  inspect(request: SourceInspectionRequest): Promise<SourceInspection>
  instrument(request: InstrumentRequest): Promise<InstrumentResult>
  remove(request: RemoveInstrumentationRequest): Promise<RemoveInstrumentationResult>
}
```

实现：JS/TS、Vue/Svelte、Dart。Adapter 必须在写入前验证输入版本，在写入后重新解析或调用语言验证器。删除只能针对拥有明确运行标记的节点。

### DebuggerAdapter

统一后端调试器接口：启动、断点配置、等待暂停、stack、scopes、evaluate、continue、step 和 stop。Node.js 与 Python 是两个真实 Adapter；协议细节不得泄露到 `DebugRunManager` 调用方。

### ProcessAdapter

统一进程发现和生命周期接口。macOS、Linux、Windows 分别实现端口到 PID 映射、命令和 cwd 读取、进程树优雅结束、强制结束和恢复启动。

### TraceTransport

前端探针的证据出口有两个真实变体，但差异封装在 `FrontendRuntime` 内：

- `listener`：默认。向带随机 token 的 HTTP Listener 发送事件，由 `TraceStore` 脱敏、限流并追加保存到 run-owned JSONL，再提供游标读取。
- `local-log`：显式 opt-out。向应用已有 console 或 terminal 写入带 run ID 前缀的有界单行记录，不启动 Listener，也不生成 trace.jsonl。

调用方只通过 `debug_start.traceTransport` 选择，不直接管理端口、令牌或日志格式。

## 数据流

### 前端

1. Agent 用 Harness 现有搜索/LSP/文件工具定位代码。
2. `debug_start` 默认选择 `listener`，在写入运行资料后启动 Listener、创建空的 run-owned `trace.jsonl`，再应用探针。
3. Listener runtime 向带随机 token 的 Listener 发送 heartbeat 和批量事件；事件成功追加到 JSONL 后才进入 `TraceStore` 的可读游标。
4. `debug_control` 从内存中的有界窗口读取证据；本地 `trace.jsonl` 保留完整的有界运行记录，供复查和崩溃恢复。
5. 只有显式选择 `local-log` 时，runtime 才将 heartbeat 和 probe 打印到应用原有输出，并跳过 Listener 和 JSONL。
6. `debug_finish` 移除探针、runtime 文件、平台配置，停止 Listener 并关闭 TraceStore；默认保留 `trace.jsonl`。

### 后端

1. Agent 定位目标并调用 `debug_start`。
2. Launch detector 生成可恢复的启动候选。
3. 若存在普通服务，用户确认后 `ProcessAdapter` 结束进程树。
4. `DebuggerAdapter` 在入口暂停状态启动，设置断点后放行。
5. 首次暂停通知 agent，检查和 stepping 经 `debug_control` 完成。
6. `debug_finish` 停止调试进程并恢复普通启动。

## 持久化与恢复

通用运行资料位于 `$DSH_HOME/debug-mode/runs/<session>/<run>/`，不进入 Git；当前前端 Listener 的诊断证据落在项目内的 `.dsh-debug/<runId>/`，同样被 Git 忽略，以便模型和维护者直接读取：

- manifest
- 原始文件备份
- 原始与应用后哈希
- 事件 JSONL（默认 Listener transport 的本地证据，当前路径为项目 `.dsh-debug/<runId>/trace.jsonl`）
- launch spec
- 清理结果

Manifest 必须先于源码修改提交。Harness 异常退出后，下一次运行只报告和恢复拥有可验证标记的内容，不在启动时盲目改写用户文件。

## 依赖方向

- UI 依赖 commands 和 projections，不依赖调试器实现。
- Debug mode 依赖 `DebugRunManager` 的接口，不依赖语言或平台 Adapter。
- Adapter 可以依赖底层解析器、协议或 OS 实现，但不得反向依赖 UI。
- 共享类型位于无运行时副作用的类型模块。
