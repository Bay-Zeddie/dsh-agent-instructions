/**
 * Host 侧**真实 HTTP** 端到端测试。
 *
 * 与 `contract.test.mjs` 的分工：
 *   - contract 用 mock 的 req/res 逐个字段核对「谁提供、谁消费」，快而全；
 *   - 本测试起一个**真的 node:http 服务器**，把 4 条路由挂上去，用 global fetch 走
 *     真实 TCP：socket/headers/查询串/请求体流/状态码全都是真的。
 *
 * 为什么值得另跑一遍：这个插件最危险的两类错误只在真实链路上出现 ——
 *  ① 栅栏（回环 + 同源 + 自定义头）判的是 **socket.remoteAddress / 原始 headers**，
 *     mock 很容易把这两样"造"成永远合法；
 *  ② 请求体上限（413）与 `content-type` 检查（415）发生在**读流**的过程中，
 *     mock 的 `on('data')` 触发顺序与真实 socket 不同。
 *
 * 运行： node tests/http-e2e.test.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = new URL('.', import.meta.url)
const HOST_MODULE = new URL('../lib/index.js', HERE)

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

/* ───────────────────────────── fixture ───────────────────────────── */

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-agent-http-'))
const HOME = join(ROOT, 'home')
const WS = join(ROOT, 'ws')
const WS_SUB = join(WS, 'sub')
mkdirSync(join(HOME, 'profiles', 'desktop'), { recursive: true })
mkdirSync(join(WS, '.git'), { recursive: true })
mkdirSync(WS_SUB, { recursive: true })

// 双链场景：全局 40KB + 工作区 20KB ⇒ 内容合计超 65,536，但两条链各自在预算内（官方全部注入）
const big = (n, tag) => `# ${tag}\n` + ('- rule line with some words ' + 'z'.repeat(40) + '\n').repeat(Math.floor(n / 68))
writeFileSync(join(HOME, 'AGENTS.md'), big(40000, 'global fixture'), 'utf8')
writeFileSync(join(WS, 'AGENTS.md'), big(20000, 'workspace fixture'), 'utf8')
writeFileSync(join(WS, 'AGENTS.local.md'), '## personal\n- keep me\n', 'utf8')
writeFileSync(join(WS_SUB, 'AGENTS.md'), '# sub fixture\n- nested\n', 'utf8')
writeFileSync(join(WS_SUB, 'AGENTS.local.md'), 'x'.repeat(1048577), 'utf8') // 超单文件上限

process.env.DSH_HOME = HOME
delete process.env.DSH_AGENTS_HOME

/* ───────────────────────────── 真实 host + 真实 server ───────────────────────────── */

const routes = new Map()
const host = await import(HOST_MODULE.href)
host.apply({
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  effect(fn) {
    return fn()
  },
  logger: { info() {} },
})

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (!handler) {
    res.writeHead(404).end('no route')
    return
  }
  req.url = url.pathname + url.search
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(JSON.stringify({ error: String(error && error.message) }))
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const ORIGIN = `http://127.0.0.1:${String(server.address().port)}`

const GUARD = { 'x-dsh-agent': '1' }
const stateUrl = (query) => `${ORIGIN}/api/dsh-agent/state${query ? `?${query}` : ''}`
const q = (params) => new URLSearchParams(params).toString()

async function call(path, init) {
  const response = await fetch(ORIGIN + path, init)
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body, headers: response.headers }
}

