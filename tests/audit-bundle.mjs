/**
 * 静态审计：找出「定义了但没用到」的死代码与遗漏的文案键。
 *
 * 存在理由：本插件的客户端是**手写 bundle**（没有打包器的 tree-shaking / 类型检查兜底），
 * 冗余与死代码只能靠显式检查。这个脚本把「未使用的文案键」「无人引用的顶层定义」
 * 全部列出来，让清理有据可依 —— 而不是凭感觉删。
 *
 * 运行： node tests/audit-bundle.mjs
 * 退出码：0 = 干净；1 = 发现需要处理的问题
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'lib', 'client.js')
const src = readFileSync(file, 'utf8')
const lines = src.split(/\r?\n/)

const problems = []

/** 括号扫描，取出 MESSAGES 里某个语言字典的键。 */
function dictKeys(anchor) {
  const start = lines.findIndex((line) => line.trim() === anchor)
  if (start < 0) return null
  const keys = []
  let depth = 0
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (i === start) {
      depth = 1
      continue
    }
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    const key = line.match(/^ {8}([A-Za-z][A-Za-z0-9]*):/)
    if (key && depth === 1) keys.push(key[1])
    if (depth === 0) break
  }
  return keys
}

console.log('\n【1】文案键一致性')
const zh = dictKeys('zh: {')
const en = dictKeys('en: {')
if (!zh || !en) {
  problems.push('无法解析 MESSAGES 的 zh/en 字典')
  console.log('  ❌ 解析失败')
} else {
  console.log(`  zh=${zh.length} 键 · en=${en.length} 键`)
  const onlyZh = zh.filter((k) => !en.includes(k))
  const onlyEn = en.filter((k) => !zh.includes(k))
  if (onlyZh.length) problems.push(`只有 zh 的键：${onlyZh.join(', ')}`)
  if (onlyEn.length) problems.push(`只有 en 的键：${onlyEn.join(', ')}`)
  console.log(`  只在 zh：${onlyZh.length ? onlyZh.join(', ') : '无'}｜只在 en：${onlyEn.length ? onlyEn.join(', ') : '无'}`)

  // 两种合法调用形态都要认：
  //   ① 静态键：t('modeBoth')
  //   ② 动态选键：t(cond ? 'placeholderLocal' : 'placeholder', …) —— 三元/变量选键，静态串扫不到
  // 字典里的键名写法是**不带引号**的（`placeholderLocal: …`），所以"带引号的键名出现在源码里"
  // 即可判定为被调用。（曾因只认形态 ①，把 placeholder / placeholderLocal 误报成"从未被调用"。）
  const isCalled = (key) => src.includes(`t('${key}'`) || src.includes(`'${key}'`)
  const unused = zh.filter((k) => !isCalled(k))
  if (unused.length) problems.push(`从未被调用的文案键：${unused.join(', ')}`)
  console.log(`  未被调用：${unused.length ? unused.join(', ') : '无'}`)

  // 【反向】源码里 t(…) 用到的键**必须都在字典里**。
  // 缺这个检查时，把 `t('modeBoth')` 拼成 `t('modeBothh')` 不会报任何错：
  // `t()` 取不到就返回 undefined，界面渲染成**空白**，静默得几乎无法察觉。
  // 两种形态都要收：静态 `t('k')` 与三元/参数里的字面量 `t(c ? 'a' : 'b', …)`。
  const calledKeys = new Set()
  for (const m of src.matchAll(/\bt\(/g)) {
    const tail = src.slice(m.index, m.index + 400)
    const stop = tail.search(/\)/)
    const chunk = stop >= 0 ? tail.slice(0, stop) : tail
    for (const s of chunk.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) calledKeys.add(s[1])
  }
  const missing = [...calledKeys].filter((k) => !zh.includes(k))
  if (missing.length) problems.push(`调用了但未定义的文案键：${missing.join(', ')}`)
  console.log(`  调用的键 ${calledKeys.size} 个 → 未定义：${missing.length ? missing.join(', ') : '无'}`)
}

