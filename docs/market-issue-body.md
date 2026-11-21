## 插件地址 / Plugin link

`dsh-503-guard`

- npm: https://www.npmjs.com/package/dsh-503-guard
- 源码: https://github.com/ltw2522/dsh-503-guard （根目录即插件本体）
- 版本: 1.0.0（2026-11-21 发布）

## 简短说明 / Summary

模型请求被上游 5xx（典型是 HTTP 503）拒绝、内置 `llm-retry` 重试耗尽之后，插件接管这一轮：按 5s → 30s 指数退避在后台探测网关是否已经恢复，一旦探通就返回 `{ kind: 'retry' }` 让 agent loop 重发这一轮，失败那轮不必手动点重试。

- 挂 `agent/request-error` waterfall，只认 `failure.code === 'SERVER'`（HTTP 5xx 归一化码），其余故障零介入；
- 探活用 `GET https://api.deepseek.com/v1/models`，状态码 < 500 即判恢复（401/403/429 都说明网关可达）；
- 安全阀：30 分钟总预算、`AbortSignal.any` 融合中止信号、WeakMap 按 agent + turn/step 去重，不会重复开探测；
- 往会话写 `llm/retry` / `llm/retry-started` 事件，界面直接复用内置重试条渲染「等待重试模型请求（n/…)· Ns」，不新增 UI。

## 补充信息 / Additional details

| 项目 | 内容 |
| --- | --- |
| 分类建议 | Development & operations（开发与运维） |
| 许可证 | MIT |
| Logo | 包内 `icon.svg`（心电波形 + 回环箭头），随 npm 包分发 |
| 声明兼容 | `engines.dsh: >=0.2.0-0 <0.3.0-0`，`engines.node: >=20` |
| 实测环境 | DSH Desktop 0.2.2-rc.3，Windows 11 24H2，Node 20 |
| 自测 | `node test-guard.mjs` 19 条断言 + `node test-integration.mjs` 10 条（用 DSH 自带 `@deepseek-ai/cordis` 4.1.0 真跑瀑布，验证「内置重试先耗尽、插件后接管」） |
| 网络行为 | 仅在 5xx 失败后访问 `api.deepseek.com/v1/models` 做探活，不发送任何本地数据、不上报统计 |
| Bundle | Host-only bundle，`dsh.bundle.patch` 注入 `server-503-guard` 单节点，无客户端半 |
