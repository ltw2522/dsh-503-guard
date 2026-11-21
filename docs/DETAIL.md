# 503 自愈守卫 —— 详细说明

## 一、故障场景

DSH 的模型请求走 `dsh-llm-deepseek`，上游网关过载时会返回 HTTP 503。DSH 把它归一化成 `failure.code === 'SERVER'`：

```js
// dsh-llm-deepseek/lib/index.js:1822
else if (status !== void 0 && status >= 500 || ["api_error","overloaded_error"].includes(type))
    code = "SERVER";
```

界面上你看到的就是：

```
已重试模型请求 (3/5) · 3s ›
● 本轮运行失败  DeepSeek Messages request failed (503)        SERVER
```

`(3/5)` 说明内置 `llm-retry` 已经用掉 3 次机会。它的策略是**有限次、指数退避**，耗尽后 `return next()`，事件链走到尽头就报终态失败。

问题在于：503 通常是**上游瞬时过载**，几十秒到几分钟就自己好了。内置策略的窗口太短，等不到那一刻；而人肉重发要么忘了，要么一焦虑就狂点。

## 二、接管点：agent/request-error

一次模型请求失败后，agent loop 会发一个 waterfall 事件征求意见：

```js
// dsh-agent-loop/lib/index.js:952-962
const action = await this.dispatch.waterfall("agent/request-error", { ... });
signal.throwIfAborted();
if (action?.kind !== "retry") throw LlmError.fromFailure(finish.failure);
continue;   // ← 返回 retry 就重发这一轮
```

返回值的语义（`api-catalog.js:4991-4996`）：

| 监听器行为 | 结果 |
|---|---|
| 返回 `{ kind: 'retry' }` 且**不调用** `next()` | 自己负责恢复，agent loop 重发 |
| 调用 `next()` | 交给下游（内置 llm-retry / 默认终止） |
| 返回 `undefined` | 该故障按终态处理 |

本插件就是注册在这个瀑布上的**一个监听器**。它只做一件事：判断这个码归不归自己管。

- 不归自己管（不是 `SERVER`）→ 立刻 `next()`，零 await，对原有行为零影响。
- 归自己管 → 进入探测循环，**等多久都不调 next()**，直到探测成功或预算耗尽。

## 三、为什么不会和内置 llm-retry 打架

瀑布按注册顺序执行，内置 `llm-retry` 的监听器在：

```js
// dsh-llm-retry/lib/index.js
ctx.on("agent/request-error", (payload, next) => track(recover(payload, next)))
```

它在 `previousRetry >= policy.maxRetries` 时 `return next()`（lib/index.js:173）——也就是**主动把决定权往下传**。所以：

1. 前几次 503：内置重试拿着，本插件收到的是 `next()` 的返回值，直接透传，什么都不做。
2. 内置放弃后：本插件拿到决定权，开始探测。
3. 探测成功后返回 `retry`，agent loop 重发；如果又 503，内置重试的计数器会重新走一遍，然后再次交给本插件。

## 四、探测口径

`GET https://api.deepseek.com/v1/models`，8 秒超时。

| 响应 | 判定 | 理由 |
|---|---|---|
| 200 / 401 / 403 / 429 | **已恢复** | 任何 < 500 的响应都证明网关在正常应答；401 只是没带凭证 |
| 502 / 503 / 504 | 未恢复 | 网关仍不可用 |
| 连接失败 / DNS 失败 / 超时 | 未恢复 | 网络层还没通 |

实测：本机探测该地址稳定 **331 ms 返回 401**，`ok:true`。

退避：`initialDelayMs × 2^n`，抖动 ±20%，`maxDelayMs` 封顶（默认 30 s）。抖动是为了多会话同时恢复时不在同一毫秒打出一片尖峰。

## 五、界面反馈

等待期间每轮写一条 `llm/retry`：

```js
{ retryId, turn, step, provider, mode: 'normal',
  policyKey: 'dsh-503-guard', retry, maxRetries: 99, delayMs, failure }
```

`llm/retry` 是 DSH 的已知事件类型（`KNOWN_SESSION_EVENT_TYPES`），客户端 `dsh-client-ui-chat` 的 `retryDefinition` 会把它渲染成「等待重试模型请求（n/m）· Xs」。探测成功再补一条 `llm/retry-started`，那一行的状态位翻成「已开始重试」。

写事件全程 try/catch：UI 出任何问题都不影响恢复逻辑本身。

## 六、安全阀

- **总预算**：`maxWaitMs`，默认 30 分钟。到点就 `next()` 交还，不会把一次对话无限挂起。
- **中止信号**：`AbortSignal.any([payload.signal, lifetime.signal])` 融合 turn 级与插件级中止，任一触发立刻退出循环。
- **并发去重**：`WeakMap<agent, token>` 记录当前在跑的 `turn/step`，同一位置第二次进入直接 `next()`。
- **卸载清理**：`ctx.effect(() => () => lifetime.abort())`，插件停用时掐断所有定时器。

## 七、自测覆盖

`node test-guard.mjs`，19 条断言：

1. 非 SERVER 码 → 零 await 交还，不写事件
2. 探测 200 → 返回 `{kind:'retry'}`，写 `llm/retry` + `llm/retry-started`
3. 持续 503 → 预算耗尽交还下游
4. turn 中止 → 立刻交还
5. 同 turn/step 并发 → 第二份直接交还
6. 插件卸载 → 在跑的探测收手
7. 探测抛异常 → 不误判为恢复，继续等

## 取证日志（1.0.1 起）

会话日志只记录「这一轮成功或失败」，看不到 waterfall 内部各个监听器的接力过程，所以判断「插件有没有接管」缺少证据。插件为此维护一条独立旁路日志：

| 落点 | `config.tracePath`，默认 `~/.dsh/dsh-503-guard.log` |
| 开关 | `config.trace`，默认 `true`；置 false 后整条旁路关闭 |
| 写入方式 | `appendFileSync` 单行追加，失败静默吞掉 |

写入时机共 6 处：`apply()` 加载、接管、重复命中、每轮探测、恢复确认、预算耗尽或中止交还。
