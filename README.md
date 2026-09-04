# dsh-debug-mode

DeepSeek Harness 的 Debug Mode Bundle，目标是在 Web composer 中提供 Normal、Plan、Debug 模式，并通过运行时埋点或后端调试器帮助 agent 获取可验证的故障证据。

## 当前状态

阶段一工程规范和质量门禁已经完成并通过本地验证，当前等待人工确认。Debug Mode 业务功能尚未实现。

- [本地实施计划](docs/implementation-plan.md)
- [架构规范](docs/architecture.md)
- [代码规范](docs/coding-standards.md)
- [测试策略](docs/testing-strategy.md)
- [安全规范](docs/security-and-safety.md)
- [贡献指南](CONTRIBUTING.md)

## 已知限制（阶段二当前状态）

- Python/debugpy 后端：DAP 客户端与启动/清理已完成；真实断点 attach 需要 debugpy `adapter↔server↔client` 三段桥接（`debugpy.adapter --for-server` 模式），当前未在本环境完整打通，相关工作记录于 `docs/implementation-plan.md`。
- 后端“停掉既有服务→调试→恢复”闭环：当前对同脚本的普通服务采取安全失败提示（不自动停服），恢复闭环未实现。
- Flutter：本地网络补丁为可回滚纯文本层；未在真实 Flutter 工程跑通。
- 跨平台 CI：macOS/Linux/Windows 平台测试工作流已配置，需推送分支在 GitHub Actions 实际运行。
- Harness Web：真实启动与 client bundle 纳入 boot 清单已验证；浏览器内 UI 目视与无 API key 的模型端到端会话未完成。
- 本仓库 `main` 分支累计 24+ 个 commit，`pnpm check` 全绿。

## 许可证

MIT，见 [LICENSE](LICENSE)。
