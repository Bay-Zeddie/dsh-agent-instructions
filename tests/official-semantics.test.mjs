/**
 * 离线单测：验证 dsh-agent 对「官方源码语义」的复刻是否准确。
 *
 * 存在的意义：`minimal` preset 那种「不加载指令」的分支无法端到端验证
 * （切换 preset 要改用户的 settings.yaml，不能动），因此用纯函数直接对
 * **真实的官方文件**跑断言。
 *
 * 运行： node tests/official-semantics.test.mjs
 */
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { __test } from '../lib/index.js'

const {
  parsePresetDefault,
  parseAgentInstructionsRow,
  summarizeBudget,
  findProjectRoot,
  ancestorChain,
  isLocalOrigin,
  guard,
  DEFAULT_MAX_BYTES,
  MAX_SOURCE_BYTES,
  GUARD_HEADER,
  pathKey,
  deriveMode,
  buildAllowedTargets,
  buildLayerView,
  planModeChanges,
  pendingModeChanges,
  setLayerEnabled,
} = __test

const HARNESS_ROOT = process.env.DSH_HARNESS_ROOT ?? 'D:/agent/deepseek-harness'
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PRESETS = join(HARNESS_ROOT, 'packages', 'preset', 'agent-presets', 'presets')

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

const read = async (file) => {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

console.log('\n【1】settings.yaml 的 agent-presets.default 解析')
{
  const raw = await read(join(DSH_HOME, 'settings.yaml'))
  if (raw === null) {
    console.log('  ⏭ 跳过：读不到 settings.yaml')
  } else {
    check('解析出 default preset', parsePresetDefault(raw), 'cordis')
    check('顶层下一键不会误读', parsePresetDefault('permission:\n  defaultPreset: x\n'), null)
    check('段内 default 正确取出', parsePresetDefault('agent-presets:\n  default: ptc\n'), 'ptc')
  }
}

console.log('\n【2】preset 的 agent-instructions 行解析（对真实官方文件）')
for (const preset of ['cordis', 'standard', 'ptc']) {
  const raw = await read(join(PRESETS, preset, 'agent.cordis.yml'))
  if (raw === null) {
    console.log(`  ⏭ 跳过 ${preset}：文件不存在`)
    continue
  }
  check(`${preset} 已启用且上限为官方默认`, parseAgentInstructionsRow(raw), {
    enabled: true,
    maxBytes: DEFAULT_MAX_BYTES,
  })
}
{
  const raw = await read(join(PRESETS, 'minimal', 'agent.cordis.yml'))
  if (raw === null) {
    console.log('  ⏭ 跳过 minimal：文件不存在')
  } else {
    check('minimal 未声明 ⇒ 不加载指令', parseAgentInstructionsRow(raw), { enabled: false, maxBytes: null })
  }
}
check('disabled: true 视为未启用', parseAgentInstructionsRow('- id: agent-instructions\n  config:\n    maxBytes: 1\n  disabled: true\n'), {
  enabled: false,
  maxBytes: 1,
})
check('行不存在时返回未启用', parseAgentInstructionsRow('- id: other\n  config:\n    maxBytes: 8\n'), {
  enabled: false,
  maxBytes: null,
})

console.log('\n【3】项目根识别与目录链顺序（宽泛 → 具体）')
if (!existsSync(HARNESS_ROOT)) {
  // 这组要拿**真实的 dsh 源码树**当样本（靠它的 `.git` 与目录层级）。
  // 干净环境（CI、别人的机器）没有这棵树 ⇒ **整组跳过**，而不是拿一个不存在的路径硬跑：
  // 后者会稳定产出 4 个假失败，把真实信号淹没 —— CI 第一次跑就是这么暴露出来的。
  console.log(`  ⏭ 跳过整组：HARNESS_ROOT 不存在（${HARNESS_ROOT}）`)
  console.log('     想跑这 5 项：DSH_HARNESS_ROOT=<dsh 源码绝对路径> node tests/official-semantics.test.mjs')
} else {
  const nested = join(HARNESS_ROOT, 'packages', 'host', 'webserver')
  const root = await findProjectRoot(nested, ['.git'])
  check('从深层目录向上找到 .git 根', root.replaceAll('\\', '/').toLowerCase(), HARNESS_ROOT.replaceAll('\\', '/').toLowerCase())

  const chain = ancestorChain(HARNESS_ROOT, nested).map((p) => p.replaceAll('\\', '/').toLowerCase())
  check('链的首元素是项目根', chain[0], HARNESS_ROOT.replaceAll('\\', '/').toLowerCase())
  check('链的末元素是 cwd', chain.at(-1), nested.replaceAll('\\', '/').toLowerCase())
  check('链长 = 层数', chain.length, 4)

  const noMarker = await findProjectRoot(join(HARNESS_ROOT, 'packages', 'host'), ['__no_such_marker__'])
  check('无标记时回落 cwd', noMarker.replaceAll('\\', '/').toLowerCase(), join(HARNESS_ROOT, 'packages', 'host').replaceAll('\\', '/').toLowerCase())
}

console.log('\n【4】预算裁剪模拟（官方：从最宽泛开始丢）')
{
  const layers = [
    { path: 'g', displayPath: '<DSH_HOME>/AGENTS.md', bytes: 40000, mtime: null, layer: 'user-global' },
    { path: 'a', displayPath: 'packages/AGENTS.md', bytes: 20000, mtime: null, layer: 'project' },
    { path: 'b', displayPath: 'cwd/AGENTS.md', bytes: 10000, mtime: null, layer: 'project' },
  ]
  const fit = summarizeBudget(layers, 65536, {})
  check('合计 = 三层之和', fit.totalBytes, 70000)
  check('over 判定为真（70000 > 65536）', fit.over, true)
  check('超预算时从最宽泛开始丢（40000 → 剩 30000 已达标，丢 1 层）', fit.omitted.map((x) => x.displayPath), [
    '<DSH_HOME>/AGENTS.md',
  ])

  const tight = summarizeBudget(layers, 80000, {})
  check('放宽上限后不丢层', tight.omitted.length, 0)
  check('over 为假', tight.over, false)

  const tiny = summarizeBudget(layers, 25000, {})
  check('预算 25000 时丢掉的层（宽的在前）', tiny.omitted.map((x) => x.displayPath), [
    '<DSH_HOME>/AGENTS.md',
    'packages/AGENTS.md',
  ])

  // 官方 readBounded：单文件 > maxSourceBytes 会被完全忽略（既不加载也不报错）
  const withHuge = [
    { path: 'h', displayPath: 'huge/AGENTS.md', bytes: MAX_SOURCE_BYTES + 1, mtime: null, layer: 'project' },
    { path: 'a', displayPath: 'ok/AGENTS.md', bytes: 1000, mtime: null, layer: 'project' },
  ]
  const huge = summarizeBudget(withHuge, DEFAULT_MAX_BYTES, {})
  check('超单文件上限的层不计入合计', huge.totalBytes, 1000)
  check('超限层被标为 ignored', huge.layers.find((x) => x.displayPath === 'huge/AGENTS.md').ignored, true)
  check('超限层进入 notRendered', huge.notRendered.map((x) => x.displayPath), ['huge/AGENTS.md'])
  check('恰好等于上限不算超限', summarizeBudget([{ path: 'e', displayPath: 'e', bytes: MAX_SOURCE_BYTES, mtime: null, layer: 'project' }], DEFAULT_MAX_BYTES, {}).notRendered, [])
}

console.log('\n【5】同源栅栏判定（对齐 dsh browser-trust 语义）')
{
  const req = (headers) => ({ headers })
  check('无 Origin 放行（curl 等）', isLocalOrigin(req({})), true)
  check('同源 127.0.0.1 放行', isLocalOrigin(req({ origin: 'http://127.0.0.1:3080' })), true)
  check('localhost 放行', isLocalOrigin(req({ origin: 'http://localhost:3114' })), true)
  check('外部 Origin 拒绝', isLocalOrigin(req({ origin: 'https://evil.example' })), false)
  check('Origin: null 拒绝', isLocalOrigin(req({ origin: 'null' })), false)
  check('畸形 Origin 拒绝', isLocalOrigin(req({ origin: 'not a url' })), false)
  check('Sec-Fetch-Site: cross-site 拒绝', isLocalOrigin(req({ 'sec-fetch-site': 'cross-site' })), false)
  check('Sec-Fetch-Site: same-origin 放行', isLocalOrigin(req({ 'sec-fetch-site': 'same-origin' })), true)
}

console.log('\n【6】入口护栏 guard()（回环 + 同源 + 护栏头 + 写操作 content-type）')
{
  const res = () => {
    const state = { status: 0, ended: false }
    return {
      state,
      writeHead(status) {
        state.status = status
      },
      end() {
        state.ended = true
      },
    }
  }
  // 本机 + 同源 + 携带护栏头
  const okReq = (extra = {}) => ({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { [GUARD_HEADER]: '1', ...extra },
  })

  let r = res()
  check('本机 + 护栏头 → 放行（读）', guard(okReq(), r, false), true)

  r = res()
  check('本机 + 护栏头 + JSON → 放行（写）', guard(okReq({ 'content-type': 'application/json' }), r, true), true)

  r = res()
  check('非回环来源 → 拒绝', guard({ socket: { remoteAddress: '10.0.0.5' }, headers: { [GUARD_HEADER]: '1' } }, r, false), false)
  check('  状态码 403', r.state.status, 403)

  r = res()
  check('缺护栏头 → 拒绝（跨站 no-cors 无法设置自定义头）', guard({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, r, false), false)
  check('  状态码 403', r.state.status, 403)

  r = res()
  check('外部 Origin → 拒绝', guard(okReq({ origin: 'https://evil.example' }), r, false), false)

  r = res()
  check('写操作 content-type 非 JSON → 拒绝', guard(okReq({ 'content-type': 'text/plain;charset=UTF-8' }), r, true), false)
  check('  状态码 415', r.state.status, 415)
}

  /* ── 「工作区版 / 全局版 是否同一文件」的判据 ──
     回归用例：曾用「工作区 == DSH_HOME」这种静态判据，导致全局**暂停**后
     仍显示"两个选项指向同一个文件"（那时全局目标其实已变成 .disabled）。 */
  const samePath = __test.samePath
  check('同一路径 → 同一文件', samePath('C:\\Users\\X\\.dsh\\AGENTS.md', 'C:\\Users\\X\\.dsh\\AGENTS.md'), true)
  check('大小写不同 → 仍是同一文件（Windows）', samePath('C:\\Users\\X\\.dsh\\AGENTS.md', 'c:\\users\\x\\.dsh\\agents.md'), true)
  check('暂停态：.disabled 与 AGENTS.md 不是同一文件', samePath('C:\\Users\\X\\.dsh\\AGENTS.md.disabled', 'C:\\Users\\X\\.dsh\\AGENTS.md'), false)
  check('非字符串 → 不是同一文件', samePath(undefined, 'a'), false)

/* ══════════════════════════════════════════════════════════════════════════
   【7】【8】【9】「改哪一层」这套能力的断言。
   为什么必须离线测：这条路径会**真正改名磁盘上的文件**，端到端测它就得在
   用户真实的仓库里动手 —— 不能那么干。所以用临时目录造一份同构的 fixture，
   对真实的 rename / 白名单逻辑跑断言。
   ══════════════════════════════════════════════════════════════════════════ */
const mark = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)

const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-agent-semantics-'))
const FIX_HOME = join(fixtureRoot, 'home')
const FIX_REPO = join(fixtureRoot, 'repo')
const FIX_SUB = join(FIX_REPO, 'sub')
const FIX_OUTSIDE = join(fixtureRoot, 'outside.md')
mkdirSync(join(FIX_REPO, '.git'), { recursive: true })
mkdirSync(FIX_SUB, { recursive: true })
mkdirSync(FIX_HOME, { recursive: true })
writeFileSync(join(FIX_HOME, 'AGENTS.md'), '# global\n')
writeFileSync(join(FIX_REPO, 'AGENTS.md'), '# repo level\n')
writeFileSync(join(FIX_SUB, 'AGENTS.md'), '# sub level\n')
writeFileSync(FIX_OUTSIDE, '# must never be reachable\n')

/** 只取 buildLayerView 关心的那几列做比对，避免 mtime 抖动导致假失败。 */
const shape = (rows) => rows.map((row) => ({
  displayPath: row.displayPath.replaceAll('\\', '/'),
  layer: row.layer,
  enabled: row.enabled,
  exists: row.exists,
  bytes: row.bytes,
}))

try {
  console.log('\n【7】链内白名单 —— 可写范围的唯一入口')
  {
    const allowed = await buildAllowedTargets(FIX_SUB, FIX_HOME)
    const reachable = (file) => allowed.has(pathKey(resolve(file)))

    check('规模 = 全局 2 种形态 + 链长 2 × 4 候选 × 2 形态', allowed.size, 2 + 2 * 4 * 2)

    check('全局 AGENTS.md 可写', reachable(join(FIX_HOME, 'AGENTS.md')), true)
    check('全局 .disabled 可写（否则暂停后就再也改不回来）', reachable(join(FIX_HOME, 'AGENTS.md.disabled')), true)
    check('项目根 AGENTS.md 可写', reachable(join(FIX_REPO, 'AGENTS.md')), true)
    check('项目根 .disabled 可写', reachable(join(FIX_REPO, 'AGENTS.md.disabled')), true)
    check('本地叠加候选（AGENTS.local.md）可写', reachable(join(FIX_SUB, 'AGENTS.local.md')), true)
    check('CLAUDE.md 可写（官方候选之一）', reachable(join(FIX_SUB, 'CLAUDE.md')), true)

    // 链外路径必须一律拒绝 —— 这条不成立时，路由就退化成通用文件读写口
    check('链外：fixture 根目录的其它文件', reachable(FIX_OUTSIDE), false)
    check('链外：上级目录穿越', reachable(join(FIX_SUB, '..', '..', 'outside.md')), false)
    check('链外：DSH_HOME 里别的名字（settings.yaml）', reachable(join(FIX_HOME, 'settings.yaml')), false)
    check('链外：仓库里任意文件（package.json）', reachable(join(FIX_REPO, 'package.json')), false)
    check('链外：家目录', reachable(join(process.env.USERPROFILE ?? '/root', '.ssh', 'id_rsa')), false)
    check('链外：系统目录', reachable(process.platform === 'win32' ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/hosts'), false)
    check('链外：候选名加别的后缀也不放行', reachable(join(FIX_REPO, 'AGENTS.md.disabled.bak')), false)
  }

  console.log('\n【8】层清单与「三种模式」')
  {
    const globalState = {
      dshHome: FIX_HOME,
      activePath: join(FIX_HOME, 'AGENTS.md'),
      pausedPath: join(FIX_HOME, 'AGENTS.md.disabled'),
      path: join(FIX_HOME, 'AGENTS.md'),
      paused: false,
      file: { exists: true, bytes: 9, mtime: null },
    }
    const rows = await buildLayerView(FIX_SUB, globalState)
    check('每层一行 + 工作区那层的个性化入口', shape(rows), [
      { displayPath: '<DSH_HOME>/AGENTS.md', layer: 'user-global', enabled: true, exists: true, bytes: 9 },
      { displayPath: 'AGENTS.md', layer: 'project', enabled: true, exists: true, bytes: 13 },
      { displayPath: 'sub/AGENTS.md', layer: 'project', enabled: true, exists: true, bytes: 12 },
      // 工作区那层额外补的「我的规则（个性化）」入口：AGENTS.local.md 还没建，所以 exists=false
      { displayPath: 'sub/AGENTS.local.md', layer: 'project', enabled: false, exists: false, bytes: 0 },
    ])
    check('全启用 ⇒ 一起生效', deriveMode(rows), 'both')

    console.log('\n【9】暂停 / 恢复（只改名，一个字节都不动）')
    {
      const repoFile = join(FIX_REPO, 'AGENTS.md')
      const repoPaused = join(FIX_REPO, 'AGENTS.md.disabled')
      const before = mark(repoFile)

      const paused = await setLayerEnabled(repoFile, false)
      check('暂停：改名为 .disabled', { path: paused.path, changed: paused.changed }, { path: repoPaused, changed: true })
      check('暂停后原文件已不在', existsSync(repoFile), false)
      check('暂停后 .disabled 存在', existsSync(repoPaused), true)
      check('暂停不改内容', mark(repoPaused), before)

      const again = await setLayerEnabled(repoFile, false)
      check('重复暂停是幂等的（不再改动）', again.changed, false)
      check('  落点仍是 .disabled', again.path, repoPaused)

      const resumed = await setLayerEnabled(repoFile, true)
      check('恢复：改回官方名', { path: resumed.path, changed: resumed.changed }, { path: repoFile, changed: true })
      check('恢复后内容完全一致', mark(repoFile), before)
      check('恢复后 .disabled 已不在', existsSync(repoPaused), false)

      const noop = await setLayerEnabled(join(FIX_SUB, 'CLAUDE.md'), true)
      check('对不存在的层「启用」不报错也不建文件', { changed: noop.changed, exists: existsSync(join(FIX_SUB, 'CLAUDE.md')) }, {
        changed: false,
        exists: false,
      })

      // 暂停项目根后：模式推导与「仅全局」的改名计划
      await setLayerEnabled(repoFile, false)
      const pausedRows = await buildLayerView(FIX_SUB, globalState)
      check('项目根暂停 ⇒ 该行 enabled=false 但仍在清单里', shape(pausedRows).map((row) => row.enabled), [true, false, true, false])
      check('只有部分项目层暂停 ⇒ 凑不成三种模式', deriveMode(pausedRows), 'custom')

      const rowsForPlan = await buildLayerView(FIX_SUB, globalState)
      const planGlobal = planModeChanges('global', rowsForPlan)
      check('「仅全局」计划：全局启用 + 两个项目层暂停', planGlobal.map((item) => item.enabled), [true, false, false])
      const planProject = planModeChanges('project', rowsForPlan)
      check('「仅项目」计划：全局暂停 + 项目层启用', planProject.map((item) => item.enabled), [false, true, true])
      const planBoth = planModeChanges('both', rowsForPlan)
      check('「一起」计划：全部启用', planBoth.map((item) => item.enabled), [true, true, true])

      // pendingModeChanges = 界面确认框要列的那份清单：只含「状态确实需要改变」的层。
      // 此刻项目根已暂停、子层仍启用 ⇒「仅全局」只需要动子层这一份。
      const pendingGlobal = pendingModeChanges('global', rowsForPlan)
      check('pending「仅全局」只列真正要动的层', pendingGlobal.map((item) => item.displayPath.replaceAll('\\', '/')), ['sub/AGENTS.md'])
      check('  且目标状态正确', pendingGlobal.map((item) => item.enabled), [false])
      check('pending「一起」只列已暂停的两份', pendingModeChanges('both', rowsForPlan).map((item) => item.displayPath.replaceAll('\\', '/')), [
        'AGENTS.md',
      ])

      // 真跑一遍「仅全局」的改名计划，再推导模式 —— 端到端闭环
      for (const item of planGlobal) await setLayerEnabled(item.base, item.enabled)
      const afterGlobal = await buildLayerView(FIX_SUB, globalState)
      check('「仅全局」执行后：全局启用、项目层全部暂停', shape(afterGlobal).map((row) => row.enabled), [true, false, false, false])
      check('「仅全局」执行后模式推导正确', deriveMode(afterGlobal), 'global')
      check('子层内容仍在（只是换了名字）', mark(join(FIX_SUB, 'AGENTS.md.disabled')), '# sub level\n')

      // 再一键回到「一起」
      for (const item of planBoth) await setLayerEnabled(item.base, item.enabled)
      const afterBoth = await buildLayerView(FIX_SUB, globalState)
      check('一键恢复「一起」后模式推导正确', deriveMode(afterBoth), 'both')
      check('恢复后子层文件名回到官方名', existsSync(join(FIX_SUB, 'AGENTS.md')), true)
    }
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}

/* 回归用例：实测在 dsh 自己的仓库里发现 `AGENTS.md`(17,182B) 与 `CLAUDE.md`(9B) 并存，
   当时列表把同目录折叠成一行 ⇒ 第二份没有编辑入口，界面还同时显示「3 个文件会生效」和 2 行。
   官方语义是**同目录所有候选都读**、只有 trimmed 内容相同的才去重。 */
console.log('\n【10】同目录多候选：全部列出，同内容才去重')
{
  const root2 = mkdtempSync(join(tmpdir(), 'dsh-agent-dedup-'))
  const home2 = join(root2, 'home')
  const repo2 = join(root2, 'repo')
  mkdirSync(join(repo2, '.git'), { recursive: true })
  mkdirSync(home2, { recursive: true })
  writeFileSync(join(repo2, 'AGENTS.md'), '# A\n')
  writeFileSync(join(repo2, 'CLAUDE.md'), '# B\n')
  writeFileSync(join(repo2, 'AGENTS.local.md'), '# A\n')

  const rows = await buildLayerView(repo2, {
    dshHome: home2,
    activePath: join(home2, 'AGENTS.md'),
    pausedPath: join(home2, 'AGENTS.md.disabled'),
    path: join(home2, 'AGENTS.md'),
    paused: false,
    file: { exists: false, bytes: 0, mtime: null },
  })
  check('同目录候选逐个列出（不折叠）', rows.map((row) => row.displayPath.replaceAll('\\', '/')), [
    '<DSH_HOME>/AGENTS.md',
    'AGENTS.md',
    'CLAUDE.md',
    'AGENTS.local.md',
  ])
  check('included：全局不存在 + 不同内容的两份', rows.map((row) => row.included), [false, true, true, false])
  check('只有 trimmed 内容相同的那份被标去重', rows.map((row) => row.duplicate), [false, false, false, true])
  check('去重按「最早候选优先」保留 AGENTS.md', rows.find((row) => row.duplicate).displayPath, 'AGENTS.local.md')

  rmSync(root2, { recursive: true, force: true })
}

/* 回归用例：用户把**工作区设成 dsh 配置目录本身**（例如 `C:\Users\X\.dsh`）时的情形。
   那时「全局层」与「项目层」指向**同一个文件**。曾经的后果（用户实测反馈）：
   ① 列表把同一份文件列成两行；② 切生效范围的改名计划里同一个 base 出现两次，
   而执行顺序决定最终状态 ⇒ 点「仅全局」（全局启用 + 项目暂停）反而把文件**暂停**了，
   界面上则显示成「自定义」—— 按钮怎么点都不会亮。 */
console.log('\n【11】工作区 == DSH_HOME：全局层与项目层其实是同一个文件')
{
  const root3 = mkdtempSync(join(tmpdir(), 'dsh-agent-collide-'))
  const home3 = join(root3, 'home')
  mkdirSync(home3, { recursive: true })
  writeFileSync(join(home3, 'AGENTS.md'), '# global\n')

  const g3 = {
    dshHome: home3,
    activePath: join(home3, 'AGENTS.md'),
    pausedPath: join(home3, 'AGENTS.md.disabled'),
    path: join(home3, 'AGENTS.md'),
    paused: false,
    file: { exists: true, bytes: 9, mtime: null },
  }

  const rows3 = await buildLayerView(home3, g3)
  // 工作区 == DSH_HOME 时，与全局同路径的项目候选被跳过 ⇒ 只有 1 行**真实存在**的文件；
  // 另外工作区那层会补一个「个性化」入口（AGENTS.local.md，未创建）—— 它是独立文件，不算重复。
  const existing3 = rows3.filter((row) => row.exists)
  check('同一份文件只列一行', existing3.length, 1)
  check('  且这一行就是全局层', existing3[0].layer, 'user-global')
  check('  另有 1 个未创建的个性化入口', rows3.filter((row) => !row.exists).length, 1)
  check('  唯一 base 数 == 行数（无重复文件）', new Set(rows3.map((row) => pathKey(row.base))).size, rows3.length)

  for (const mode of ['both', 'project', 'global']) {
    const plan = planModeChanges(mode, rows3)
    check(`  「${mode}」计划里同一个文件不会被改两次`, plan.length, new Set(plan.map((c) => pathKey(c.base))).size)
  }

  // 端到端：跑「仅全局」应当让这份文件**启用**（曾经是反而被暂停）
  for (const item of planModeChanges('global', rows3)) await setLayerEnabled(item.base, item.enabled)
  check('「仅全局」后文件用官方名（启用）', existsSync(join(home3, 'AGENTS.md')), true)
  check('  且没有 .disabled 残留', existsSync(join(home3, 'AGENTS.md.disabled')), false)
  check('  模式判定不再是「自定义」', deriveMode(await buildLayerView(home3, g3)), 'both')

  // 「仅项目」= 让唯一那份文件不生效（这里没有独立的项目文件，语义仍然自洽）
  for (const item of planModeChanges('project', rows3)) await setLayerEnabled(item.base, item.enabled)
  check('「仅项目」后文件被暂停', existsSync(join(home3, 'AGENTS.md.disabled')), true)
  check('  模式判定为「仅项目」', deriveMode(await buildLayerView(home3, g3)), 'project')

  rmSync(root3, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
