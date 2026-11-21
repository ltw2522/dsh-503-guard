# dsh-503-guard —— 服务端故障自愈守卫

模型请求被上游网关 5xx 拒绝（最常见就是 **503 Service Unavailable**）时，DSH 内置的重试只做有限次固定退避，挥完就报「本轮运行失败」，你得手动重发。

这个插件在那之后接管：**不再盲目重试，而是主动探测上游是否真的活过来**，一旦恢复立刻把这一轮重新拉起来。你什么都不用做。

## 它做了什么

1. 挂在 `agent/request-error` 瀑布上，只认 `failure.code === 'SERVER'`（DSH 把 HTTP 5xx 统一归一化成这个码，界面上那个红标 SERVER 就是它）。
2. **内置重试优先**：同一条故障，内置 `llm-retry` 先按它自己的策略重试；本插件只在决定权最终落到它手上时才真正干活，不抢活、不改变原有重试手感。
3. 接管后按 **5s → 10s → 20s → 30s（封顶）** 指数退避，一次一次 GET `https://api.deepseek.com/v1/models` 探活。
   - 返回状态码 **< 500**（200 / 401 / 403 / 429 都算）→ 网关活着，判定已恢复。用 401 当信号是刻意的：没带凭证本来就该 401，能返回 401 说明 DNS、TLS、网关、路由全通。
   - 502 / 503 / 504 / 连不上 / 超时 → 继续等。
4. 探测一通，返回 `{ kind: 'retry' }`，agent loop 直接重发这一轮，界面接着往下跑。
5. 等待期间往会话里写 `llm/retry` 事件，界面就会渲染出「已重试模型请求（n/m）· Xs」那一行，恢复瞬间切成「已开始重试」——和内置重试条同一个渲染器，观感统一。

## 安全阀

| 阀门 | 默认 | 作用 |
|---|---|---|
| `maxWaitMs` | 30 分钟 | 单点总等待预算，超时交还默认处理，绝不无限挂起 |
| `payload.signal` | — | 你点「停止」时立刻收手，交还下游 |
| 并发去重 | 开 | 同一 `turn/step` 只跑一份探测，不会扇出多条 |
| 卸载清理 | `ctx.effect` | 插件被停用/卸载时中止所有在跑的探测 |

## 安装

```bash
# 通过 DSH 的 plugin_manager install_bundle，传绝对路径
D:\dsh_workspace\dsh-503-guard
```

装完重启 DSH 生效。

## 配置

改 `cordis.patch.yml` 的 `config` 段即可，常用项：

| 键 | 默认 | 说明 |
|---|---|---|
| `codes` | `['SERVER']` | 触发自愈的失败码；`SERVER` 覆盖全部 5xx |
| `probeUrl` | `https://api.deepseek.com/v1/models` | 探活地址；换成你实际用的网关也行 |
| `probeHeaders` | `{}` | 探测请求头，可放 `Authorization` |
| `initialDelayMs` | `5000` | 首次探测前等待 |
| `maxDelayMs` | `30000` | 退避封顶 |
| `maxWaitMs` | `1800000` | 总预算 |
| `announce` | `true` | 是否写进度事件到会话 |

## 自测

```bash
node test-guard.mjs        # 19 条：恢复算法本身，纯桩，不联网
node test-integration.mjs  # 10 条：真实 cordis 4.1.0 跑瀑布派发，验证注册顺序与 next() 语义
```

`test-guard.mjs` 覆盖：非目标码原路交还、恢复后返回 retry、预算耗尽交还、中止收手、并发去重、卸载清理、探测异常不误判。

`test-integration.mjs` 用一个「内置 llm-retry 替身 + 真实插件 apply()」的 harness 跑完整链路，实测轨迹为：

```
plugin-registered -> builtin#1 -> builtin#2 -> builtin#3 -> builtin-exhausted -> 插件探测恢复
```

证明内置重试先跑完、耗尽后才轮到本插件接管，顺序与语义都正确。
