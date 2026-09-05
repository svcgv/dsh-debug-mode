# dsh-debug-mode

DeepSeek Harness 的 Debug Mode Bundle，目标是在 Web composer 中提供 Normal、Plan、Debug 模式，并通过运行时埋点或后端调试器帮助 agent 获取可验证的故障证据。

## 当前状态

阶段一工程规范与质量门禁已完成；阶段二功能已实现主体：模式控制与 Debug/Normal 开关、`/debug` 命令与投影、前端 Listener 与插桩、Node/CDP 与 Python/DAP 后端、进程辅助与清理工具。浏览器验收（2026-09-05，Edge + 本地 Harness Web）已确认：插件 bundle 能正常加载（不再出现 "加载 plugin 失败"），composer 显示 Debug/标准 开关，点击可在标准↔调试间往返切换且投影状态正确持久化、控制台零报错。前端埋点真实链路（instrument→listener→带行号日志→finish 恢复）与 Node/CDP、Python/debugpy 真实断点均已本地闭环；依赖模型调用的浏览器内 agent 取证复现与真实 Flutter/LAN 人工复现仍待闭环；跨平台 CI 已在 GitHub Actions 全绿。

- [本地实施计划](docs/implementation-plan.md)
- [架构规范](docs/architecture.md)
- [代码规范](docs/coding-standards.md)
- [测试策略](docs/testing-strategy.md)
- [安全规范](docs/security-and-safety.md)
- [贡献指南](CONTRIBUTING.md)

## 本地 API 配置与启动

1. 复制 `config.example.ini` 为本地 `config.ini`。
2. 在 `[deepseek]` 下填写 `api_key`；`config.ini` 已被 Git 忽略。
3. 先运行 `pnpm config:check`，它只报告 key 长度，不会打印 key。
4. 设置 `DSH_HARNESS_DIR`（默认使用相邻 `../deepseek-harness`），运行 `pnpm harness:web`。该脚本会在 `.dev/dsh-home` 的临时 profile 安装当前打包插件，并以 `DEEPSEEK_API_KEY` 启动 Harness Web。

`harness:web` 不会修改你的默认 Harness profile，也不会输出 API key。

## 已知限制（阶段二当前状态）

- Python/debugpy 后端：真实 attach 已在本机闭环（debugpy 1.8.21）：`--listen` 端口是 adapter 控制通道，需按 `debugpySockets` 事件取非 internal 的 DAP 端口 attach，且 attach 响应在 `configurationDone` 后才返回（见 ADR 0005）。集成测试用 `PY_DEBUGPY=<python-with-debugpy> pnpm test:integration` 运行并已通过。
- 后端“停掉既有服务→调试→恢复”闭环：当前对同脚本的普通服务采取安全失败提示（不自动停服），恢复闭环未实现。
- Flutter：本地网络补丁为可回滚纯文本层；未在真实 Flutter 工程跑通。
- 跨平台 CI：GitHub Actions 的 Quality（ubuntu）与 Platform（ubuntu/windows/macos）在 `main` 最新提交全绿（2026-09-05 验证）。
- Harness Web：真实启动、client bundle 纳入 boot 清单、浏览器 UI 目视与模式开关往返已验证（Edge，2026-09-05）；依赖模型调用的完整端到端复现（埋点/断点取证）尚未在浏览器会话内闭环。
- client bundle 必须以 `window.__ModuleLoader__.load({ id, factory })` 工厂格式产出（见 ADR 0004）；projection 的 `viewSchema` 只校验视图形状 `{active, pending}`，不得复用 unit state 解析器。
- 本仓库 `main` 分支 `pnpm check` 全绿。

## 许可证

MIT，见 [LICENSE](LICENSE)。
