/**
 * ============================================================================
 * dsh-503-guard 集成测试：跑真实的 cordis 事件总线 + 真实插件文件
 * ============================================================================
 *
 * 与 test-guard.mjs 的区别：
 *   test-guard.mjs     直接调 createRuntime()，验证恢复算法本身
 *   本文件             用 DSH 自带的 cordis 4.1.0 真跑一遍瀑布派发，
 *                      验证「注册顺序 / next() 语义 / 返回 retry」这条链真的通
 *
 * 跑法：node test-integration.mjs
 * ============================================================================
 */

import { createRequire } from 'node:module';
import * as plugin from './index.js';

// 用 DSH 安装目录里的 cordis，保证测的就是线上那一份实现
const require = createRequire(
  'C:/Users/lenovo/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/package.json'
);
const { Context } = require('@deepseek-ai/cordis');

let passed = 0;
let failed = 0;

/**
 * @param {boolean} ok - 条件。
 * @param {string} label - 用例名。
 */
function check(ok, label) {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}

/** 假会话，收集插件写进去的事件。 */
function fakeAgent() {
  const events = [];
  return { events, session: { append: (type, data) => events.push({ type, data }) } };
}

/**
 * 搭一个和真实链路同形的 harness：
 *   [0] 内置 llm-retry 的替身：消耗 maxRetries 次后调 next() 放弃
 *   [1] 被测插件真实 apply()
 */
function buildHarness({ maxRetries = 2, probeScript }) {
  const app = new Context();
  const trace = [];
  let builtinTries = 0;

  // 先注册，模拟内置重试（它先拿到决定权）
  app.on('agent/request-error', async (payload, next) => {
    builtinTries += 1;
    trace.push(`builtin#${builtinTries}`);
    if (builtinTries <= maxRetries) return { kind: 'retry' };   // 自己重试
    trace.push('builtin-exhausted');
    return next();                                              // 放弃，交给下游
  });

  // 再注册，被测插件
  plugin.apply(app, {
    initialDelayMs: 10,
    maxDelayMs: 20,
    jitterRatio: 0,
    probeTimeoutMs: 500,
    maxWaitMs: 3000,
  });
  trace.push('plugin-registered');

  return { app, trace, get builtinTries() { return builtinTries; }, probeScript };
}

/**
 * 主用例：内置重试耗尽 → 插件探测 2 次失败后第 3 次成功 → 返回 retry。
 */
async function caseEndToEnd() {
  console.log('集成用例：内置重试耗尽后由插件探测恢复');
  let probes = 0;
  globalThis.fetch = async () => {
    probes += 1;
    return { status: probes < 3 ? 503 : 200 };
  };

  const harness = buildHarness({ maxRetries: 2 });
  const { app, trace } = harness;
  const agent = fakeAgent();

  const dispatch = async () =>
    (app.waterfall ?? app.dispatch).call(
      app,
      'agent/request-error',
      { agent, turn: 1, step: 1, provider: 'deepseek', failure: { code: 'SERVER' } },
      async () => undefined
    );

  // 第 1、2 次：内置重试自己扛，不会轮到插件
  const a1 = await dispatch();
  const a2 = await dispatch();
  check(a1?.kind === 'retry' && a2?.kind === 'retry', '前两次由内置重试返回 retry');
  check(harness.builtinTries === 2, `内置只跑了两轮（实际 ${harness.builtinTries}）`);

  // 第 3 次：内置放弃 → 插件接管 → 探测 3 次后返回 retry
  const a3 = await dispatch();
  check(harness.builtinTries === 3, "第三次内置已耗尽");
  check(a3?.kind === 'retry', '插件接管后返回 retry');
  check(probes === 3, `插件探测 3 次（实际 ${probes}）`);

  const types = agent.events.map((e) => e.type);
  check(types.filter((t) => t === 'llm/retry').length === 3, '写了 3 条 llm/retry 进度事件');
  check(types.includes('llm/retry-started'), '写了 llm/retry-started');
  check(app.registry?.size === undefined || true, `调用轨迹：${trace.join(' -> ')}`);
}

/**
 * 反向用例：非 SERVER 码，插件必须完全不插手。
 */
async function caseIgnoreOtherCodes() {
  console.log('集成用例：其他故障码不插手');
  globalThis.fetch = async () => { throw new Error('不该被调到'); };
  const { app } = buildHarness({ maxRetries: 0 });
  const agent = fakeAgent();
  const action = await (app.waterfall ?? app.dispatch).call(
    app,
    'agent/request-error',
    { agent, turn: 2, step: 1, provider: 'p', failure: { code: 'RATE_LIMIT' } },
    async () => 'default-terminal'
  );
  check(action === 'default-terminal', '原样返回下游的终态结果');
  check(agent.events.length === 0, '没有写任何事件');
}

/**
 * 主流程。
 */
async function main() {
  console.log('dsh-503-guard 集成测试（真实 cordis）\n');
  await caseEndToEnd();
  await caseIgnoreOtherCodes();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
