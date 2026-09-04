# 贡献指南

## 开发环境

- Node.js：`>=22.19.0`
- pnpm：`11.x`
- 参考 DeepSeek Harness：通过 `DSH_HARNESS_DIR` 指向本地 checkout，默认可使用相邻目录 `../deepseek-harness`

初始化：

```sh
corepack enable
pnpm install
pnpm check
```

## 工作流程

1. 阅读 `AGENTS.md`、`docs/architecture.md`、`docs/coding-standards.md` 和相关 ADR。
2. 从可观察事实开始：检查仓库、配置、进程和目标文件版本。
3. 为行为变更先增加失败测试或可验证 fixture。
4. 实现最小改动，不顺带重构无关代码。
5. 更新公共类型、README、架构或安全约定。
6. 运行聚焦测试，再运行 `pnpm check`。
7. 用 Conventional Commit 提交一个单一关注点。

## 分支与提交

- 默认分支：`main`
- 工作分支：`codex/<short-description>` 或团队约定前缀
- 提交格式：`<type>(optional-scope): <summary>`
- 常用类型：`docs`、`chore`、`test`、`feat`、`fix`、`refactor`、`build`、`ci`
- Summary 使用英文祈使句，不加句号。

示例：

```text
docs: define source restoration invariants
test(process): cover Windows process-tree shutdown
feat(mode): register debug session projection
```

## 本地命令

```sh
pnpm format          # 格式化受支持文件
pnpm format:check    # 验证格式，不修改文件
pnpm lint            # Oxlint，包括 type-aware 规则
pnpm typecheck       # TypeScript strict 检查
pnpm test            # 快速单元测试
pnpm test:coverage   # 覆盖率与核心模块 100% 门槛
pnpm test:integration
pnpm test:platform
pnpm docs:check
pnpm pack:check
pnpm check           # 完整阻塞门禁
```

## Pull Request 要求

- 描述问题、实现选择、已知限制和恢复策略。
- 列出实际运行的命令，不声称未运行的检查已经通过。
- 涉及用户源码或进程的变更必须说明失败时不会破坏什么。
- 涉及公开接口的变更必须更新对应 ADR 或架构文档。
- CI 必须在 Linux 质量门禁以及 macOS/Linux/Windows 平台门禁中通过。

## 发布

- 发布前运行 `pnpm check` 和 `pnpm pack:check`。
- npm/tarball 只包含 `lib/`、Bundle patch、README、LICENSE 和 manifest。
- 不发布 `src/`、测试、运行日志、备份、`.dev/` 或本机配置。
- Git 安装所需的构建策略在 Debug Mode 业务实现阶段启用并单独验证。
