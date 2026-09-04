# ADR 0001：使用独立 Bundle 并接管 Plan UI 席位

- 状态：Accepted
- 日期：2026-09-04

## 背景

DeepSeek Harness 当前 Web composer 的模式区只有权限选择器和 `conversation.input.plan` single slot。第三方 Client 插件可以注册外侧 list slot，但不能在模式容器内追加第二个模式控件。

## 决策

`dsh-debug-mode` 作为独立安装 Bundle 发布，不修改 Harness checkout。Loader 拒绝把既有行替换为不同包名，因此保留官方 `ui-plan` 的 Plan chip，调试开关以独立 client row 挂载到 composer 的 `conversation.input.left` list seat。原生 Plan Host 插件、`/plan` 命令、投影和 review 继续由 Harness 拥有；进入 Debug 时 Host 通过 agent 作用域 `planMode.set(false)` 关闭 Plan。

## 影响

- 插件可独立安装和升级，不要求维护 Harness fork。
- Client 插件必须复现并测试原 Plan 控件的必要行为。
- Harness 若以后提供通用 mode slot，可以新增兼容路径并淘汰 roster 覆盖。
- 不支持当前 slot 合约的 Harness 版本必须在启动时失败，不能退化成不可见 Debug 模式。
