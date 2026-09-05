# ADR 0003：Debug 模式折叠只使用命令记录

- 状态：Accepted
- 日期：2026-09-04

## 背景

早期设计计划写入自定义 `debug/mode` session 事件并用投影折叠。勘察 Harness `0.1.3-alpha.1` 后发现：仓库外插件的自定义事件不在生成清单 `KNOWN_SESSION_EVENT_TYPES` 中，持久化读取只有在事件信封携带 `ignorable: true` 时才允许跳过未知类型；而进程内 `Session.append()` 不提供写入该信封标记的入口。写入不带标记的 `debug/mode` 会让同一 harness 在重启后拒绝读取该会话。

## 决策

Debug 激活状态不写自定义事件，只从已知的、仓库内事件 `command/run` 与 `command/done`（名称 `debug`）折叠：

- `/debug [message]` 产生 wanted=true，`/debug off` 产生 wanted=false。
- 配对 `command/done` 成功时提交 `active = wanted`。
- 投影 wire 值 `{ active, pending }` 与 plan 一致。

由于输入事件本身是仓库已知类型，状态可以在重启、resume 和 fork 后由日志恢复，且不会触发持久化拒绝。

## 影响

- 无需自定义事件注册，也没有“必须 ignorable”的兼容风险。
- Debug 在进程内立即生效，不提供 plan 那样的“下一个 accepted pre-step 再提交”的延迟语义；命令在两次请求之间由用户执行，因此影响有限。
- 与 plan 的互斥由 Host 双向保证：进入 Debug 时 `/debug` 处理器在可用的 agent 作用域 `planMode` 服务上执行 `set(false)`；反向（用户先进入 plan）由 debug 投影折叠原生 `plan/mode` 激活事件实现——plan 一旦 durable 生效，debug 投影提交 inactive 并清空在途 `/debug` 选择，之后保持关闭直到用户重新 `/debug`。两个方向都不依赖客户端选择器的顺序规避。
