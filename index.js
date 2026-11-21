/**
 * ============================================================================
 * dsh-503-guard —— 服务端故障自愈守卫（Host 半）
 * ============================================================================
 *
 * 【它解决什么问题】
 *   模型请求被上游网关拒绝（HTTP 5xx，典型就是 503 Service Unavailable）时，
 *   DSH 内置的 llm-retry 只会做「有限次、固定退避」的重试（默认 5 次）。
 *   5 次挥完，本轮就报「本轮运行失败」，用户只能手动重发。
 *   本插件在那之后接管：不再盲目重试，而是【主动探测上游是否恢复】，
 *   一旦探测到恢复，立刻把这一轮重新拉起来，用户不需要动一根手指。
 *
 * 【接在哪个扩展点上】
 *   agent/request-error 是一次模型请求失败后、agent loop 决定「重试还是收尾」
 *   的瀑布事件（waterfall）。签名见 dsh-tool-cordis/lib/types/api-catalog.js：
 *
 *     'agent/request-error'(
 *        this: Scoped<Agent>,
 *        payload: { agent, turn, step, provider, failure, retryPolicy, signal },
 *        next: () => Promise<RequestErrorAction>
 *     ): Promise<RequestErrorAction>
 *
 *   约定很干净：
 *     - 监听器返回 { kind: 'retry' } 且【不调用 next()】= 我自己负责恢复
 *     - 监听器调用 next() = 把决定权交给下游（内置 llm-retry / 默认终止）
 *     - 全都返回 undefined = 该故障按终态处理
 *   所以本插件只在「内置重试已经放弃」的那一刻才真正干活，
 *   不抢内置策略的活，也不会和它打架。
 *
 * 【失败码从哪来】
 *   dsh-llm-deepseek/lib/index.js:1822
 *     else if (status !== void 0 && status >= 500 || ["api_error","overloaded_error"].includes(type))
 *         code = "SERVER";
 *   也就是说 HTTP 503 在 DSH 内部统一归一化成 failure.code === 'SERVER'。
 *   聊天界面右下角那个红色的 SERVER 标签，就是这个 code。
 *   因此默认匹配集合是 ['SERVER']，覆盖全部 5xx。
 *
 * 【探测怎么做】
 *   默认对 https://api.deepseek.com/v1/models 发 GET：
 *     - 状态码 < 500（200/401/403/429 都算）→ 网关活着，判定「已恢复」
 *     - 502/503/504 或连不上 → 判定「未恢复」，继续等
 *   用 401 当「活着」是刻意的：没带凭证的请求本来就该 401，
 *   能返回 401 说明 DNS、TLS、网关、路由全都通了，正是我们要的信号。
 *
 * 【界面反馈】
 *   每次探测前往会话里追加一条 llm/retry 事件，界面就会渲染出
 *   「已重试模型请求（n/m）· Xs」那一行（和内置重试条同一个渲染器，
 *   见 dsh-client-ui-chat 的 retryDefinition / scheduledNode）。
 *   探测成功后补一条 llm/retry-started，那条行的状态位从「等待」变成「已开始」。
 *   追加事件失败不影响恢复逻辑本身，全部 try/catch 兜住。
 *
 * 【安全阀】
 *   - 总等待预算 maxWaitMs（默认 30 分钟），超时后交还下游按终态处理
 *   - 每轮 turn/step 只允许一段恢复流程，避免同一故障并发跑出两份探测
 *   - turn 的中止信号（payload.signal）一旦 abort，立刻停手并交还下游
 *   - 插件被卸载（ctx.effect 的清理函数）时中止全部在跑的探测
 * ============================================================================
 */

import { randomUUID } from 'node:crypto';

/** 插件在 Loader 里的行标识，和 cordis.patch.yml 中的 id 对应。 */
export const name = 'dsh-503-guard';

/**
 * 默认配置。
 * 全部可以在 cordis.patch.yml 的 config 段里覆盖，也可以在设置里改（若暴露）。
 */