console.log('\n【2】顶层定义引用自查（引用数 = 1 即只有定义处，等于死代码）')
const defs = []
lines.forEach((line, index) => {
  const fn = line.match(/^ {4}function ([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
  if (fn) defs.push({ name: fn[1], line: index + 1, kind: 'function' })
  const cv = line.match(/^ {4}(?:const|let) ([A-Za-z_][A-Za-z0-9_]*)\s*=/)
  if (cv) defs.push({ name: cv[1], line: index + 1, kind: 'const/let' })
})
for (const def of defs) {
  const count = src.match(new RegExp(`\\b${def.name}\\b`, 'g'))?.length ?? 0
  const dead = count <= 1
  if (dead) problems.push(`疑似死代码：${def.name} (L${def.line})`)
  console.log(`  ${dead ? '⚠️' : '  '} ${def.kind} ${def.name} (L${def.line}) 引用=${count}`)
}

console.log('\n【3】注入的 CSS：类名是否真的有使用（手写 bundle 没有打包器的 CSS 摇树）')
const cssStart = lines.findIndex((line) => line.includes('const css = `'))
if (cssStart < 0) {
  problems.push('找不到 ensureStyles 里的 CSS 模板字符串')
  console.log('  ⚠️ 未找到 CSS 模板')
} else {
  let css = ''
  for (let i = cssStart; i < lines.length; i += 1) {
    const line = lines[i]
    css += (i === cssStart ? line.split('`')[1] ?? '' : line)
    if (i !== cssStart && line.includes('`')) break
    css += '\n'
  }
  const selectors = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]+)/g)].map((m) => m[1]))]
  const orphan = selectors.filter((cls) => !src.includes(`'${cls}'`) && !src.includes(`"${cls}"`))
  if (orphan.length) problems.push(`CSS 里定义了但代码从未引用的类：${orphan.join(', ')}`)
  console.log(`  类选择器 ${selectors.length} 个｜未被引用：${orphan.length ? orphan.join(', ') : '无'}`)
}

