# ADR 0006：默认使用 Listener 采集并保存本地日志

- 状态：Accepted
- 日期：2026-09-08

## 背景

前端调试需要通过探针获得可验证的运行时证据。仅打印到应用 console/terminal 会让模型无法稳定读取、无法使用游标等待，也没有可复查的运行记录；仅保存在内存中又会在调试结束或进程退出时丢失证据。因此默认运行需要启动插件拥有的 Listener，并将已脱敏、已限流的事件追加保存到当前 Debug Run 的本地 JSONL 文件。

## 决策

- `debug_start` 的前端 Trace Transport 默认是 `listener`。
- Listener 使用随机运行令牌鉴权，接收探针事件并由 `TraceStore` 有界写入 `<project>/.dsh-debug/<runId>/trace.jsonl`。
- 事件只有在成功写入本地日志后才对 `debug_control read/wait` 可见；日志创建失败、追加失败、文件已存在或写入队列超限必须返回稳定错误，不静默丢失或伪造成功。
- `traceTransport: 'local-log'` 仅作为显式 opt-out：探针向 console/terminal 打印有界记录，不启动 Listener，也不生成 trace.jsonl。
- `debug_finish` 停止 Listener、等待并关闭 TraceStore、移除 runtime 文件；默认保留 `trace.jsonl` 作为诊断证据，Local Log opt-out 的临时目录则清理。

## 影响

- 默认前端调试增加一个插件拥有的本地端口和一个 run-owned 日志文件，但模型可以稳定读取证据，且结束后证据仍可复查。
- Listener 日志只保存在本机项目的 `.dsh-debug/<runId>/trace.jsonl`，不进入 Git；敏感字段、事件数量、事件大小、内存和磁盘占用受统一上限约束。
- Local Log 仍可用于不能启动服务或明确要求只看 console/terminal 的场景；它不是默认路径。
