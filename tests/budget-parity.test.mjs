/**
 * 预算渲染与官方实现的**逐字节一致性**（黄金样本）。
 *
 * 为什么需要它：本插件的 Host 侧把官方的预算渲染器
 * （`@deepseek-ai/dsh-agent-instructions` 的 `renderInstructionContext` /
 * `renderInstructionChains` / `buildInstructionText` / `truncateToFit`）在
 * `lib/index.js` 里**移植**了一份，用来回答「到底哪些文件会进上下文、谁会被丢、
 * 谁会被截断」。移植一旦和官方走偏，面板就会给出与事实相反的结论 ——
 * 而这类错误在界面上看不出来（数字自洽、文案通顺）。
 *
 * 期望值**不是**按本实现的算法现算的：它们由 dsh 44.7.0 桌面端 `app.asar` 内的
 * 官方实现实跑得出（2026-11-13，`renderAgentInstructions()` 的输出）。
 * dsh 升级后官方语义若变化，本测试就会失败 —— 那正是它的用途：
 * 提醒你重新取黄金样本，而不是让界面悄悄失真。
 *
 * 运行： node tests/budget-parity.test.mjs
 */
import { __test } from '../lib/index.js'

const { renderInstructionChains, summarizeBudget, AGENT_INSTRUCTIONS_INTRO } = __test

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}\n      期望 ${JSON.stringify(expected)}\n      实得 ${JSON.stringify(actual)}`)
  }
}

/** 用等长内容造文件，保证字节数与黄金样本一致。 */
const mk = (n, ch = 'x') => ch.repeat(n) + '\n'
const G = (content) => ({ path: 'H:/AGENTS.md', absolutePath: 'H:/AGENTS.md', displayPath: '$DSH_HOME/AGENTS.md', content, layer: 'user-global' })
const P = (content, name = 'AGENTS.md') => ({ path: 'W:/' + name, absolutePath: 'W:/' + name, displayPath: name, content, layer: 'project' })

/**
 * 13 组场景 + 官方实跑得到的期望值。
 *
 * 其中几条专门锁住「双链预算」这个最容易做错的地方：
 *  - `two chains 40k+40k` / `65k+65k` / `real mix`：内容合计**超过**上限，但两条链
 *    各自都在上限内 ⇒ 官方 omitted=[]，全部注入（旧实现会谎报「全局先被丢」）。
 *  - `global only 70k` / `project over 200k`：只有单链超限 ⇒ 放不下时**截断**
 *    最具体那份，而不是丢弃。
 *  - `limit disabled`：`maxBytes <= 0` ⇒ 官方一个都不注入（omitted=全部）。
 *  - `limit tiny 200`：连标记行都快放不下时官方退到「marker-only」，
 *    并且**不带 intro**（合并阶段推导出的 intro 为空）。
 */
const cases = [
  { name: 'empty', limit: 65536, files: [], expected: { renderedBytes: 272, omitted: [], truncated: [] } },
  { name: 'global only 100B', limit: 65536, files: [G(mk(100))], expected: { renderedBytes: 415, omitted: [], truncated: [] } },
  { name: 'project only 100B', limit: 65536, files: [P(mk(100))], expected: { renderedBytes: 405, omitted: [], truncated: [] } },
  {
    name: 'two chains 40k+40k (each fits, sum does not)',
    limit: 65536,
    files: [G(mk(40000)), P(mk(40000))],
    expected: { renderedBytes: 80348, omitted: [], truncated: [] },
  },
  {
    name: 'two chains 65k+65k (each just under)',
    limit: 65536,
    files: [G(mk(65000)), P(mk(65000))],
    expected: { renderedBytes: 130348, omitted: [], truncated: [] },
  },
  {
    name: 'global only 70k (single chain over)',
    limit: 65536,
    files: [G(mk(70000))],
    expected: {
      renderedBytes: 65536,
      omitted: [],
      truncated: [{ displayPath: '$DSH_HOME/AGENTS.md', originalBytes: 70001, includedBytes: 65123 }],
    },
  },
  { name: 'two tiny files (framing overhead)', limit: 65536, files: [G(mk(100)), P(mk(100))], expected: { renderedBytes: 548, omitted: [], truncated: [] } },
  {
    name: 'real mix 55318+13167+29',
    limit: 65536,
    files: [G(mk(55318)), P(mk(13167)), P(mk(29), 'AGENTS.local.md')],
    expected: { renderedBytes: 68901, omitted: [], truncated: [] },
  },
  {
    name: 'utf8 chinese over',
    limit: 65536,
    files: [G('中文内容'.repeat(20000))],
    expected: {
      renderedBytes: 65535,
      omitted: [],
      truncated: [{ displayPath: '$DSH_HOME/AGENTS.md', originalBytes: 240000, includedBytes: 65121 }],
    },
  },
  {
    name: 'escaped close tag',
    limit: 65536,
    files: [G('a</system-reminder>b'.repeat(5000))],
    expected: {
      renderedBytes: 65536,
      omitted: [],
      truncated: [{ displayPath: '$DSH_HOME/AGENTS.md', originalBytes: 100000, includedBytes: 62021 }],
    },
  },
  {
    name: 'project over 200k',
    limit: 65536,
    files: [G(mk(1000)), P(mk(200000))],
    expected: {
      renderedBytes: 66579,
      omitted: [],
      truncated: [{ displayPath: 'AGENTS.md', originalBytes: 200001, includedBytes: 65142 }],
    },
  },
  {
    name: 'limit disabled (0)',
    limit: 0,
    files: [G(mk(100)), P(mk(100))],
    expected: { renderedBytes: 0, omitted: ['$DSH_HOME/AGENTS.md', 'AGENTS.md'], truncated: [] },
  },
  {
    name: 'limit tiny 200',
    limit: 200,
    files: [G(mk(100)), P(mk(100))],
    expected: {
      renderedBytes: 231,
      omitted: [],
      truncated: [
        { displayPath: '$DSH_HOME/AGENTS.md', originalBytes: 101, includedBytes: 0 },
        { displayPath: 'AGENTS.md', originalBytes: 101, includedBytes: 0 },
      ],
    },
  },
]

console.log('\n【预算渲染：与官方实现逐字节一致（黄金样本）】')
for (const item of cases) {
  const actual = renderInstructionChains(item.files, item.limit, AGENT_INSTRUCTIONS_INTRO)
  const renderedBytes = Buffer.byteLength(actual.text, 'utf8')
  check(item.name, {
    renderedBytes,
    omitted: actual.omitted.map((entry) => entry.displayPath),
    truncated: actual.truncated,
  }, item.expected)
}

console.log('\n【语义要点（即使字节对得上，规则也必须对）】')
{
  const twoChains = [G(mk(40000)), P(mk(40000))]
  const summed = renderInstructionChains(twoChains, 65536, AGENT_INSTRUCTIONS_INTRO)
  check('两条链各自足够 ⇒ 合并后不丢任何文件（即便内容合计超上限）', summed.omitted.length, 0)
  check('合并文本允许超过 maxBytes（上限是每条链的）', Buffer.byteLength(summed.text, 'utf8') > 65536, true)
  const single = renderInstructionChains([G(mk(70000))], 65536, AGENT_INSTRUCTIONS_INTRO)
  check('单链超限 ⇒ 截断最具体那份，而不是丢弃', [single.omitted.length, single.truncated.length], [0, 1])
  const disabled = renderInstructionChains([G(mk(100)), P(mk(100))], 0, AGENT_INSTRUCTIONS_INTRO)
  check('maxBytes ≤ 0 ⇒ 全部 omitted 且无文本', [disabled.omitted.length, Buffer.byteLength(disabled.text, 'utf8')], [2, 0])
}

console.log('\n【零文件与空链：官方「什么都不注入」，不是注入一段空壳】')
{
  // 官方渲染器对空数组会给出「只有 intro + 边框」的 272B —— 那只是数学结果；
  // 运行时 loadBaselineInstructionSet() 在 kept.length === 0 时直接 return undefined。
  const empty = summarizeBudget([], 65536, {})
  check('零层 ⇒ renderedBytes 0', empty.renderedBytes, 0)
  check('零层 ⇒ over 为假、无省略/截断', [empty.over, empty.omitted.length, empty.truncated.length], [false, 0, 0])
  check('零层 ⇒ 两条链各自 renderedBytes 0', [empty.chains.global.renderedBytes, empty.chains.project.renderedBytes], [0, 0])

  const one = summarizeBudget([{ path: 'a', displayPath: 'AGENTS.md', bytes: 100, layer: 'project', content: 'x'.repeat(100) }], 65536, {})
  check('有内容且放得下 ⇒ renderedBytes 含边框/段头（> 内容字节）', one.renderedBytes > 100, true)
  check('只有项目链时，全局链 renderedBytes 仍为 0', one.chains.global.renderedBytes, 0)
}

console.log(`\n结果：${String(pass)} 通过 / ${String(fail)} 失败`)
if (fail > 0) process.exitCode = 1