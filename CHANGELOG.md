# 变更记录

本文件的日期为发布当日。

## 1.0.2 — 2026-11-22

### 变更

- **包名改为 scoped：`@ltw2522/dsh-503-guard`**。目的只有一个：在 npm 搜索和插件市场里一眼能看出是谁维护的，也彻底避免与他人撞名。npm 不支持给已发布的包改名，所以这是以新名字重新发布；旧包 `dsh-503-guard` 已标记 deprecated，指向这里。
- `cordis.patch.yml` 的条目 `name` 同步改为 `@ltw2522/dsh-503-guard`（加载器按包名解析模块，名称必须一致）。
- `publishConfig.access` 设为 `public`，避免 scoped 包被当成私有包发布失败。
- 安装命令变更：`npm i @ltw2522/dsh-503-guard`。

### 不受影响

- 插件内部标识 `id: server-503-guard`、日志路径 `~/.dsh/dsh-503-guard.log`、配置项与判定逻辑全部不变；已装的用户升级只换包名。

## 1.0.1 — 2026-11-22

### 新增

- **取证日志**。插件在 `apply()` 执行时写一行「插件已激活」，接管故障时写「接管 turn/step code/provider」，每轮探测写「探测 #n ok/status/err」，判定恢复写「恢复确认」，交还下游时写原因。落点默认 `~/.dsh/dsh-503-guard.log`。
  动机：DSH 的会话日志只记录最终结果，看不到 waterfall 内部是谁接的球，导致「插件到底有没有生效」只能靠猜。有了这条旁路，任何一次 5xx 都能事后复盘。
- 新增配置项 `trace`（默认 `true`）与 `tracePath`（默认空 → `~/.dsh/dsh-503-guard.log`）。`trace: false` 可关掉整条旁路。
- `createRuntime()` 的返回值新增 `trace`，便于宿主或测试直接写入取证日志。
- 打包新增 `CHANGELOG.md`。

### 变更

- 自测用例数不变（19 + 10），但 `test-guard.mjs` 现在把 `tracePath` 指向临时文件，不再往用户家目录写测试痕迹。

### 不受影响

- 判定逻辑、退避曲线、预算、并发去重、`next()` 交还语义与 1.0.0 完全一致；升级无需改动 `cordis.patch.yml`。

## 1.0.0 — 2026-11-21

首发。

- 挂 `agent/request-error` waterfall，只认 `failure.code === 'SERVER'`。
- 内置 `llm-retry` 耗尽后接管，按 5s → 10s → 20s → 30s 封顶探测 `GET https://api.deepseek.com/v1/models`，状态码 `< 500` 即判定恢复。
- 恢复后返回 `{ kind: 'retry' }` 让 agent loop 重发该轮；等待期间写 `llm/retry` 事件复用内置重试条的渲染。
- 安全阀：30 分钟总预算、`payload.signal` 中止、按 `turn/step` 去重、`ctx.effect` 卸载清理。
