/**
 * 随机化（fuzz）测试：对 host 侧纯函数做大量随机输入，断言**性质不变量**。
 *
 * 与 official-semantics.test.mjs 的分工：
 *   - 那个是「拿真实官方文件验语义」（具体值）；
 *   - 这个是「随机输入验性质」（不变量）—— 专找边界与组合。
 *
 * ⚠️ 断言结构**已逐条对照 lib/index.js 的 summarizeBudget 源码核对**：
 *   - r.layers      = **全部**层（含被忽略者），带 { path, displayPath, bytes, mtime, layer, ignored }
 *   - r.omitted     = 被丢弃的最宽泛前缀，条目只有 { displayPath, bytes, layer }（**没有 path**）
 *   - r.notRendered = 超单文件上限的层，条目同样只有 { displayPath, bytes, layer }
 *   - 裁剪保证至少保留一层（omittedCount 最多为 kept.length - 1，即"最具体那份即使超限也保留并截断"）
 *
 * 固定种子，失败可复现。运行： node tests/fuzz-local.mjs [迭代数]
 */
import { __test } from '../lib/index.js'
import { resolve, sep } from 'node:path'

const {
  parsePresetDefault,
  parseAgentInstructionsRow,
  summarizeBudget,
  ancestorChain,
  isLocalOrigin,
  guard,
  samePath,
  MAX_SOURCE_BYTES,
  GUARD_HEADER,
} = __test