console.log('\n【1】注册面 + 栅栏（真实 TCP）')
check('4 条路由都已挂上', [...routes.keys()].sort(), [
  '/api/dsh-agent/activation',
  '/api/dsh-agent/file',
  '/api/dsh-agent/layers',
  '/api/dsh-agent/state',
])
{
  const noGuard = await call('/api/dsh-agent/state')
  check('缺插件专属头 ⇒ 403', noGuard.status, 403)
  const crossSite = await call('/api/dsh-agent/state', { headers: { ...GUARD, 'sec-fetch-site': 'cross-site' } })
  check('跨站（sec-fetch-site）⇒ 403', crossSite.status, 403)
  const nullOrigin = await call('/api/dsh-agent/state', { headers: { ...GUARD, origin: 'null' } })
  check('Origin: null ⇒ 403', nullOrigin.status, 403)
  const evilOrigin = await call('/api/dsh-agent/state', { headers: { ...GUARD, origin: 'https://evil.example' } })
  check('外部 Origin ⇒ 403', evilOrigin.status, 403)
  const localOrigin = await call('/api/dsh-agent/state', { headers: { ...GUARD, origin: ORIGIN } })
  check('本机 Origin ⇒ 200', localOrigin.status, 200)
}

console.log('\n【2】/state：双链预算（真实文件、真实渲染）')
{
  const { status, body } = await call(`/api/dsh-agent/state?${q({ cwd: WS })}`, { headers: GUARD })
  check('200', status, 200)
  check('编辑目标默认 = 工作区 AGENTS.md', body.editingTarget, join(WS, 'AGENTS.md'))
  check('层清单：全局 + 工作区 + 个性化', body.layersView.map((row) => row.displayPath), [
    '$DSH_HOME/AGENTS.md',
    'AGENTS.md',
    'AGENTS.local.md',
  ])
  check('内容合计（两链相加）', body.budget.totalBytes, statSync(join(HOME, 'AGENTS.md')).size + statSync(join(WS, 'AGENTS.md')).size + statSync(join(WS, 'AGENTS.local.md')).size)
  check('over 为假：两条链各自都在 65,536 预算内（官方全部注入）', body.budget.over, false)
  check('omitted 为空', body.budget.omitted, [])
  check('truncated 为空', body.budget.truncated, [])
  check('renderedBytes 是真实注入文本字节（> 内容合计，含边框/intro/段头）', body.budget.renderedBytes > body.budget.totalBytes, true)
  check('两条链各自的渲染字节', [body.budget.chains.global.renderedBytes > 40000, body.budget.chains.project.renderedBytes > 20000], [true, true])
  check('上限来源 = 官方默认', body.budget.limitSource, 'official-default')
  check('上限 = 65,536', body.budget.limit, 65536)
  check('模式 = both', body.mode, 'both')
}
{
  const { body } = await call(`/api/dsh-agent/state?${q({ cwd: WS_SUB })}`, { headers: GUARD })
  // Windows 上 displayPath 用反斜杠（relative() 的原样输出），比较前归一
  const norm = (value) => String(value).replaceAll('\\', '/')
  const huge = body.layersView.find((row) => norm(row.displayPath) === 'sub/AGENTS.local.md')
  check('超过 1 MB 的层：存在、但不 included', [huge.exists, huge.included], [true, false])
  check('诊断：notRendered 列出它', body.budget.notRendered.map((item) => norm(item.displayPath)), ['sub/AGENTS.local.md'])
}
{
  const outOfChain = await call(`/api/dsh-agent/state?${q({ cwd: WS, target: join(ROOT, 'outside', 'AGENTS.md') })}`, { headers: GUARD })
  check('链外 target ⇒ 403', outOfChain.status, 403)
}