const DEFAULTS = {
  /** 触发自愈的 failure.code 集合。SERVER 覆盖全部 5xx，含 503。 */
  codes: ['SERVER'],
  /** 健康探测地址。默认探 DeepSeek 的模型列表接口，它的鉴权要求最低。 */
  probeUrl: 'https://api.deepseek.com/v1/models',
  /** 探测请求附带的请求头，例如 { Authorization: 'Bearer sk-...' }。 */
  probeHeaders: {},
  /** 单次探测的超时（毫秒）。探测本身不能把恢复流程拖死。 */
  probeTimeoutMs: 8000,
  /** 第一次探测前的等待（毫秒）。给上游一点点喘息时间，避免打脸。 */
  initialDelayMs: 5000,
  /** 探测间隔上限（毫秒）。指数退避到这里封顶。 */
  maxDelayMs: 30000,
  /** 退避抖动比例，0.2 表示 ±20%，避免多会话同时探测形成尖峰。 */
  jitterRatio: 0.2,
  /** 单个故障点允许等待的总预算（毫秒）。默认 30 分钟。 */
  maxWaitMs: 1800000,
  /** 状态码低于这个值就判定「已恢复」。默认 500。 */
  healthyStatusBelow: 500,
  /** 是否往会话里写 llm/retry 事件以驱动界面上的重试行。 */
  announce: true,
};

/**
 * 把用户配置和默认值合并。
 * 只接受已知键，避免拼错的键把默认值悄悄顶掉。
 * @param {object} raw - Loader 传进来的原始配置。
 * @returns {object} 合并后的配置。
 */
function resolveConfig(raw) {
  const out = { ...DEFAULTS };
  if (raw === null || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    // 数组和对象要单独拷贝，避免调用方后续改动影响运行中的配置。
    if (Array.isArray(value)) out[key] = [...value];
    else if (typeof value === 'object') out[key] = { ...value };
    else out[key] = value;
  }
  return out;
}

/**
 * 可被中止的等待。
 * 中止信号一响立刻返回 false，恢复流程据此判断该收手了。
 * @param {number} ms - 等待毫秒数。
 * @param {AbortSignal} signal - 中止信号。
 * @returns {Promise<boolean>} true 表示等满了，false 表示被中止。
 */
