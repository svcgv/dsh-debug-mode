# DeepSeek Harness Debug Mode 实施计划

## 状态

- [x] 阶段一：规范与工程门禁
- [ ] 阶段一人工确认
- [ ] 阶段二：Debug Mode 插件实现
- [ ] 跨平台与 Harness 集成验收

阶段一完成并经用户明确确认前，不得开始 Debug Mode 业务实现。

## 阶段一：规范与工程基础

### 文档

- [x] 建立仓库最高优先级规则 `AGENTS.md`
- [x] 建立贡献流程 `CONTRIBUTING.md`
- [x] 建立架构、代码、测试和安全规范
- [x] 记录独立 Bundle 与统一运行模型 ADR
- [x] 在验证完成后记录门禁结果

### 工程门禁

- [x] Node.js、pnpm、TypeScript strict 与 ESM 脚手架
- [x] Prettier 与 Oxlint
- [x] Vitest 单元、集成、平台和覆盖率配置
- [x] Husky pre-commit 与 pre-push
- [x] GitHub Actions Linux 质量门禁
- [x] GitHub Actions macOS/Linux/Windows 平台门禁
- [x] npm pack 内容验证
- [x] `pnpm check` 全部通过

### 阶段一验证记录

验证日期：2026-09-04。

已通过：

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm docs:check`
- `pnpm test:coverage`，当前 no-op 骨架覆盖率 100%
- `pnpm test:integration`
- `pnpm test:platform`
- `pnpm pack:check`，发布清单共 8 个文件
- `pnpm exec lint-staged --allow-empty`
- `git diff --check`
- Husky hook 可执行权限检查

Debug 命令、模式投影、UI 接管、埋点、监听器、调试协议和进程控制均未实现。

### 阶段一停止点

阶段一完成时输出文件清单、检查结果、已知风险和阶段二入口。此时停止，不实现模式状态、埋点、监听器、调试协议或进程结束逻辑。

## 阶段二：插件行为

### Bundle 与模式入口

- 创建兼容 DeepSeek Harness `>=0.1.3-alpha.1 <0.1.4` 的独立 Bundle。
- package 同时提供 Host 与 Browser 入口，并通过 Bundle patch 替换 Web profile 的 `ui-plan` roster 行。
- 保留官方 `ui-plan` Plan chip，Debug 开关挂载到 `conversation.input.left` list seat。
- Plan 与 Debug 互斥由 Host 保证（进入 Debug 先 `planMode.set(false)`）；原生 `/plan` 与 plan review 行为保持不变。
- 增加 `/debug [message]`、`/debug off` 命令和 `DebugProjection`；状态从 `command/run`/`command/done` 折叠，不写自定义 session 事件（见 ADR 0003）。

### 模型接口

```ts
interface DebugTarget {
  path: string
  startLine: number
  endLine: number
}

interface DebugStartRequest {
  targets: DebugTarget[]
  runtime: 'auto' | 'frontend' | 'backend'
  launchId?: string
}
```

注册三个稳定工具：

- `debug_start`：分类目标并创建前端或后端运行。
- `debug_control`：状态、等待、读取、endpoint 切换、调试器检查和 stepping。
- `debug_finish`：清理资源并按需恢复普通后端服务。

工具在所有模式保持注册，Debug 未激活时拒绝执行。

### 前端运行时

- 支持 JS、TS、JSX、TSX、Vue、Svelte 和 Flutter/Dart。
- 对已定位函数或行区间中的可执行语句插入 probe；不改写整个项目。
- 采集控制流和安全变量快照，限制深度、数量、事件大小和速率，并脱敏敏感字段。
- Listener 绑定本地网卡，以随机令牌鉴权，先广告 loopback endpoint。
- Runtime 发送 heartbeat；无 heartbeat 才切换为局域网 IP，有 heartbeat 无 probe 则判定路径未命中。
- Flutter 临时网络配置带运行标记，可安全移除。
- 文件漂移时只移除可证明属于当前运行的节点，不整文件回滚。

### 后端运行时

- 支持 Node.js/CDP 和 Python/debugpy DAP。已知限制：debugpy `--listen` 模式的 attach 握手在部分环境未完成真实断点验证（见仓库 Known Limitations 说明）。
- 探测 launch.json、package scripts、框架配置和现有监听进程。
- 结束现有服务前展示进程及恢复信息并要求确认。
- 支持 macOS、Linux、Windows 的进程树结束和服务恢复。
- 首次断点命中只通知一次，详细数据由工具有界读取。

## 最终验收

- 用户能在 Web composer 选择 Debug 并提交问题。
- Agent 能定位最小代码范围并获取日志或断点证据。
- 前端无 heartbeat 时能正确切换 LAN endpoint，不把路径未命中误判为网络失败。
- 后端只有在确认后停止已有服务，调试结束后恢复普通服务。
- 诊断输出包含根因、运行时证据和置信度；修复需用户选择并可复验。
- 结束后源码、平台配置和进程状态恢复，无法自动恢复的内容逐项报告。