console.log('\n【3】/file：写入 / 乐观并发 / 上限 / content-type')
{
  const target = join(WS, 'AGENTS.local.md')
  const before = statSync(target).mtime.toISOString()
  const ok = await call('/api/dsh-agent/file', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, target, content: '## personal\n- written over real HTTP\n' }),
  })
  check('PUT 200', ok.status, 200)
  check('磁盘内容已更新', readFileSync(target, 'utf8'), '## personal\n- written over real HTTP\n')
  check('响应带回新的 mtime', ok.body.file.mtime !== before, true)

  const stale = await call('/api/dsh-agent/file', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, target, content: 'stale write', expectedMtime: '1999-01-01T00:00:00.000Z' }),
  })
  check('mtime 不符 ⇒ 409', stale.status, 409)
  check('409 回传磁盘现状（界面据此提示）', stale.body.file.content, '## personal\n- written over real HTTP\n')
  check('冲突后磁盘未被覆盖', readFileSync(target, 'utf8'), '## personal\n- written over real HTTP\n')

  const wrongCt = await call('/api/dsh-agent/file', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'text/plain' },
    body: JSON.stringify({ cwd: WS, target, content: 'x' }),
  })
  check('非 JSON content-type ⇒ 415（阻断 no-cors 跨站写）', wrongCt.status, 415)

  const tooBig = await call('/api/dsh-agent/file', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, target, content: 'x'.repeat(1048577) }),
  })
  check('内容超过官方单文件上限 ⇒ 413', tooBig.status, 413)

  // Host 在读流超限时先 reject 再 req.destroy()：客户端可能收到 413，也可能直接看到连接被断。
  // 两种都是「拒绝」，断言落在「拒绝 + 磁盘未被写」上（不断言具体是哪一种）。
  let bodyTooBigStatus = null
  try {
    bodyTooBigStatus = (await call('/api/dsh-agent/file', {
      method: 'PUT',
      headers: { ...GUARD, 'content-type': 'application/json' },
      body: 'x'.repeat(1120000),
    })).status
  } catch {
    bodyTooBigStatus = 'socket-closed'
  }
  check('请求体超过路由上限 ⇒ 413 或连接被断开', bodyTooBigStatus === 413 || bodyTooBigStatus === 'socket-closed', true)
  check('超限请求未改动磁盘', readFileSync(join(WS, 'AGENTS.local.md'), 'utf8'), '## personal\n- written over real HTTP\n')

  const getFile = await call('/api/dsh-agent/file', { headers: GUARD })
  check('GET 不接受到写路由 ⇒ 405', getFile.status, 405)
}

console.log('\n【4】/layers：单层开关 + 三选一模式（真实改名）')
{
  const localBase = join(WS, 'AGENTS.local.md')
  const paused = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, changes: [{ base: localBase, enabled: false }] }),
  })
  check('暂停单层 200', paused.status, 200)
  check('磁盘上改名为 .disabled', statSync(localBase + '.disabled').size > 0, true)
  check('内容一个字节不丢', readFileSync(localBase + '.disabled', 'utf8'), '## personal\n- written over real HTTP\n')
  check('响应 applied 记录 changed=true', paused.body.applied.map((item) => item.changed), [true])

  // 恢复（后续用例需要它处于启用态）
  const restoreLocal = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, changes: [{ base: localBase, enabled: true }] }),
  })
  check('恢复单层 200', [restoreLocal.status, statSync(localBase).isFile()], [200, true])

  // ⚠️ 混合批次（第 1 项合法、第 2 项链外）：必须 403，且**一个字节都不许动**。
  // 曾经是「边校验边执行」，第 1 项会先被改名、响应再报 403 —— 磁盘被改了一半。
  const mixed = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({
      cwd: WS,
      changes: [
        { base: localBase, enabled: false },
        { base: join(ROOT, 'outside', 'AGENTS.md'), enabled: false },
      ],
    }),
  })
  check('混合批次（合法 + 链外）⇒ 403', mixed.status, 403)
  check('被拒批次没有产生任何改名（两段式校验）', statSync(localBase).isFile(), true)

  const outOfChain = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, changes: [{ base: join(ROOT, 'outside', 'AGENTS.md'), enabled: false }] }),
  })
  check('链外 base ⇒ 403', outOfChain.status, 403)

  const badMode = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, mode: 'nonsense' }),
  })
  check('非法 mode ⇒ 400', badMode.status, 400)

  const onlyGlobal = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, mode: 'global' }),
  })
  check('切「仅全局」200', onlyGlobal.status, 200)
  check('工作区 AGENTS.md 被暂停', statSync(join(WS, 'AGENTS.md.disabled')).size > 0, true)
  check('模式反推 = global', onlyGlobal.body.mode, 'global')

  const both = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, mode: 'both' }),
  })
  check('切回「工作区 + 全局」', [both.status, both.body.mode], [200, 'both'])
  check('工作区 AGENTS.md 恢复官方名', statSync(join(WS, 'AGENTS.md')).size > 0, true)
}

