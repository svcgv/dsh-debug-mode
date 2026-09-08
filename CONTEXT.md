# Debug Evidence

本上下文定义 Debug Mode 如何暴露和保留运行时证据，避免把应用自身输出与插件主动采集混为一谈。

## Language

**Trace Transport**：
前端探针向调试者暴露证据的方式；默认是 Listener Collection，也支持显式 Local Log。
_避免使用_：日志模式、采集模式、channel

**Listener Collection**：
探针通过带运行令牌的 HTTP endpoint 把事件发送给插件拥有的 Listener；事件经 TraceStore 脱敏、限流后追加保存到当前运行的本地 JSONL 文件，并通过游标读取。
_避免使用_：日志服务、remote logging、collector mode

**Local Log**：
仅在显式选择时使用；探针把带运行前缀的有界记录写入应用已有的 console 或 terminal，不启动插件采集监听器，也不创建 trace.jsonl。
_避免使用_：console transport、manual logging
