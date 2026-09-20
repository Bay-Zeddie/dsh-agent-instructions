/**
 * 前后端接口契约测试。
 *
 * 存在的理由：这个插件的 Host 与 Client 是**手写 bundle**，中间没有任何类型检查兜底。
 * host 改了响应字段、client 忘了跟进（或反过来写了 host 从不返回的字段），
 * 只会在运行时以 `undefined` 的形式出现 —— 而 `undefined` 在 JSX 里往往只是"什么都不显示"，
 * 不报错、不留痕。本测试把这类问题挪到离线阶段，且**用真实调用取真实响应**，不靠读代码猜。
 *
 * 做法：
 *  1. mock 一个最小 ctx（`effect` + `logger` + `webServer.register`），真实加载 Host 插件；
 *  2. 在临时目录造 fixture，然后**真的调用**每一条路由（写操作落在 fixture 里，不碰用户文件）；
 *  3. 收集所有响应的**顶层字段名**，再静态提取 client 里所有 `payload.<字段>` 的**读取字段名**；
 *  4. 双向差分：client 读了但没有任何响应提供的字段 ⇒ 必然是 bug。
 *
 * 运行： node tests/contract.test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, __test } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
/** 直接用 host 侧的真实常量，避免测试里硬编码一份会漂移的副本。 */
const GUARD_HEADER = __test.GUARD_HEADER

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

function note(name, value) {
  console.log(`  ·  ${name} ${value}`)
}

/* ────────────────────────────── mock 一个最小 ctx ───────────────────────────── */

const routes = new Map()
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return () => {
      try {
        dispose?.()
      } catch {
        /* 忽略 */
      }
    }
  },
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}
apply(ctx)

console.log('\n【1】路由注册面')
{
  check('注册了 4 条路由', [...routes.keys()].sort(), [
    '/api/dsh-agent/activation',
    '/api/dsh-agent/file',
    '/api/dsh-agent/layers',
    '/api/dsh-agent/state',
  ])
}

/* ────────────────────────────── fixture 与请求工具 ───────────────────────────── */

function makeReq(url, { method = 'GET', body = null, headers = {} } = {}) {
  const listeners = { data: [], end: [], error: [] }
  const req = {
    url,
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: Object.assign({ [GUARD_HEADER]: '1' }, body === null ? {} : { 'content-type': 'application/json' }, headers),
    on(event, cb) {
      ;(listeners[event] || (listeners[event] = [])).push(cb)
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== null) {
      const chunk = Buffer.from(JSON.stringify(body), 'utf8')
      for (const cb of listeners.data) cb(chunk)
    }
    for (const cb of listeners.end) cb()
  })
  return req
}

function makeRes() {
  const res = { status: 0, headers: null, body: null }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (payload) => {
    res.body = typeof payload === 'string' ? JSON.parse(payload) : null
  }
  return res
}

/** 真实调用一条路由。 */
async function call(path, options) {
  const handler = routes.get(path)
  if (!handler) throw new Error('路由未注册：' + path)
  const res = makeRes()
  await handler(makeReq(path + (options?.query ?? ''), options), res)
  return res
}

const root = mkdtempSync(join(tmpdir(), 'dsh-agent-contract-'))
const HOME = join(root, 'home')
const REPO = join(root, 'repo')
const SUB = join(REPO, 'sub')
mkdirSync(join(REPO, '.git'), { recursive: true })
mkdirSync(SUB, { recursive: true })
mkdirSync(HOME, { recursive: true })
writeFileSync(join(HOME, 'AGENTS.md'), '# global\n')
writeFileSync(join(REPO, 'AGENTS.md'), '# repo\n')
writeFileSync(join(SUB, 'AGENTS.md'), '# sub\n')

// ⚠️⚠️ 必须在**调用任何路由之前**把 DSH_HOME 指到临时目录。
// Host 的「全局层」路径由 `resolveDshHome()` 决定，而 `/activation` 那条路由会**真的改名**那个文件 ——
// 不隔离的话，跑一次测试就会把用户自己的 `~/.dsh/AGENTS.md` 改成 `.disabled`。
// 测试里虽然有恢复语句，但一旦中途断言失败或进程被打断，文件就会留在暂停态。
// 顺带好处：不依赖用户本机的 preset 配置，结果更可复现。
process.env.DSH_HOME = HOME

const q = (value) => '?cwd=' + encodeURIComponent(value)

/* ────────────────────────────── 真实调用四条路由 ───────────────────────────── */