console.log('\n【5】/activation：全局层开关（兼容入口）')
{
  const off = await call('/api/dsh-agent/activation', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, globalEnabled: false }),
  })
  check('暂停全局 200', off.status, 200)
  check('全局文件改名为 .disabled', statSync(join(HOME, 'AGENTS.md.disabled')).size > 0, true)
  check('激活状态如实回报', off.body.activation.globalEnabled, false)

  const on = await call('/api/dsh-agent/activation', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, globalEnabled: true }),
  })
  check('恢复全局 200', [on.status, on.body.activation.globalEnabled], [200, true])
  check('全局文件回到官方名', statSync(join(HOME, 'AGENTS.md')).size > 0, true)

  const missing = await call('/api/dsh-agent/activation', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS }),
  })
  check('缺 globalEnabled ⇒ 400', missing.status, 400)
}

console.log('\n【6】语言头：Host 面向用户文案跟随')
{
  const zh = await call(`/api/dsh-agent/state?${q({ cwd: WS })}`, { headers: { ...GUARD, 'x-dsh-lang': 'zh' } })
  const en = await call(`/api/dsh-agent/state?${q({ cwd: WS })}`, { headers: { ...GUARD, 'x-dsh-lang': 'en' } })
  const cjk = /[\u4e00-\u9fff]/
  check('zh：planeNote 含中文', cjk.test(zh.body.budget.planeNote), true)
  check('en：planeNote 无中文', cjk.test(en.body.budget.planeNote), false)
  check('两份文案确实不同', zh.body.budget.planeNote !== en.body.budget.planeNote, true)
}

console.log('\n【7】全部暂停：官方「什么都不注入」⇒ renderedBytes 0')
{
  // 官方渲染器对空数组会给出一段「只有 intro + 边框」的 272B 文本 —— 那只是数学结果；
  // 运行路径 loadBaselineInstructionSet() 在零收录时直接 return undefined（不注入）。
  // 面板若照搬渲染器，就会把「没有任何文件生效」显示成「注入了 272 字节」。
  const paused = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({
      cwd: WS,
      changes: [
        { base: join(HOME, 'AGENTS.md'), enabled: false },
        { base: join(WS, 'AGENTS.md'), enabled: false },
        { base: join(WS, 'AGENTS.local.md'), enabled: false },
      ],
    }),
  })
  check('暂停三层 200', paused.status, 200)
  const zero = await call(`/api/dsh-agent/state?${q({ cwd: WS })}`, { headers: GUARD })
  check('零收录 ⇒ renderedBytes 0（不是 272B 空壳）', zero.body.budget.renderedBytes, 0)
  check('零收录 ⇒ over 为假、无省略/截断', [zero.body.budget.over, zero.body.budget.omitted.length, zero.body.budget.truncated.length], [false, 0, 0])
  check('零收录 ⇒ 两条链各自 renderedBytes 0', [zero.body.budget.chains.global.renderedBytes, zero.body.budget.chains.project.renderedBytes], [0, 0])
  const back = await call('/api/dsh-agent/layers', {
    method: 'PUT',
    headers: { ...GUARD, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: WS, mode: 'both' }),
  })
  check('恢复 200 且模式回到 both', [back.status, back.body.mode], [200, 'both'])
  const again = await call(`/api/dsh-agent/state?${q({ cwd: WS })}`, { headers: GUARD })
  check('恢复后 renderedBytes 回到内容量级', again.body.budget.renderedBytes > again.body.budget.totalBytes, true)
}

server.close()
rmSync(ROOT, { recursive: true, force: true })

console.log(`\n结果：${String(pass)} 通过 / ${String(fail)} 失败`)
if (fail > 0) process.exitCode = 1