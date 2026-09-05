# ADR 0004：Client bundle 必须使用 Harness Module Loader 工厂格式

- 状态：Accepted
- 日期：2026-09-05

## 背景

Harness Web 的 `/plugins` 路由把每个已启用插件的 `client.js` **拼接成一个经典 `<script>`** 响应返回（combo URL `??a/client.js,b/client.js,...&rev=...`）。浏览器按普通脚本执行这段拼接结果；任何一段里出现顶层 `import`/`export` 都会让整段解析失败，boot 页面随即报告 "Failed to load plugins"，且**所有**插件（含官方插件）都无法注册。

`dsh-debug-mode` 最初用 tsdown 以 `platform: 'browser'` + ESM 产出 `lib/client.js`（顶层 `import { useState } from "react"` 与尾部 `export {...}`），恰好触发上述故障。官方 `@deepseek-ai/dsh-client-ui-*` 插件的 `client.js` 则统一形如：

```js
window.__ModuleLoader__.load({
  id: '<package-name>',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    // requires + implementation + exports.* assignments
    return module.exports
  },
})
```

## 决策

- Browser 入口构建时把 tsdown/rolldown 产出的 ESM chunk 转换成上述 `__ModuleLoader__.load({ id, factory })` 工厂格式，转换逻辑放在可单测的纯模块 `src/build/client-bundle.ts`（tsdown `renderChunk` 钩子调用）。
- `react` 与 `react/jsx-runtime` 一律**外部化**（`deps.neverBundle`），由 loader 的平台模块表解析；bundle 内不内嵌 React。
- 转换后必须能作为 classic script 解析（构建时用 `@babel/parser` 校验，残留模块语法即失败），杜绝再次污染拼接脚本。
- `lib/` 不入库；`pnpm pack` 前由 `pnpm build` 产出。

## 影响

- 产物对 Harness `/plugins` 拼接契约免疫，官方插件与第三方插件共存。
- 转换器需要跟随 rolldown ESM 输出形状（头部 import 块 + 尾部 export 列表）；形状变化时单测与构建校验会先失败。
- 后续若 Harness 提供模块化加载路径，可保留现有构建并在 loader 端消除兼容层。

## 关联事实（同次验收发现）

- composer 会话的 projection **wire view** 与 **unit state** 是两种形状：gateway 调 `viewSchema.parse(view(state))`，因此 `viewSchema` 只应校验 `{active, pending}`，不得复用 unit state 解析器（否则会以 "invalid running record" 拒绝合法视图并让历史/控制流加载失败）。
