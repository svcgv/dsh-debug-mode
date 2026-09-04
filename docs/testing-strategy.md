# 测试策略

## 分层

### 单元测试

覆盖纯状态转换、解析、序列化、脱敏、限流、源码变换和清理决策。通过模块公开接口测试，不读取私有字段。

### 集成测试

组合真实文件系统、Listener、协议 client 和受控子进程。每个测试创建独立临时目录、端口和进程组，并在 `finally` 中清理。

### 平台测试

macOS、Linux、Windows runner 分别验证：

- 端口到 PID 映射
- 命令行与工作目录识别
- 优雅结束进程树
- 超时后的强制结束
- 普通服务恢复
- 路径、信号和换行差异

### Harness 集成测试

使用 `DSH_HARNESS_DIR` 指向兼容 checkout，将打包产物安装到临时 Web profile，验证 browser bundle、slot、command、projection 和 Host 生命周期。

## 覆盖率

核心模块要求 100%：

- `src/mode/**`
- `src/run/**`
- `src/instrumentation/**`
- `src/listener/**`
- `src/debugger/**`
- `src/process/**`
- `src/recovery/**`

全项目最低值：

- statements：90%
- lines：90%
- functions：90%
- branches：85%

纯类型文件、生成声明和测试 fixture 可以排除。任何新增排除必须在代码审查中说明为什么无法通过公开接口执行。

## 并发与稳定性

- 不使用硬编码端口、固定临时目录或依赖测试顺序的全局状态。
- 时间测试使用可注入 clock；协议 timeout 测试使用充分余量而非毫秒级竞速。
- 子进程测试断言进程树完全退出，不只断言父 PID。
- 所有 event emitter、timer、server 和 stream 在测试结束时必须关闭。

## 必测失败场景

- 输入文件在读写之间发生漂移。
- 写后语法验证失败。
- 清理时用户修改了邻近代码。
- Listener 收到错误 token、畸形 JSON、超限 body 或事件洪泛。
- 无 heartbeat 与有 heartbeat 无 probe 的分支。
- 用户拒绝结束现有服务。
- 进程无法优雅结束、无法强制结束或无法恢复。
- 调试器连接中断、断点无法解析、source map 缺失。
- Harness/plugin 在运行中卸载或崩溃。