function sleep(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 第 n 次探测前的退避时长（带抖动，且不超过上限）。
 * @param {object} cfg - 运行配置。
 * @param {number} attempt - 已经探测过的次数（从 0 开始）。
 * @param {() => number} random - 随机源，测试时可注入定值。
 * @returns {number} 毫秒。
 */
function backoffDelay(cfg, attempt, random) {
  const exponent = Math.min(attempt, 16);
  const raw = Math.min(cfg.initialDelayMs * 2 ** exponent, cfg.maxDelayMs);
  const jitter = 1 - cfg.jitterRatio + 2 * cfg.jitterRatio * random();
  // 下界不额外钳 1s：退避本身从 initialDelayMs 起算，硬钳会把
  // 自定义的小间隔（以及自测用的小毫秒配置）统统顶掉。
  return Math.max(0, Math.min(raw * jitter, cfg.maxDelayMs));
}

/**
 * 创建一份运行态。把依赖（fetch / 时间 / 随机 / 日志）显式注入，
 * 这样单元测试不用碰真实网络就能把整条恢复流程跑一遍。
 * @param {object} config - 原始配置。
 * @param {object} deps - 依赖注入点。
 * @returns {object} 恢复流程的可调用入口。
 */
export function createRuntime(config, deps = {}) {
  const cfg = resolveConfig(config);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const log = deps.logger ?? console;

  /** 插件级生命周期信号：插件卸载时统一掐断所有在跑的探测。 */
  const lifetime = new AbortController();

  /** 每个 agent 当前正在进行的恢复流程，防止同一故障并发跑出两份。 */
  const inflight = new WeakMap();

  /**
   * 单次健康探测。
   * 任何非 5xx 的响应、甚至鉴权失败，都代表网关可达，即视为恢复。
   * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
   */
  async function probeOnce() {
    if (typeof doFetch !== 'function') return { ok: true, status: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.probeTimeoutMs);
    try {
      const response = await doFetch(cfg.probeUrl, {
        method: 'GET',
        headers: { 'user-agent': 'dsh-503-guard', ...cfg.probeHeaders },
        signal: controller.signal,
      });
      const status = Number(response?.status ?? 0);
      return { ok: status > 0 && status < cfg.healthyStatusBelow, status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 往会话里追加一条 llm/retry 事件，界面据此渲染「已重试模型请求」行。
   * 事件是 DSH 的已知类型（KNOWN_SESSION_EVENT_TYPES 里有 llm/retry），
   * 因此按普通事件追加即可；追加失败只记日志，绝不打断恢复。
   * @param {object} agent - 正在跑的 agent。
   * @param {object} fields - 事件字段。
   */
  function appendEvent(agent, type, fields) {
    if (!cfg.announce) return;
    try {
      agent?.session?.append?.(type, fields);
    } catch (error) {
      log.warn?.(`dsh-503-guard: 会话事件写入失败（不影响恢复）：${String(error)}`);
    }
  }

  /**
   * 处理一次 request-error。
   * 只有目标故障码才会接管；其余情况原样交给下游。
   * @param {object} payload - agent/request-error 的载荷。
   * @param {Function} next - 下游监听器。
   * @returns {Promise<object|undefined>} {kind:'retry'} 表示由本插件负责重试。
   */
  async function recover(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload ?? {};
    const code = failure?.code;

    // 不是我们管的故障码：立刻交还下游，一个 await 都不加。
    if (!cfg.codes.includes(code)) return next();

    // 同一个 turn/step 已经在恢复了：这次直接交还，避免扇出多份探测。
    const running = inflight.get(agent);
    if (running !== undefined && running.turn === turn && running.step === step) return next();

    const token = { turn, step, attempts: 0, startedAt: now() };
    inflight.set(agent, token);

    // 把 turn 的中止信号和插件生命周期信号合并成一个，任一触发都收手。
    const fused = signal === undefined
      ? lifetime.signal
      : AbortSignal.any([signal, lifetime.signal]);

    const retryId = randomUUID();
    const deadline = token.startedAt + cfg.maxWaitMs;
    log.info?.(
      `dsh-503-guard: 检测到 ${code}（provider=${String(provider)}），转入后台探测恢复，` +
      `预算 ${Math.round(cfg.maxWaitMs / 1000)}s`
    );

    while (!fused.aborted) {
      // 预算耗尽：不再无限等下去，交还下游按终态处理。
      if (now() >= deadline) {
        log.warn?.('dsh-503-guard: 等待预算耗尽，交还默认处理');
        if (inflight.get(agent) === token) inflight.delete(agent);
        return next();
      }

      const delay = backoffDelay(cfg, token.attempts, random);

      // 先落事件再等待：界面上立刻能看到「等待重试」这一行。
      appendEvent(agent, 'llm/retry', {
        retryId,
        turn,
        step,
        provider,
        mode: 'normal',
        policyKey: 'dsh-503-guard',
        retry: token.attempts + 1,
        maxRetries: 99,
        delayMs: delay,
        failure,
      });

      if (!(await sleep(delay, fused))) break;

      const health = await probeOnce();
      token.attempts += 1;
      if (fused.aborted) break;

      if (health.ok) {
        // 探测通过：补一条「已开始重试」，让界面那行的状态位翻过来。
        appendEvent(agent, 'llm/retry-started', {
          retryId,
          turn,
          step,
          retry: token.attempts,
        });
        if (inflight.get(agent) === token) inflight.delete(agent);
        log.info?.(
          `dsh-503-guard: 上游已恢复（status=${String(health.status)}），` +
          `第 ${token.attempts} 次探测后自动续跑`
        );
        return { kind: 'retry' };
      }

      log.debug?.(
        `dsh-503-guard: 第 ${token.attempts} 次探测仍未恢复` +
        `（status=${String(health.status ?? '-')}${health.error ? ` ${health.error}` : ''}）`
      );
    }

    // 被中止（用户点了停止 / 插件卸载）：干净地交还下游。
    if (inflight.get(agent) === token) inflight.delete(agent);
    log.info?.('dsh-503-guard: 恢复流程被中止，交还默认处理');
    return next();
  }

  return { recover, probeOnce, config: cfg, lifetime, inflight };
}

/**
 * 插件入口。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - Loader 传入的配置。
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(config, { logger: ctx.logger });

  // 挂到 request-error 瀑布上。返回 Promise 即代表「本监听器还在处理中」，
  // 等待期间 agent 的这一步不会收尾，恢复成功后直接重试。
  ctx.on('agent/request-error', (payload, next) => runtime.recover(payload, next));

  // 插件卸载时掐断所有仍在等待的探测，避免悬挂的定时器拖住进程退出。
  ctx.effect(() => () => {
    runtime.lifetime.abort();
  }, 'dsh-503-guard: 中止在跑的恢复探测');
}
