# 代码规范

## TypeScript

- 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride` 和 `useUnknownInCatchVariables`。
- 使用 ESM 和显式 `.js` 输出语义；源码相对导入最终应兼容 NodeNext。
- 禁止 `any`。外部输入先作为 `unknown`，再通过 schema、类型守卫或协议 decoder 收窄。
- 类型断言只允许用于无法由 TypeScript 表达但已经运行时验证的事实，并必须紧邻说明。
- 使用 discriminated union 表达状态、结果和错误，不使用多个相互依赖的 boolean。
- Promise 必须 await、return 或显式以 `void` 标明有意分离，并由生命周期所有者处理拒绝。

## 命名

- Module、class、type：PascalCase。
- function、variable、property：camelCase。
- 常量：仅真正的模块级协议常量使用 UPPER_SNAKE_CASE。
- Adapter 名称必须说明机制或平台，如 `NodeInspectorAdapter`、`WindowsProcessAdapter`。
- 错误码使用稳定的 UPPER_SNAKE_CASE，例如 `SOURCE_VERSION_DRIFT`。

## 接口设计

- 优先少量深接口，不把内部步骤逐个暴露给调用方。
- 参数超过三个或存在可选组合时使用对象参数。
- 公共方法返回结构化结果；不要依赖 console 输出表达成功与失败。
- 配置项只暴露部署方确实需要改变的值。安全不变量不得变成可关闭开关。
- 一个 Adapter 只有一个实现时，除非存在明确测试替身需求，否则不提前抽象。

## 错误处理

错误必须包含：

- 稳定 code
- 人类可读 message
- operation 或 stage
- 是否可重试
- 已完成的副作用
- 推荐恢复动作

捕获异常时必须选择：恢复、转换并保留 cause、清理后重新抛出。禁止空 catch 和只打印后继续。

## 文件修改

- 读取得到的版本或 hash 必须参与写入校验。
- 写入 manifest 后才允许修改目标源码。
- 插入节点必须携带 run ID 和 probe ID。
- 写后重新解析或执行语言验证器；失败立即尝试安全撤销。
- 清理以移除生成节点为主，禁止默认恢复整份备份。
- 临时文件采用原子写入和 rename；权限仅允许当前用户读取。

## 进程与网络

- 使用 argv 数组启动进程，不拼接未经验证的 shell 字符串。
- 进程树必须支持 AbortSignal、优雅结束宽限和强制结束宽限。
- 监听端口默认由 OS 分配；不得假设固定端口空闲。
- 所有网络输入限制 body 大小、事件数量、速率和连接存续时间。
- Listener token 使用密码学随机数，只通过 endpoint 传递，不写入普通日志。

## React Client

- UI 只使用 Harness slot、projection 和 command seam。
- 不在组件中创建 Host 状态镜像。
- 活动模式以 Host projection 为准，不依赖纯客户端乐观状态。
- 异步选择必须 single-flight；失败恢复到 Host 投影并显示可操作错误。
- 文案进入 locale 字典；错误码和底层诊断可保持英文。

## 注释与文档

- 公共导出使用英文 JSDoc，描述完整约定、失败和所有权。
- 代码注释说明非显然的不变量，不记录临时推理过程。
- TODO 必须包含明确原因和可验证完成条件；不得使用模糊的 “improve later”。
