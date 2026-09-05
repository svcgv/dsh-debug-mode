# ADR 0005：debugpy `--listen` 握手（adapter 控制通道 + 非 internal DAP 端口）

- 状态：Accepted
- 日期：2026-09-05

## 背景

`python -m debugpy --listen 127.0.0.1:PORT --wait-for-client service.py` 中，`PORT` 是 debugpy **adapter 控制通道**，不是调试会话的 DAP 端口。连接后 debugpy 立即下发 `debugpySockets` 事件，其中包含两个 socket：

- `internal: true`：内部通道；
- `internal: false`：真正的 DAP 会话端口。

直接对 `--listen` 端口发 `attach { port: PORT }` 会挂起（早期实现因此超时）。

## 决策

- 连接 `--listen` 端口后，先发送 `initialize`，同时监听 `debugpySockets` 事件并记录 body。
- `attach` 的目标端口取 `debugpySockets.sockets` 中第一个 `internal !== true` 的端口；事件缺失（老版本 debugpy 直接在 listen 端口暴露 DAP）时回退到原端口。
- **attach 响应在 `configurationDone` 之后才返回**，因此 `attach` 请求必须流水线发送（不先 await），随后 `setBreakpoints` → `configurationDone` → 最后 await attach 以暴露错误。

## 影响

- 真实 debugpy（1.8.21）下 attach→断点→next→evaluate→finish 端到端通过（`PY_DEBUGPY=<python-with-debugpy> pnpm test:integration`）。
- 端口选择逻辑抽成纯函数 `pickDebuggeeSocketPort`，可单测。
