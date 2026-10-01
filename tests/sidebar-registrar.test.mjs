/**
 * 侧边栏一级入口的注册契约（真实执行 client factory 的冒烟测试）。
 *
 * 存在理由：`lib/client.js` 是手写 bundle，注册逻辑没有任何类型/打包器兜底 ——
 * id/key 不一致、order 写错、成对注册缺一边，任何一处错了入口就消失或排错位置，
 * 而且只有真机才能看出来。这个测试在 Node 里 stub 掉浏览器环境后**真实执行**
 * factory 与 apply()，把注册行为钉死在契约上：
 *   ① `sidebar.panellist` 行与 `main` 面板成对注册；
 *   ② 行 id 与面板 key 同值（layout 靠它把两者接起来）；
 *   ③ order 落在官方 plugins(0)/schedules(10) 与 dsh-skill-mcp-manager 的
 *      Skill(20)/MCP(21) 之后 ⇒ 界面上排在 MCP 的下面；
 *   ④ label 是 thunk 且能产出非空文案（跟随语言的官方约定）；
 *   ⑤ 导航行图标组件与页面组件都是可渲染函数；
 *   ⑥ 卸载清理可调用、可重入（cordis ctx.effect 生命周期）。
 *
 * 运行： node tests/sidebar-registrar.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `（实际：${JSON.stringify(actual)}，期望：${JSON.stringify(expected)}）`}`)
  if (ok) passed += 1
  else process.exitCode = 1
}

/* ------------------------------------------------ 浏览器环境桩（window/document/navigator） */

const injectCalls = []
const registrations = []
const disposers = []
let loadedDefinition = null

const documentStub = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  documentElement: { lang: 'zh-CN' },
  querySelector: () => null,
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  TextEncoder,
  navigator: { language: 'zh-CN' },
  document: documentStub,
  window: {
    __ModuleLoader__: {
      load(definition) {
        loadedDefinition = definition
      },
    },
  },
}

vmRun(src, sandbox)
assert.ok(loadedDefinition, 'client.js 必须在加载时调用 window.__ModuleLoader__.load')
check('模块 id 与插件名一致（模块表的键）', loadedDefinition.id, 'dsh-agent-instructions')

function vmRun(code, sandboxArg) {
  runInNewContext(code, sandboxArg)
}

/* ------------------------------------------------ 执行 factory + apply */

const reactStub = { createElement() {} }
const requireStub = (name) => {
  if (name === 'react') return reactStub
  throw new Error(`module not found: ${name}`)
}
const moduleExports = loadedDefinition.factory(requireStub)
check('exports.inject 声明了 slots（用 ctx.slots 的硬前提）', moduleExports.inject.includes('slots'), true)
check('导出了 apply', typeof moduleExports.apply, 'function')

const ctx = {
  slots: {
    inject(slot, factory) {
      injectCalls.push(slot)
      const disposer = factory()
      disposers.push(disposer)
      return disposer
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
    entries() {
      return []
    },
  },
  get: () => undefined,
  effect(fn) {
    /* 记录清理函数但不执行（cordis 语义：卸载时才跑） */
    disposers.push(fn)
    return () => {}
  },
}

moduleExports.apply(ctx)

const mainEntry = registrations.find((r) => r.options.name === 'main' && r.options.key !== undefined)
const rowEntry = registrations.find((r) => r.options.name === 'sidebar.panellist')
const panelId = 'dsh-agent-instructions'

console.log('\n【0】设置页入口已按主人裁决移除（不许复活）')
check('没有 settings.section 注册', registrations.some((r) => r.options.name === 'settings.section'), false)
check('没有 settings.general.item 回退注册', registrations.some((r) => r.options.name === 'settings.general.item'), false)
check('slots.inject 只发生在 main 与 sidebar.panellist 两处',
  injectCalls.slice().sort().join(','), 'main,sidebar.panellist')

console.log('\n【1】成对注册')
check('main 槽位注册存在', Boolean(mainEntry), true)
check('sidebar.panellist 行注册存在', Boolean(rowEntry), true)
check('行 id 与面板 key 同值（layout 接线的硬前提）', rowEntry && rowEntry.options.id, mainEntry && mainEntry.options.key)
check('面板 id 用模块名（全局唯一）', mainEntry && mainEntry.options.key, panelId)

console.log('\n【2】排序：官方 plugins=0 / schedules=10，dsh-skill-mcp-manager Skill=20 / MCP=21')
check('order 是数字', typeof rowEntry.options.order, 'number')
check('order > 21（排在 MCP 的下面）', rowEntry.options.order > 21, true)

console.log('\n【3】label 与组件')
check('label 是 thunk（官方约定：每次投影现读，跟随语言）', typeof rowEntry.options.label, 'function')
check('label() 产出非空文案', typeof rowEntry.options.label() === 'string' && rowEntry.options.label().length > 0, true)
check('导航行图标是可渲染组件', typeof rowEntry.component, 'function')
check('图标组件接受官方 ownerProps { size, active } 而不抛', safeCall(() => rowEntry.component({ size: 16, active: false })), true)
check('main 页面是可渲染组件', typeof mainEntry.component, 'function')

console.log('\n【4】生命周期')
check('两处注册都走了 slots.inject（随父声明自动执行/重声明自动重跑）', injectCalls.includes('main') && injectCalls.includes('sidebar.panellist'), true)
let disposeThrew = false
try {
  for (const dispose of disposers) {
    if (typeof dispose === 'function') dispose()
  }
} catch {
  disposeThrew = true
}
check('全部 disposer 可安全调用（卸载不炸）', disposeThrew, false)

/* ---------------------------------------------------------------- 工具 */

function safeCall(fn) {
  try {
    fn()
    return true
  } catch {
    return false
  }
}

console.log(`\n结果：${passed} 通过 / ${process.exitCode ? '有失败' : '0 失败'}`)