console.log('\n【2】真实调用与响应形状')
const responses = {}
try {
  const state = await call('/api/dsh-agent/state', { query: q(SUB) })
  responses.state = state
  check('GET /state → 200', state.status, 200)

  const stateWithTarget = await call('/api/dsh-agent/state', {
    query: q(SUB) + '&target=' + encodeURIComponent(join(REPO, 'AGENTS.md')),
  })
  responses['state(target)'] = stateWithTarget
  check('GET /state + target → 200', stateWithTarget.status, 200)
  check('  editingTarget 就是请求的那一层', stateWithTarget.body.editingTarget, join(REPO, 'AGENTS.md'))

  const stateBadTarget = await call('/api/dsh-agent/state', {
    query: q(SUB) + '&target=' + encodeURIComponent(join(root, 'outside.md')),
  })
  responses['state(链外 target)'] = stateBadTarget
  check('GET /state + 链外 target → 403（白名单生效）', stateBadTarget.status, 403)

  // 归一化：界面可能把**改名前的形态**记在 localStorage 里（例如全局被暂停时记住的是 `.disabled`）。
  // 请求那个已经不存在、但同一层有另一种形态的路径时，必须落到实际存在的那一份上 ——
  // 否则一打开面板就是「还没有这个文件 · 保存后创建」，而那一层明明有文件。
  const staleTarget = await call('/api/dsh-agent/state', {
    query: q(SUB) + '&target=' + encodeURIComponent(join(SUB, 'AGENTS.md.disabled')),
  })
  responses['state(陈旧 target)'] = staleTarget
  check('GET /state + 陈旧形态 → 200', staleTarget.status, 200)
  check('  editingTarget 归一化到实际存在的形态', staleTarget.body.editingTarget, join(SUB, 'AGENTS.md'))
  check('  能读到内容（不会误报"还没有这个文件"）', staleTarget.body.file.exists, true)

  // 反向：该层一份都没有时**不得**归一化，否则"新建"入口会被改掉
  const freshTarget = await call('/api/dsh-agent/state', {
    query: q(SUB) + '&target=' + encodeURIComponent(join(REPO, 'CLAUDE.md')),
  })
  responses['state(可创建层)'] = freshTarget
  check('GET /state + 该层一份都没有 → 保持原样（保留新建入口）', freshTarget.body.editingTarget, join(REPO, 'CLAUDE.md'))
  check('  且如实报告不存在', freshTarget.body.file.exists, false)

  const stateScope = await call('/api/dsh-agent/state', { query: q(SUB) + '&scope=global' })
  responses['state(scope=global)'] = stateScope
  check('GET /state + scope=global → 200（兼容入口未退化）', stateScope.status, 200)
  check('  兼容路径下 cwd 仍是工作区目录', stateScope.body.cwd, SUB)

  // 不带 expectedMtime ⇒ 跳过乐观并发校验（老调用方 / 新建文件的路径）
  const save = await call('/api/dsh-agent/file', {
    method: 'PUT',
    body: { cwd: SUB, target: join(SUB, 'AGENTS.md'), content: '# sub edited\n' },
  })
  responses.file = save
  check('PUT /file（无 expectedMtime）→ 200', save.status, 200)
  check('  磁盘内容已写入', readFileSync(join(SUB, 'AGENTS.md'), 'utf8'), '# sub edited\n')

  // 乐观并发：mtime 对不上必须拒绝，且不得写坏文件
  const conflict = await call('/api/dsh-agent/file', {
    method: 'PUT',
    body: {
      cwd: SUB,
      target: join(SUB, 'AGENTS.md'),
      content: '# should not land\n',
      expectedMtime: '1999-01-01T00:00:00.000Z',
    },
  })
  responses['file(冲突)'] = conflict
  check('PUT /file + 过期 mtime → 409', conflict.status, 409)
  check('  冲突时磁盘内容未被改写', readFileSync(join(SUB, 'AGENTS.md'), 'utf8'), '# sub edited\n')
  check('  冲突响应回传磁盘现状', conflict.body.file.path, join(SUB, 'AGENTS.md'))

  // 超单文件上限必须在写入前拦下（否则会出现"保存成功但官方永远忽略"的假成功）
  const tooBig = await call('/api/dsh-agent/file', {
    method: 'PUT',
    body: { cwd: SUB, target: join(SUB, 'AGENTS.md'), content: 'x'.repeat(1048577) },
  })
  responses['file(超限)'] = tooBig
  check('PUT /file + 超 1 MB → 413（写入前拦截）', tooBig.status, 413)
  check('  超限时磁盘内容未变', readFileSync(join(SUB, 'AGENTS.md'), 'utf8'), '# sub edited\n')

  const layers = await call('/api/dsh-agent/layers', { method: 'PUT', body: { cwd: SUB, mode: 'global' } })
  responses.layers = layers
  check('PUT /layers {mode:global} → 200', layers.status, 200)
  check('  项目层已改名（只剩全局）', layers.body.mode, 'global')
  check('  AGENTS.md 已变成 .disabled', existsSync(join(REPO, 'AGENTS.md.disabled')), true)

  const layersBack = await call('/api/dsh-agent/layers', { method: 'PUT', body: { cwd: SUB, mode: 'both' } })
  responses['layers(恢复)'] = layersBack
  check('PUT /layers {mode:both} → 恢复', layersBack.body.mode, 'both')

  const activation = await call('/api/dsh-agent/activation', { method: 'PUT', body: { cwd: SUB, globalEnabled: false } })
  responses.activation = activation
  check('PUT /activation → 200', activation.status, 200)
  check('  全局已暂停', activation.body.activation.globalEnabled, false)

  await call('/api/dsh-agent/activation', { method: 'PUT', body: { cwd: SUB, globalEnabled: true } })

  console.log('\n【3】安全栅栏（每条路由都必须过）')
  for (const [path, method] of [
    ['/api/dsh-agent/state', 'GET'],
    ['/api/dsh-agent/file', 'PUT'],
    ['/api/dsh-agent/layers', 'PUT'],
    ['/api/dsh-agent/activation', 'PUT'],
  ]) {
    const noHeader = await call(path, { method, body: method === 'GET' ? null : {} })
    // 上面这次是带 header 的；重新造一个缺 header 的请求
    const handler = routes.get(path)
    const res = makeRes()
    await handler(makeReq(path, { method, headers: { [GUARD_HEADER]: '' } }), res)
    check(`  ${path} 缺护栏头 → 403`, res.status, 403)
    void noHeader
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

/* ────────────────────────────── 字段双向差分 ───────────────────────────── */

console.log('\n【4】前后端字段双向差分（按响应对象分组）')

/** 提取源码里所有 `<prefix>.<字段>` 形式的读取。 */
function readFields(src, prefix) {
  const found = new Set()
  const re = new RegExp('\\b' + prefix + '\\.([A-Za-z_$][\\w$]*)', 'g')
  for (const match of src.matchAll(re)) found.add(match[1])
  return found
}
const union = (...sets) => new Set(sets.flatMap((set) => [...set]))

// 严格按"谁提供、谁消费"分组：client 的 `payload.X` 对应响应顶层；
// `file` / `budget` / `activation` 是响应里的固定对象；`row` 是 layersView 的元素。
// 轮询分支先把 `payload.file` 存进 `next`，所以 `next.X` 归到 file 组。
const base = responses.state.body
const GROUPS = [
  { label: '顶层', provided: Object.keys(base), read: readFields(CLIENT_SRC, 'payload') },
  { label: 'file', provided: Object.keys(base.file), read: union(readFields(CLIENT_SRC, 'file'), readFields(CLIENT_SRC, 'next')) },
  { label: 'budget', provided: Object.keys(base.budget), read: readFields(CLIENT_SRC, 'budget') },
  { label: 'layersView[i]', provided: Object.keys(base.layersView[0]), read: readFields(CLIENT_SRC, 'row') },
]
// 注：`activation` 对象**不在这里核对** —— 新界面已不再消费它（layersView 是它的超集，
// client 侧那条消费链是死代码、已删）。它现在只作为 `/activation` 兼容路由的公开契约存在，
// 由下面【5】单独断言。

/**
 * 已知例外 —— 每条都必须写清理由，否则就会变成"把真问题当噪声忽略"的后门。
 */
const KNOWN_READ_EXCEPTIONS = {
  顶层: [
    // `payload.error` 只在 4xx/5xx 里出现；200 响应本来就没有这个字段。
    'error',
  ],
  'layersView[i]': [
    // client 里另有一处 `ctx.slots.entries()` 的 row 也叫 `row`，它的 `options` 属于 slot 账本，
    // 与 layersView 的行不是同一个东西（同名不同物）。
    'options',
  ],
}

const redundant = []
for (const group of GROUPS) {
  const exceptions = KNOWN_READ_EXCEPTIONS[group.label] || []
  const read = new Set([...group.read].filter((name) => !exceptions.includes(name)))
  const missing = [...read].filter((name) => !group.provided.includes(name))
  const unread = group.provided.filter((name) => !read.has(name)).sort()
  check(`  ${group.label}：client 读的字段都由 host 提供（不会读到 undefined）`, missing, [])
  note(`  ${group.label} 提供但无人读：`, unread.length ? unread.join(', ') : '（无）')
  for (const name of unread) redundant.push(`${group.label}.${name}`)
}
note('冗余字段合计：', redundant.length ? redundant.join(', ') : '（无）')

console.log('\n【5】关键契约要点（即使字段名对得上，语义也必须对）')
{
  const state = responses.state.body
  check('state.layersView 是数组且含 base/path/enabled/exists/included', Array.isArray(state.layersView) && state.layersView.every(
    (row) => typeof row.base === 'string' && typeof row.path === 'string'
      && typeof row.enabled === 'boolean' && typeof row.exists === 'boolean' && typeof row.included === 'boolean',
  ), true)
  check('state.layersView 覆盖 4 行（全局 + 两层项目 + 工作区那层的个性化入口）', state.layersView.length, 4)
  check('state.mode 是四种取值之一', ['both', 'project', 'global', 'custom'].includes(state.mode), true)
  check('state.budget.layers 与 layersView 的行数一致（同一份发现的两种投影）',
    state.budget.layers.length, state.layersView.filter((row) => row.exists).length)
  check('state.file 带 enabled 标记（界面据此提示"已暂停"）', typeof state.file.enabled, 'boolean')

  const saved = responses.file.body
  check('file 响应带 layersView（保存后列表能立刻刷新）', Array.isArray(saved.layersView), true)
  check('file 响应带 mode', typeof saved.mode, 'string')

  const layers = responses.layers.body
  check('layers 响应带 applied（逐个改名的结果）', Array.isArray(layers.applied), true)

  // 兼容入口：界面不再调它，但它的响应契约必须完整（公开 API 不能悄悄退化）
  const compat = responses.activation.body.activation
  check('/activation 兼容入口仍返回完整的全局层契约',
    ['globalEnabled', 'activePath', 'pausedPath', 'editingPath'].every((key) => key in compat), true)
  check('  globalEnabled 反映真实暂停状态', compat.globalEnabled, false)

  // 保存响应必须带 enabled —— 否则保存一个 .disabled 文件后界面不会提示"这是已暂停的文件"
  check('/file 响应的 file.enabled 是布尔（与 /state 一致）', typeof saved.file.enabled, 'boolean')
}

console.log('\n【6】界面语言跟随 dsh：请求头 x-dsh-lang 决定 Host 文案')
// 存在理由：Host 的面向用户文案是当**数据**发给客户端原样渲染的，不经过翻译层。
// 曾经 `planeNote` 与全部错误文案都写死中文 ⇒ dsh 切成英文时界面里仍冒中文。
// 这里实测三个方向：zh / en / 无头回落，以及 accept-language 的近似兜底。
{
  const hasCjk = (value) => /[\u4e00-\u9fff]/.test(String(value ?? ''))
  const langState = (headers) => call('/api/dsh-agent/state', { query: q(REPO), headers })

  const zh = await langState({ 'x-dsh-lang': 'zh' })
  const en = await langState({ 'x-dsh-lang': 'en' })
  const none = await langState()
  const acceptEn = await langState({ 'accept-language': 'en-US,en;q=0.9' })
  const acceptZh = await langState({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' })

  const pZh = zh.body.budget.planeNote
  const pEn = en.body.budget.planeNote
  check('planeNote 有值（否则这一组测不到东西）', typeof pZh === 'string' && pZh.length > 0, true)
  check('x-dsh-lang: zh → planeNote 是中文', hasCjk(pZh), true)
  check('x-dsh-lang: en → planeNote 无中日韩字符', hasCjk(pEn), false)
  check('  且两份文案确实不同（说明真的切了，不是同一份）', pZh !== pEn, true)
  check('不带语言头 → 回落中文（保持既有默认行为，老调用方不退化）', hasCjk(none.body.budget.planeNote), true)
  check('只有 accept-language: en（无自有头）→ 走英文', hasCjk(acceptEn.body.budget.planeNote), false)
  check('只有 accept-language: zh → 走中文', hasCjk(acceptZh.body.budget.planeNote), true)

  // 错误文案同样是直接显示给用户的，必须一起跟随
  const badBody = { cwd: REPO, scope: 'workspace' }
  const badZh = await call('/api/dsh-agent/file', { method: 'PUT', body: badBody, headers: { 'x-dsh-lang': 'zh' } })
  const badEn = await call('/api/dsh-agent/file', { method: 'PUT', body: badBody, headers: { 'x-dsh-lang': 'en' } })
  check('缺 content 的写请求被拒（400）', badZh.status, 400)
  check('x-dsh-lang: zh → 错误文案是中文', badZh.body.error, '缺少 content 字段')
  check('x-dsh-lang: en → 错误文案是英文', badEn.body.error, 'Missing content field')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