function mulberry32(seed) {
  return function next() {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ITER = Number(process.argv[2] ?? 300)
const rand = mulberry32(20260920)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const int = (min, max) => min + Math.floor(rand() * (max - min + 1))

let pass = 0
let fail = 0
const failures = []
const ok = () => { pass += 1 }
const bad = (label, detail) => {
  fail += 1
  if (failures.length < 12) failures.push(`${label} :: ${detail}`)
}

/* ── 1. summarizeBudget 的性质 ── */
for (let i = 0; i < ITER; i += 1) {
  const count = int(0, 8)
  const layers = []
  for (let j = 0; j < count; j += 1) {
    layers.push({
      path: `p${j}`,
      displayPath: `p${j}`,
      bytes: pick([0, 1, 1024, 65536, MAX_SOURCE_BYTES - 1, MAX_SOURCE_BYTES, MAX_SOURCE_BYTES + 1, 2_000_000, int(0, 300000)]),
      mtime: null,
      layer: j === 0 ? 'user-global' : 'project',
    })
  }
  const limit = pick([1, 1024, 65536, 200000, int(1, 300000)])
  const r = summarizeBudget(layers, limit, {})
  const tag = `n=${count} limit=${limit}`
  const kept = layers.filter((l) => l.bytes <= MAX_SOURCE_BYTES)
  const tooBig = layers.filter((l) => l.bytes > MAX_SOURCE_BYTES)
  const sumKept = kept.reduce((s, l) => s + l.bytes, 0)
  const keptNames = kept.map((l) => l.displayPath)
  const omittedNames = (r.omitted ?? []).map((l) => l.displayPath)
  const notRenderedNames = (r.notRendered ?? []).map((l) => l.displayPath)

  if (r.totalBytes !== sumKept) bad('A totalBytes=可读层之和', `${tag} got=${r.totalBytes} want=${sumKept}`)
  else if (r.limit !== limit) bad('A limit 原样返回', tag)
  else if (r.over !== (sumKept > limit)) bad('A over 判定', `${tag} total=${sumKept}`)
  else ok()

  if (!Array.isArray(r.layers) || r.layers.length !== layers.length) bad('B layers 回报全部层', `${tag} got=${r.layers && r.layers.length}`)
  else if (r.layers.some((l) => l.ignored !== (l.bytes > MAX_SOURCE_BYTES))) bad('B ignored 标记', tag)
  else ok()

  if (notRenderedNames.join('|') !== tooBig.map((l) => l.displayPath).join('|')) bad('C notRendered=超限层', `${tag} got=${notRenderedNames}`)
  else ok()

  if (!r.over && omittedNames.length > 0) bad('D 未超限却省略', tag)
  else ok()

  if (omittedNames.join('|') !== keptNames.slice(0, omittedNames.length).join('|')) bad('E 省略=最宽泛前缀', `${tag} kept=${keptNames} omitted=${omittedNames}`)
  else ok()

  if (r.over && kept.length > 0 && omittedNames.length > kept.length - 1) bad('F 至少保留一层', `${tag} kept=${kept.length} omitted=${omittedNames.length}`)
  else ok()

  if (notRenderedNames.some((n) => omittedNames.includes(n))) bad('G 被忽略层不入 omitted', tag)
  else ok()
}

/* ── 2. ancestorChain 的性质 ── */
const roots = ['C:\\a', 'C:\\a\\b', 'C:\\a\\b\\c\\d', '/x', '/x/y/z']
for (let i = 0; i < ITER; i += 1) {
  const root = pick(roots)
  const extra = int(0, 4)
  let cwd = root
  for (let j = 0; j < extra; j += 1) cwd += sep + `n${int(0, 9)}`
  const tag = `root=${root} cwd=${cwd}`
  const chain = ancestorChain(root, cwd)
  if (!Array.isArray(chain) || chain.length === 0) bad('H 非空数组', tag)
  else if (chain[0] !== resolve(root)) bad('H 首项=root', `${tag} got=${chain[0]}`)
  else if (chain[chain.length - 1] !== resolve(cwd)) bad('H 末项=cwd', `${tag} got=${chain[chain.length - 1]}`)
  else if (chain.length !== extra + 1) bad('H 长度=层数', `${tag} got=${chain.length} want=${extra + 1}`)
  else if (new Set(chain.map((p) => p.toLowerCase())).size !== chain.length) bad('H 无重复', tag)
  else ok()

  try {
    ancestorChain('C:\\zzz\\q', cwd)
    ok()
  } catch {
    bad('I 非祖孙关系不抛异常', tag)
  }
}

/* ── 3. 两个解析器：任意输入不抛 + 类型正确 ── */
const samples = [
  '', '   ', '\n\n', 'agent-presets:\n  default: cordis\n', 'agent-presets:\r\n  default: ptc\r\n',
  'agent-presets:\n\tdefault: tabs\n', 'agent-presets:\n  default: "quoted"\n', "agent-presets:\n  default: 'single'\n",
  'agent-presets:\n  default: 123\n', 'agent-presets:\n  default:\n', 'agent-presets:\n  default: a:b:c\n',
  'permission:\n  defaultPreset: x\n', 'agent-presets:\n  other: y\n', '# c\nagent-presets:\n  default: ok\n',
  'agent-presets:\n  - id: agent-instructions\n    maxBytes: 65536\n', 'agent-presets:\n  - id: other\n',
  'a'.repeat(5000), 'agent-presets:\n  default: ' + 'x'.repeat(3000) + '\n',
  '  - id: agent-instructions\n', '- id: agent-instructions\n  maxBytes: notanumber\n',
]
for (const raw of samples) {
  const tag = JSON.stringify(raw.slice(0, 24))
  try {
    const d = parsePresetDefault(raw)
    if (d !== null && typeof d !== 'string') bad('J parsePresetDefault 类型', `${tag} → ${typeof d}`)
    else ok()
  } catch (e) {
    bad('J parsePresetDefault 不抛', `${tag} → ${e.message}`)
  }
  try {
    const row = parseAgentInstructionsRow(raw)
    if (row !== null && typeof row !== 'object') bad('K parseAgentInstructionsRow 类型', `${tag} → ${typeof row}`)
    else ok()
  } catch (e) {
    bad('K parseAgentInstructionsRow 不抛', `${tag} → ${e.message}`)
  }
}

/* ── 4. 安全性质：来源判定 + 护栏 ── */
const origins = [
  undefined, '', 'null', 'http://127.0.0.1:3080', 'http://localhost:1', 'https://evil.example',
  'http://127.0.0.1.evil.com', 'ftp://127.0.0.1', 'http://[::1]:3080', 'not a url', 'HTTP://127.0.0.1:80',
  'http://127.0.0.2', 'http://0.0.0.0:1', 'https://127.0.0.1.evil.com',
]
for (const origin of origins) {
  const name = String(origin)
  try {
    const v = isLocalOrigin({ headers: origin === undefined ? {} : { origin }, socket: { remoteAddress: '127.0.0.1' } })
    // 期望值表：按源码语义 —— 只校验 hostname 是否本机（不看 scheme）；无法解析则拒绝
    const DENY = ['null', 'https://evil.example', 'http://127.0.0.1.evil.com', 'https://127.0.0.1.evil.com', 'not a url', 'http://127.0.0.2', 'http://0.0.0.0:1']
    const ALLOW = [undefined, '', 'http://127.0.0.1:3080', 'http://localhost:1', 'http://[::1]:3080', 'HTTP://127.0.0.1:80', 'ftp://127.0.0.1']
    const want = DENY.includes(origin) ? false : ALLOW.includes(origin) ? true : null
    if (typeof v !== 'boolean') bad('L 返回布尔', name)
    else if (want === null) bad('L 未覆盖的样例', name)
    else if (v !== want) bad('L 期望 ' + JSON.stringify(want) + ' 得到 ' + JSON.stringify(v), name)
    else ok()
  } catch (e) {
    bad('L isLocalOrigin 不抛', `${name} → ${e.message}`)
  }

  const mkRes = () => ({ status: 0, writeHead(s) { this.status = s }, end() {} })
  const base = { headers: { [GUARD_HEADER]: '1' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }
  try {
    if (guard({ ...base, socket: { remoteAddress: '10.0.0.5' } }, mkRes(), false) !== false) bad('M 非回环必须拒绝', '放行了')
    else ok()
    if (guard({ ...base, headers: {} }, mkRes(), false) !== false) bad('N 缺护栏头必须拒绝', '放行了')
    else ok()
    if (guard(base, mkRes(), false) !== true) bad('O 回环+护栏头应放行', '被拒了')
    else ok()
  } catch (e) {
    bad('P guard 不抛', e.message)
  }
}

/* ── 5. samePath 的代数性质 ── */
const paths = ['C:\\a\\b', 'c:\\A\\B', 'C:\\a\\b\\', '/x/y', '/X/Y', '', 'a', 'C:\\a\\b\\c']
for (const a of paths) {
  if (samePath(a, a) !== true) bad('Q samePath 自反', a)
  else ok()
  for (const b of paths) {
    if (samePath(a, b) !== samePath(b, a)) bad('Q samePath 对称', `${a} vs ${b}`)
    else ok()
  }
}
for (const v of [undefined, null, 0, {}, []]) {
  if (samePath(v, 'a') !== false) bad('R samePath 非字符串→false', String(v))
  else ok()
}

console.log(`\n随机化测试：${ITER} 轮 · 18 组性质`)
console.log(`断言：${pass} 通过 / ${fail} 失败\n`)
if (fail > 0) {
  console.log('反例（种子 20260920）：')
  for (const f of failures) console.log('  · ' + f)
  console.log('')
}
process.exit(fail === 0 ? 0 : 1)
