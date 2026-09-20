/**
 * 界面语言解析：来源优先级必须**官方 locale 服务优先**，`<html lang>` 只作兜底。
 *
 * 存在理由（实测踩过的真 bug）：dsh 服务端出的 HTML **写死** `<html lang="en">`
 * （`apps/web/index.html`），要等 locale 插件激活后才异步改写成 `zh-CN`。
 * 只认这个属性时，读在写入之前就拿到 `en`，界面**永久停在英文** —— 而 dsh 自己明明是中文。
 * 修法不是"多读一次"，而是**换权威源**：`ctx.get('locale').getSnapshot().active`。
 *
 * 这个测试从 `lib/client.js` **原文抽出** `normalizeLang` / `currentLang` 求值，
 * 不是抄一份逻辑 —— 所以它盯的是真源码，改错了会红。
 *
 * 运行： node tests/lang-resolution.test.mjs
 * 退出码：0 = 全通过；1 = 有失败
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass += 1
  else fail += 1
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`}`)
}

/** 从 openIndex 处的 `{` 开始做括号配对，返回其闭合 `}` 的下标。 */
function matchBrace(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

console.log('\n【1】从 client.js 原文抽出语言解析逻辑')

const blockStart = src.indexOf('let localeService = null')
const fnStart = src.indexOf('function currentLang() {')
if (blockStart < 0 || fnStart < 0) {
  console.log('  ❌ 找不到 `let localeService = null` 或 `function currentLang()` —— 结构变了，本测试需要同步更新')
  process.exit(1)
}
const fnOpen = src.indexOf('{', fnStart)
const fnClose = matchBrace(src, fnOpen)
const block = src.slice(blockStart, fnClose + 1)

check('抽出的块里含 localeService 声明', block.includes('let localeService = null'), true)
check('抽出的块里含 normalizeLang', block.includes('function normalizeLang'), true)
check('抽出的块里含 currentLang', block.includes('function currentLang'), true)
console.log(`  抽出 ${block.split('\n').length} 行（client.js 第 ${src.slice(0, blockStart).split('\n').length} 行起）`)

// eslint-disable-next-line no-new-func
const build = new Function('document', 'navigator', `${block}
return { currentLang, normalizeLang, set: (v) => { localeService = v } }`)

const env = (docLang, navLang) => build(
  { documentElement: { lang: docLang } },
  { language: navLang },
)
const activeService = (active) => ({ getSnapshot: () => ({ active }) })

console.log('\n【2】优先级：官方 locale 服务 > <html lang> > navigator.language')
{
  // ★ 核心回归用例：dsh 是中文，但 HTML 属性还停在服务端写死的 en。
  //   修的正是这一格 —— 旧实现会返回 'en'。
  let f = env('en', 'en-US')
  f.set(activeService('zh'))
  check('服务说 zh + HTML 属性是 en → 取 zh（这就是原 bug 那格）', f.currentLang(), 'zh')

  f = env('zh-CN', 'zh-CN')
  f.set(activeService('en'))
  check('服务说 en + HTML 属性是 zh-CN → 取 en（反方向也要跟随）', f.currentLang(), 'en')

  f = env('zh-CN', 'en-US')
  f.set(null)
  check('服务缺席 + HTML 属性 zh-CN → 取 zh', f.currentLang(), 'zh')

  f = env('', 'en-US')
  f.set(null)
  check('服务缺席 + HTML 属性为空 → 回落 navigator.language', f.currentLang(), 'en')

  f = env('', '')
  f.set(null)
  check('全都没有信号 → 默认 zh', f.currentLang(), 'zh')

  f = env('en', 'en-US')
  f.set(activeService(''))
  check('服务在但 active 为空串 → 继续往下回落（不当成 en）', f.currentLang(), 'en')
}

console.log('\n【3】健壮性：坏掉的服务不许把插件带崩')
{
  const f = env('zh-CN', 'zh-CN')
  f.set({ getSnapshot: () => null })
  check('getSnapshot 返回 null → 回落 HTML 属性', f.currentLang(), 'zh')

  const g = env('en', 'en')
  g.set({ getSnapshot() { throw new Error('boom') } })
  check('getSnapshot 抛异常 → 兜底 zh（不抛出去）', g.currentLang(), 'zh')

  const h = env('zh-CN', 'zh-CN')
  h.set({})  // 有对象但没有 getSnapshot
  check('服务没有 getSnapshot → 回落 HTML 属性', h.currentLang(), 'zh')

  const n = env('zh-CN', 'zh-CN')
  n.set(activeService('zh-Hant'))
  check('非 en 的其它语言一律归到 zh（插件只出中英两版）', n.currentLang(), 'zh')

  const m = env('en', 'en')
  m.set(activeService('en-GB'))
  check('en-* 归到 en', m.currentLang(), 'en')
}

console.log('\n【4】原文里的接线不变量（静态核验，防悄悄改回去）')
{
  check('normalizeLang 是函数声明（会被提升，currentLang 可安全调用）',
    /function normalizeLang\s*\(/.test(block), true)
  check('currentLang 每次现读（体内出现 getSnapshot 调用）',
    /currentLang[\s\S]*getSnapshot/.test(block), true)
  check('apiFetch 把当前语言放进请求头，Host 才能挑文案',
    src.includes('[LANG_HEADER]: currentLang()'), true)
  check('新增了 x-dsh-lang 头常量', src.includes("const LANG_HEADER = 'x-dsh-lang'"), true)

  // 顺序不变量：语言来源必须在**首次取文案之前**就位（mountFab / mountSettingsEntry 都会取文案）。
  // ⚠️ 顺序必须在 **apply 函数体内**比对。全文搜会先命中函数**定义**处，
  //    而 `registerLocale` / `mountSettingsEntry` 的定义顺序与调用顺序毫无关系。
  const applyStart = src.indexOf('function apply(ctx) {')
  const applyBody = applyStart >= 0
    ? src.slice(applyStart, matchBrace(src, src.indexOf('{', applyStart)) + 1)
    : ''
  check('定位到 apply 函数体', applyBody.length > 0, true)
  const iRegister = applyBody.indexOf('registerLocale(ctx)')
  const iBoot = applyBody.indexOf('const boot = () => {')
  const iMount = applyBody.indexOf('mountSettingsEntry(ctx)')
  check('registerLocale 调用存在', iRegister > 0, true)
  check('registerLocale 早于 boot（浮动按钮的首次文案就跟着 dsh）',
    iRegister > 0 && iBoot > 0 && iRegister < iBoot, true)
  check('registerLocale 早于 mountSettingsEntry（设置页导航项同理）',
    iRegister > 0 && iMount > 0 && iRegister < iMount, true)

  check('两个语言来源都订阅：watchLang（HTML 属性）',
    /stopWatch = watchLang\(/.test(src), true)
  check('两个语言来源都订阅：localeService.subscribe（权威源）',
    /localeService\.subscribe\(/.test(src), true)
  check('卸载时退订 locale（不留悬挂监听）',
    src.includes('stopLocale()'), true)
  check('只有一个判定漏斗：onLangSourceChanged',
    (src.match(/function onLangSourceChanged\s*\(/g) || []).length, 1)
  check('watchLang 不再自己判语言（避免两处判定打架）',
    /new MutationObserver\(\(\) => onChange\(\)\)/.test(src), true)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
