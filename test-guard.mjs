/**
 * ============================================================================
 * dsh-503-guard 自测脚本（不联网、不碰真实会话）
 * ============================================================================
 *
 * 跑法：node test-guard.mjs
 *
 * 覆盖七个必须成立的契约：
 *   1. 非 SERVER 故障码 → 一个 await 都不加，立刻交还下游（不抢内置重试的活）
 *   2. 探测到 200 → 返回 {kind:'retry'}，让 agent loop 重发这一轮
 *   3. 探测持续 503 → 不返回 retry，继续等；预算耗尽后交还下游
 *   4. turn 被中止（用户点停止）→ 立刻交还下游，不悬挂
 *   5. 同一 turn/step 并发进入 → 第二次直接交还，不扇出第二份探测
 *   6. 恢复过程中写入 llm/retry 与 llm/retry-started，供界面渲染进度行
 *   7. 插件卸载（lifetime.abort）→ 在跑的探测立刻收手
 * ============================================================================
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './index.js';

let passed = 0;
let failed = 0;

/**
 * 极简断言。
 * @param {boolean} condition - 条件。
 * @param {string} label - 用例名。
 */
function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}`);
  }
}

/**
 * 构造一个假的 agent，只提供插件会用到的那一小撮接口。
 * @returns {object} 假 agent。
 */
function fakeAgent() {
  const events = [];
  return {
    events,
    session: {
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
}

/**
 * 构造一份测试配置：把退避压到毫秒级，让用例跑得快。
 * @param {object} extra - 覆盖项。
 * @returns {object} 配置。
 */
function testConfig(extra = {}) {
  return {
    initialDelayMs: 10,
    maxDelayMs: 20,
    jitterRatio: 0,
    probeTimeoutMs: 500,
    maxWaitMs: 5000,
    // 取证日志落到系统临时目录：自测不该往用户家目录写任何痕迹。
    tracePath: join(tmpdir(), 'dsh-503-guard-selftest.log'),
    ...extra,
  };
}

/** 静默 logger，避免测试输出被日志刷屏。 */
const quiet = { info() {}, warn() {}, debug() {} };

/**
 * 用例 1：非目标故障码必须原路交还。
 */
async function casePassThrough() {
  console.log('用例 1：非 SERVER 故障码直接交还下游');
  let nextCalls = 0;
  const runtime = createRuntime(testConfig(), { logger: quiet });
  const agent = fakeAgent();
  const action = await runtime.recover(
    { agent, turn: 1, step: 1, provider: 'p', failure: { code: 'RATE_LIMIT' } },
    async () => { nextCalls += 1; return undefined; }
  );
  check(nextCalls === 1, '下游被调用恰好一次');
  check(action === undefined, '本插件没有抢占恢复权');
  check(agent.events.length === 0, '没有写任何会话事件');
}

/**
 * 用例 2：探测到 200 后返回 retry。
 */
async function caseRecoverAfterOutage() {
  console.log('用例 2：探测恢复后自动续跑');
  let probes = 0;
  const runtime = createRuntime(testConfig({ initialDelayMs: 5 }), {
    logger: quiet,
    // 前两次 503，第三次 200
    fetch: async () => {
      probes += 1;
      return { status: probes < 3 ? 503 : 200 };
    },
  });
  const agent = fakeAgent();
  let nextCalls = 0;
  const action = await runtime.recover(
    { agent, turn: 2, step: 1, provider: 'deepseek', failure: { code: 'SERVER' } },
    async () => { nextCalls += 1; return undefined; }
  );
  check(probes === 3, `探测 3 次（实际 ${probes}）`);
  check(action?.kind === 'retry', '返回 {kind:"retry"}');
  check(nextCalls === 0, '没有把决定权交还下游');
  const types = agent.events.map((e) => e.type);
  check(types.includes('llm/retry'), '写了 llm/retry 进度事件');
  check(types.includes('llm/retry-started'), '写了 llm/retry-started 事件');
}

/**
 * 用例 3：一直不恢复 → 预算耗尽后交还下游。
 */
async function caseBudgetExhausted() {
  console.log('用例 3：持续 503 时预算耗尽交还下游');
  const runtime = createRuntime(
    testConfig({ initialDelayMs: 5, maxDelayMs: 10, maxWaitMs: 60 }),
    { logger: quiet, fetch: async () => ({ status: 503 }) }
  );
  const agent = fakeAgent();
  let nextCalls = 0;
  const action = await runtime.recover(
    { agent, turn: 3, step: 1, provider: 'p', failure: { code: 'SERVER' } },
    async () => { nextCalls += 1; return undefined; }
  );
  check(action === undefined, '没有返回 retry');
  check(nextCalls === 1, '下游被调用一次');
  check(agent.events.length > 0, '期间仍写入了进度事件');
}

/**
 * 用例 4：turn 中止立刻收手。
 */
async function caseAbort() {
  console.log('用例 4：用户中止时立刻交还');
  const controller = new AbortController();
  const runtime = createRuntime(
    testConfig({ initialDelayMs: 20, maxDelayMs: 20, maxWaitMs: 60000 }),
    { logger: quiet, fetch: async () => ({ status: 503 }) }
  );
  const agent = fakeAgent();
  let nextCalls = 0;
  const pending = runtime.recover(
    { agent, turn: 4, step: 1, provider: 'p', failure: { code: 'SERVER' }, signal: controller.signal },
    async () => { nextCalls += 1; return undefined; }
  );
  setTimeout(() => controller.abort(), 30);
  const action = await pending;
  check(action === undefined, '中止后没有返回 retry');
  check(nextCalls === 1, '下游被调用一次');
}

/**
 * 用例 5：同 turn/step 并发去重。
 */
async function caseDedup() {
  console.log('用例 5：同一步骤并发进入只跑一份探测');
  let probes = 0;
  const runtime = createRuntime(
    testConfig({ initialDelayMs: 10, maxWaitMs: 200 }),
    {
      logger: quiet,
      fetch: async () => { probes += 1; return { status: 503 }; },
    }
  );
  const agent = fakeAgent();
  const payload = { agent, turn: 5, step: 1, provider: 'p', failure: { code: 'SERVER' } };
  let secondNextCalls = 0;
  const first = runtime.recover(payload, async () => undefined);
  // 第二个监听器在同一毫秒进入，此时 inflight 里已经有第一份
  const second = await runtime.recover(payload, async () => { secondNextCalls += 1; return undefined; });
  check(second === undefined && secondNextCalls === 1, '第二份直接交还下游');
  await first;
  check(true, `第一份跑完（探测 ${probes} 次）`);
}

/**
 * 用例 6：插件卸载中止所有在跑的探测。
 */
async function caseDispose() {
  console.log('用例 6：插件卸载时中止探测');
  const runtime = createRuntime(
    testConfig({ initialDelayMs: 1000, maxWaitMs: 60000 }),
    { logger: quiet, fetch: async () => ({ status: 503 }) }
  );
  const agent = fakeAgent();
  let nextCalls = 0;
  const pending = runtime.recover(
    { agent, turn: 6, step: 1, provider: 'p', failure: { code: 'SERVER' } },
    async () => { nextCalls += 1; return undefined; }
  );
  setTimeout(() => runtime.lifetime.abort(), 20);
  const action = await pending;
  check(action === undefined, '卸载后没有返回 retry');
  check(nextCalls === 1, '下游被调用一次');
}

/**
 * 用例 7：探测请求本身的异常（网络不可达）算「未恢复」。
 */
async function caseProbeThrows() {
  console.log('用例 7：探测抛异常时不误判为恢复');
  let probes = 0;
  const runtime = createRuntime(testConfig({ initialDelayMs: 5, maxWaitMs: 80 }), {
    logger: quiet,
    fetch: async () => {
      probes += 1;
      if (probes <= 2) throw new Error('ECONNRESET');
      return { status: 200 };
    },
  });
  const agent = fakeAgent();
  const action = await runtime.recover(
    { agent, turn: 7, step: 1, provider: 'p', failure: { code: 'SERVER' } },
    async () => undefined
  );
  check(probes === 3, `异常两次后第三次成功（实际 ${probes}）`);
  check(action?.kind === 'retry', '第三次成功后返回 retry');
}

/**
 * 用例 8：同一步骤串行两次接管必须共用一条重试链。
 *
 * 这是 1.0.3 修的严重缺陷的回归防线：DSH 会话格式要求同一条
 * (turn, step, provider, policyKey) 链上 retryId 唯一、retry 严格 +1 递增，
 * 否则会话重新加载时抛 "llm/retry skips its policy attempt sequence"，整个会话打不开。
 */
async function caseRetryChainContinuity() {
  console.log('用例 8：同一步骤两次接管共用一条重试链');
  const runtime = createRuntime(testConfig({ initialDelayMs: 1, maxWaitMs: 500 }), {
    logger: quiet,
    fetch: async () => ({ status: 200 }),
  });
  const agent = fakeAgent();
  // 第一次接管：探测一次即恢复，inflight 随之清空
  await runtime.recover(
    { agent, turn: 9, step: 2, provider: 'p', failure: { code: 'SERVER' } },
    async () => undefined
  );
  // 第二次接管：同一个 turn/step，串行进入
  await runtime.recover(
    { agent, turn: 9, step: 2, provider: 'p', failure: { code: 'SERVER' } },
    async () => undefined
  );

  const retries = agent.events.filter((event) => event.type === 'llm/retry');
  const ids = new Set(retries.map((event) => event.data.retryId));
  const numbers = retries.map((event) => event.data.retry);
  const contiguous = numbers.every((value, index) => value === index + 1);

  check(retries.length === 2, `两次接管共写入 2 条 llm/retry（实际 ${retries.length}）`);
  check(ids.size === 1, `两条事件共用同一 retryId（实际 ${ids.size} 个）`);
  check(contiguous, `retry 序号连续递增（实际 ${numbers.join(',') || '空'}）`);
}

/**
 * 用例 9：刷新 turn 后重试链重新起量，不会把旧 turn 的序号带过来。
 */
async function caseRetryChainIsolation() {
  console.log('用例 9：不同 turn 各自独立计数');
  const runtime = createRuntime(testConfig({ initialDelayMs: 1, maxWaitMs: 500 }), {
    logger: quiet,
    fetch: async () => ({ status: 200 }),
  });
  const agent = fakeAgent();
  await runtime.recover(
    { agent, turn: 10, step: 1, provider: 'p', failure: { code: 'SERVER' } },
    async () => undefined
  );
  await runtime.recover(
    { agent, turn: 11, step: 1, provider: 'p', failure: { code: 'SERVER' } },
    async () => undefined
  );

  const retries = agent.events.filter((event) => event.type === 'llm/retry');
  check(retries.length === 2, `两个 turn 各写入 1 条 llm/retry（实际 ${retries.length}）`);
  check(
    retries.every((event) => event.data.retry === 1),
    '每个 turn 的重试序号都从 1 开始'
  );
  check(
    new Set(retries.map((event) => event.data.retryId)).size === 2,
    '不同 turn 使用不同 retryId'
  );
}

/**
 * 主流程。
 */
async function main() {
  console.log('dsh-503-guard 自测\n');
  await casePassThrough();
  await caseRecoverAfterOutage();
  await caseBudgetExhausted();
  await caseAbort();
  await caseDedup();
  await caseDispose();
  await caseProbeThrows();
  await caseRetryChainContinuity();
  await caseRetryChainIsolation();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