console.log('\n【4】安全不变量')
const invariants = [
  { label: 'window.confirm 已清零（改用自绘对话框）', ok: !src.includes('window.confirm(') },
  { label: 'fetch 只出现在 apiFetch 内（保证护栏头）', ok: (src.match(/\bfetch\(/g)?.length ?? 0) === 1 },
  { label: "exports.inject 声明了 'slots'", ok: /exports.inject = [[^]]*'slots'/.test(src) },
  { label: '导出了 apply（否则 loader 报错）', ok: src.includes('exports.apply = apply') },
  { label: '声明了 CLIENT_BUILD 构建标记', ok: /CLIENT_BUILD = 'ui-/.test(src) },
]
for (const item of invariants) {
  if (!item.ok) problems.push(`不变量被破坏：${item.label}`)
  console.log(`  ${item.ok ? '✅' : '❌'} ${item.label}`)
}

console.log('\n【5】Host 侧（lib/index.js）顶层定义自查')
const hostFile = join(here, '..', 'lib', 'index.js')
const hostSrc = readFileSync(hostFile, 'utf8')
const hostDefs = [...hostSrc.matchAll(/^(?:function|const|let|export const|export function) ([A-Za-z_][A-Za-z0-9_]*)/gm)]
  .map((m) => m[1])
  .filter((name) => !['name', 'apply', 'inject', '__test'].includes(name))
for (const name of hostDefs) {
  const count = hostSrc.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0
  const exported = new RegExp(`__test = \\{[^}]*\\b${name}\\b`, 's').test(hostSrc)
  const dead = count <= 1 && !exported
  if (dead) problems.push(`Host 侧疑似死代码：${name}`)
  console.log(`  ${dead ? '⚠️' : '  '} ${name} 引用=${count}${exported ? '（单测导出）' : ''}`)
}

console.log('\n【6】CSS 模板字符串反引号自查')
// CSS 写在模板字符串里（`const css = \`…\``）⇒ **注释或内容里混入反引号会提前结束字符串**，
// 后果是 SyntaxError，但报错行指向注释、看起来与"注释"无关，极易看偏（实测踩过两次）。
// 判据：从 `const css = \`` 起逐行累计反引号，遇到以反引号开头的行即为结尾；总数必须恰好 2。
{
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes('const css = `'))
  if (start < 0) {
    problems.push('找不到 CSS 模板字符串的起始行')
    console.log('  ❌ 起始行未找到')
  } else {
    let ticks = 0
    let close = -1
    for (let i = start; i < lines.length; i++) {
      ticks += (lines[i].match(/`/g) || []).length
      if (i > start && /^`/.test(lines[i])) {
        close = i
        break
      }
    }
    if (close < 0) problems.push('CSS 模板字符串没有以单独一行的反引号结束')
    else if (ticks !== 2) problems.push(`CSS 段内反引号 ${ticks} 个（应为 2）—— 注释里混入了反引号？`)
    console.log(`  第 ${start + 1}–${close + 1} 行（${close - start + 1} 行）· 反引号 ${ticks} 个`)
  }
}

console.log('\n【7】Host 侧文案表（TEXT）：双向一致 + 无硬编码漏网')
// 存在理由（实测踩过）：Host 的面向用户文案是当**数据**发给客户端原样渲染的，
// 不经过任何翻译层。曾经 `planeNote` 写死中文 ⇒ 英文界面里冒出一行中文，
// 而且"加个 zh/en 词典"这种修法会再次悄悄漏掉新文案 —— 所以这里同时查三件事：
//   ① zh / en 键集合必须一致（不能只补一边）
//   ② 被调用的键必须有定义，定义了的键必须被调用（双向，杜绝拼错和死键）
//   ③ TEXT 块**之外**不得再出现面向用户的中文（服务端日志除外）
{
  const hostLines = hostSrc.split(/\r?\n/)
  const dictStart = hostLines.findIndex((l) => l.includes('const TEXT = {'))
  if (dictStart < 0) {
    problems.push('找不到 Host 侧文案表 const TEXT = {')
    console.log('  ❌ 起始行未找到')
  } else {
    const keys = { zh: [], en: [] }
    let section = null
    let depth = 0
    let dictEnd = -1
    for (let i = dictStart; i < hostLines.length; i += 1) {
      const line = hostLines[i]
      const open = line.match(/^ {2}(zh|en): \{/)
      if (open) section = open[1]
      if (section) {
        const key = line.match(/^ {4}([A-Za-z][A-Za-z0-9]*):/)
        if (key) keys[section].push(key[1])
      }
      for (const ch of line) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
      if (i > dictStart && depth === 0) {
        dictEnd = i
        break
      }
    }

    console.log(`  第 ${dictStart + 1}–${dictEnd + 1} 行 · zh=${keys.zh.length} 键 · en=${keys.en.length} 键`)
    const onlyZh = keys.zh.filter((k) => !keys.en.includes(k))
    const onlyEn = keys.en.filter((k) => !keys.zh.includes(k))
    if (onlyZh.length) problems.push(`Host 文案只有 zh 的键：${onlyZh.join(', ')}`)
    if (onlyEn.length) problems.push(`Host 文案只有 en 的键：${onlyEn.join(', ')}`)
    console.log(`  只在 zh：${onlyZh.length ? onlyZh.join(', ') : '无'}｜只在 en：${onlyEn.length ? onlyEn.join(', ') : '无'}`)

    // 调用形态：第一个字符串字面量就是键。第一个实参可能是 `lang`，也可能是
    // `requestLang(req)` —— **不能用「逗号前不许有括号」的写法**，那样会把
    // `T(requestLang(req), 'k')` 整类调用漏掉，误报成"定义了但从未调用"。
    // 扫描前先剥掉注释，免得文档示例里的 `T(lang, 'k')` 冒充真实调用。
    const hostCode = hostSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const called = new Set()
    // `(?<!function )` 排掉**函数声明本身** `function T(lang, key) {` —— 否则它会一路
    // 匹配到函数体里 `typeof value === 'function'` 的单引号，凭空造出一个键名 `function`。
    for (const m of hostCode.matchAll(/(?<!function )\bT\([^']*'([A-Za-z][A-Za-z0-9]*)'/g)) called.add(m[1])
    const missingHost = [...called].filter((k) => !keys.zh.includes(k))
    const unusedHost = keys.zh.filter((k) => !called.has(k))
    if (missingHost.length) problems.push(`Host 侧调用了但未定义的文案键：${missingHost.join(', ')}`)
    if (unusedHost.length) problems.push(`Host 侧定义了但从未调用的文案键：${unusedHost.join(', ')}`)
    console.log(`  调用 ${called.size} 个 → 未定义：${missingHost.length ? missingHost.join(', ') : '无'}`)
    console.log(`  定义 ${keys.zh.length} 个 → 未被调用：${unusedHost.length ? unusedHost.join(', ') : '无'}`)

    // ③ TEXT 块之外不得有面向用户的中文（内联 `// 注释` 先剥掉；服务端日志放行）
    const stray = []
    hostLines.forEach((line, index) => {
      if (index >= dictStart && index <= dictEnd) return
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      const slash = line.indexOf('//')
      const code = slash >= 0 ? line.slice(0, slash) : line
      if (!/[\u4e00-\u9fff]/.test(code)) return
      if (code.includes('ctx.logger')) return
      stray.push(`L${index + 1}: ${trimmed.slice(0, 60)}`)
    })
    if (stray.length) problems.push(`TEXT 之外仍有面向用户的中文：${stray.length} 处`)
    console.log(`  TEXT 之外的硬编码中文：${stray.length ? '' : '无'}`)
    for (const item of stray) console.log(`     · ${item}`)
  }
}

console.log('')
if (problems.length === 0) {
  console.log('结果：干净，未发现死代码或遗漏\n')
  process.exit(0)
}
console.log(`结果：发现 ${problems.length} 处需要处理\n`)
for (const item of problems) console.log('  · ' + item)
console.log('')
process.exit(1)
