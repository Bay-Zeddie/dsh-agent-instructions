/**
 * dsh-agent · Host 侧（Cordis 插件）
 *
 * 职责：为浏览器的「Agent 设定」面板提供回环专用路由，读写 dsh **原生**的
 * AGENTS.md，并把官方的指令加载语义如实反映到界面上。
 *
 * ── 与官方源码的一致性核验（全部有据） ───────────────────────────────────
 *
 *  1. 路由接口：`{ kind: 'exact', path, handler }` 完全对齐
 *     `@deepseek-ai/dsh-webserver` 的 `WebRoute`（`host/webserver/src/index.ts:42-48`：
 *     kind 为 'exact' | 'prefix'，path 是**不含尾斜杠的绝对 pathname**，handler
 *     拥有完整响应生命周期），`register()` 返回 disposer。
 *     官方 dispatch 先取 `new URL(req.url).pathname` 再匹配，故查询串会被自动剥离。
 *
 *  2. Cordis 约定：`ctx.effect(callback, label)`、`ctx.logger`、以及
 *     `name` / `inject` / `apply` 三个导出，与官方插件（如
 *     `client/connection/src/index.ts:153`）用法同形。
 *
 *  3. ⚠️ **鉴权事实**：官方 `WebServer.match()` 是「exact 命中即返回，不再走
 *     prefix」，而 `dsh web` 的令牌鉴权由 **fallback（SPA）** 承担 ——
 *     因此**一切命名路由都天然绕过令牌栅栏**（实测：`GET /` → 401，
 *     `GET /api/dsh-agent/state` 无令牌 → 200）。故本插件自带栅栏：
 *     回环来源 + Origin/Sec-Fetch-Site 同源 + 写操作强制 application/json
 *     （阻断 `fetch(..., {mode:'no-cors'})` 这类无预检的跨站简单请求，
 *     否则恶意网页可 CSRF 改写 AGENTS.md 造成提示词注入）。
 *
 *  4. ⚠️ **平面事实**：`agent-instructions` 的**生效实例在 preset 平面**
 *     （`presets/<id>/agent.cordis.yml` 各自声明），web-app bundle 把 host 平面
 *     那份设为 `disabled: true`，两平面不合并 config —— 所以在 host 平面写 config
 *     覆盖**无效**。本插件改为**只读 preset 平面**取真实上限，绝不写它。
 *
 * ── 适配能力 ────────────────────────────────────────────────────────────
 *
 *  A. 指令预算（只读）：复刻官方发现链 —— `.git` 项目根 + 逐层目录 + 四个候选名
 *     （AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md）+ 同目录 trimmed
 *     内容去重，顺序为「宽泛 → 具体」；并模拟官方裁剪（超出时从最宽泛开始丢）。
 *  B. 上限与归属（只读）：从 `settings.yaml` 的 `agent-presets.default` 找出当前
 *     preset，读其 `agent-instructions` 声明的 `maxBytes`；**未声明即该 preset
 *     不加载指令**（如 `minimal`），此时预算不适用。
 *  C. 全局层开关（可写，**暂停**而非删除）：在 `$DSH_HOME/AGENTS.md` 与
 *     `$DSH_HOME/AGENTS.md.disabled` 之间改名。官方全局路径硬编码为
 *     `join(dshHome, 'AGENTS.md')`（`agent-instructions/src/render.ts` 的
 *     `USER_GLOBAL_FILE`），探测不到即判 absent 跳过；改名与平面无关，
 *     对所有平面同时生效，且内容一个字节不丢。
 *  D. 明确不做：「仅全局」（停项目层）—— 项目级文件名由候选列表决定、路径散落在
 *     用户工作区，非侵入式无法让它「探测不到」。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 *  - 文件名固定为 AGENTS.md（外加全局层的 `.disabled` 变体），不接受任意文件名，
 *    因此永远只是「AGENTS.md 的编辑器」，不会退化成通用文件读写口。
 *  - **只读**官方源码与 preset 文件，从不写入。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-agent-instructions'

/**
 * 插件版本。**每次改动 Host 侧（本文件）都必须提升它。**
 *
 * 存在的理由：Host 代码只在 `dsh web` 启动时装载，改了不重启就是旧代码在跑，
 * 而"旧代码"和"新代码"从界面上看不出区别（本项目已经因此困惑过两次）。
 * 界面会显示这个版本号，对不上就说明该重启了。
 */
export const PLUGIN_VERSION = '0.4.12'

/** 路由注册前，web 服务器必须先就位。 */
export const inject = ['webServer']

/** 唯一允许编辑的文件名。 */
const FILE_NAME = 'AGENTS.md'

/**
 * 「暂停」后缀。
 * 官方候选名是**闭集**（`config.ts:11-13`：4 个名字），改一个字符它就探测不到了，
 * 所以「暂停」= 给文件名加这个后缀 —— 内容一个字节不丢，改回名即完全恢复。
 *
 * ⚠️ 暂停态的文件名**一律现算**（`X + PAUSED_SUFFIX`），不要再放一个 `'AGENTS.md.disabled'`
 * 这样的成品常量 —— 那等于把同一个事实写两处，日后改后缀必然漏改其中一处。
 */
const PAUSED_SUFFIX = '.disabled'

/** 官方默认渲染预算（preset 的 agent.cordis.yml 声明值）。 */
const DEFAULT_MAX_BYTES = 65536

/**
 * 官方**单文件**读取上限（`agent-instructions/src/files.ts` 的
 * `DEFAULT_MAX_SOURCE_BYTES`）。注意 `readBounded` 是
 * `if (file.size > maxSourceBytes) return undefined` —— 超过即被**静默忽略**，
 * 既不加载也不报错，所以界面上必须显式提示。
 */
const MAX_SOURCE_BYTES = 1048576

/** 内容写入的请求体上限：官方单文件上限 + JSON 信封余量。 */
const MAX_BODY_BYTES = MAX_SOURCE_BYTES + 65536

/** 开关请求体上限（只有一个小字段）。 */
const MAX_TOGGLE_BODY_BYTES = 4096

/**
 * 层开关请求体上限。
 * 批量模式切换会带上「链上每一层」的改名指令（每项约数十字节），
 * 比单字段开关大得多，所以单独给一个更宽的上限。
 */
const MAX_LAYERS_BODY_BYTES = 32768

/**
 * 写/读路由要求的自定义头。
 *
 * 跨站的 `fetch(..., { mode: 'no-cors' })` **无法设置自定义头**（会触发预检），
 * 而预检又必然失败（我们不回 CORS 头）—— 因此这条是最直接的 CSRF 防线，
 * 生态同类插件（如 dsh-plugin-agents-memory）也采用「要求插件专属请求头」。
 */
const GUARD_HEADER = 'x-dsh-agent'

/** 复刻官方 `agent-instructions` 的默认配置常量。 */
const PROJECT_ROOT_MARKERS = ['.git']
const BASE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']

/**
 * 官方同一个目录里的候选优先级（基础候选在前，本地叠加候选在后）——
 * 即 `discoverInstructionFiles` 的两轮循环顺序（`files.ts:307`）。
 */
const ALL_CANDIDATES = [...BASE_CANDIDATES, ...LOCAL_CANDIDATES]

/**
 * 「本地叠加层」的首选名（官方 `config.ts:13` 里的 `AGENTS.local.md`）。
 *
 * 它的定位是**个人规则**：和同目录的 `AGENTS.md` 并存、**在它之后加载**（因此优先级更高）、
 * 按社区惯例通常不进版本控制。界面上它被呈现为「个性化规则」。
 *
 * ⚠️ 官方明确说了「**用户全局 `$DSH_HOME` scope 没有本地 overlay**」（`agent-instructions/README.zh.md`），
 * 所以这一行**只能补在项目层**——补到全局层就是个永远不会被读取的假入口。
 */
const LOCAL_FILE_NAME = LOCAL_CANDIDATES[0]

/** 官方设置与 preset 落点。 */
const SETTINGS_FILE = 'settings.yaml'
const USER_PRESET_DIR = '.agent-presets'
const PRESET_AGENT_FILE = 'agent.cordis.yml'
const PRESETS_RELATIVE = join('packages', 'preset', 'agent-presets', 'presets')

/* ------------------------------------------------------------------ 基础工具 */

/** 只接受回环来源。 */
function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * 同源栅栏（对齐 dsh 自身的 browser-trust 语义）。
 *
 *  - `Origin` 缺失：非浏览器客户端（curl 等），放行 —— 已由回环来源兜底。
 *  - `Origin` 为 `null`：沙箱 iframe / data: URL，不可信，拒绝。
 *  - `Origin` 非本机 host：拒绝。
 *  - `Sec-Fetch-Site: cross-site`：浏览器明确标注的跨站请求，拒绝。
 *
 * 本插件路由绕过 dsh 的令牌栅栏，所以这道检查是**唯一**的跨站防线。
 */
function isLocalOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return false
    try {
      const host = new URL(origin).hostname
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return false
    } catch {
      return false
    }
  }
  const site = req.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false
  return true
}

/**
 * 统一入口栅栏。返回 false 表示已作答，调用方应立即返回。
 * @param write 写操作额外要求 `content-type: application/json` —— 浏览器对
 *        `fetch(..., { mode: 'no-cors' })` 只允许简单 content-type，
 *        因此这条能阻断不需要预检的跨站写入。
 */
function guard(req, res, write) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  if (!isLocalOrigin(req)) {
    writeJson(res, 403, { error: 'forbidden: cross-origin request rejected' })
    return false
  }
  if (req.headers?.[GUARD_HEADER] !== '1') {
    writeJson(res, 403, { error: `forbidden: missing ${GUARD_HEADER}: 1 header` })
    return false
  }
  if (write) {
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      writeJson(res, 415, { error: 'content-type 必须是 application/json' })
      return false
    }
  }
  return true
}

/**
 * 两个路径是否指向同一个文件。
 * Windows 文件系统大小写不敏感，所以 win32 下按小写比较。
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 把路径折算成 Map 的比较键。
 * Windows 文件系统大小写不敏感（`C:\X\AGENTS.md` 与 `c:\x\agents.md` 是同一个文件），
 * 所以白名单命中判定必须按小写比较 —— 否则大小写不同的等价路径会被误判为「链外」。
 */
function pathKey(file) {
  return process.platform === 'win32' ? String(file).toLowerCase() : String(file)
}

/** 统一的 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 读取请求体并解析 JSON，带大小上限。 */
function readJsonBody(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error(`请求内容超过 ${limit} 字节上限`)
        error.code = 'BODY_TOO_LARGE'
        rejectPromise(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolvePromise({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolvePromise(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        const error = new Error('请求体不是合法 JSON')
        error.code = 'BODY_NOT_JSON'
        rejectPromise(error)
      }
    })
    req.on('error', rejectPromise)
  })
}

/* -------------------------------------------------------------- 路径与文件 */

/**
 * 解析 DSH_HOME：显式配置 > $DSH_HOME > ~/.dsh。
 * 复刻官方 home-paths 的优先级（纯空白的环境变量视为未设置）。
 */
function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim())
  return join(homedir(), '.dsh')
}

/** 只取元数据（不读内容）。 */
async function probeFile(file) {
  try {
    const st = await stat(file)
    if (!st.isFile()) return { path: file, exists: false, bytes: 0, mtime: null }
    return { path: file, exists: true, bytes: st.size, mtime: st.mtime.toISOString() }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: file, exists: false, bytes: 0, mtime: null }
    throw error
  }
}

/** 读取指定文件的完整状态（含内容）。 */
async function readStateAt(file) {
  try {
    const st = await stat(file)
    // 路径存在但不是普通文件（目录 / 设备等）：按「读不到内容」处理，不额外造一个没人读的字段
    if (!st.isFile()) return { path: file, exists: false }
    const content = await readFile(file, 'utf8')
    return {
      path: file,
      exists: true,
      content,
      mtime: st.mtime.toISOString(),
      limitBytes: DEFAULT_MAX_BYTES,
      sourceLimitBytes: MAX_SOURCE_BYTES,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: file,
        exists: false,
        content: '',
        mtime: null,
        limitBytes: DEFAULT_MAX_BYTES,
        sourceLimitBytes: MAX_SOURCE_BYTES,
      }
    }
    throw error
  }
}

/**
 * 原子写入：先写同目录临时文件，再 `rename` 覆盖目标。
 *
 * 官方自带 `packages/util/atomic-write`（app-boot / hmr / plugin-manager /
 * credentials-local / llm-deepseek 都在用），本插件不引依赖、用同样的手法实现：
 * 同目录 rename 在同一卷上是原子操作，中途崩溃不会把目标文件截断成半截内容。
 * 临时文件名用 `.` 前缀且不匹配任何官方候选名，因此不会被指令加载器发现。
 */
async function writeAtomic(targetPath, content) {
  const temp = join(dirname(targetPath), `.${basename(targetPath)}.${String(process.pid)}.${String(Date.now())}.tmp`)
  await writeFile(temp, content, 'utf8')
  try {
    await rename(temp, targetPath)
  } catch (error) {
    try {
      await unlink(temp)
    } catch {
      /* 清理失败不影响主错误 */
    }
    throw error
  }
}

/** 取文件 trimmed 内容的摘要，用于复刻官方「同目录按内容去重」。 */
async function trimmedDigest(file) {
  try {
    const raw = await readFile(file, 'utf8')
    return createHash('sha256').update(raw.trim(), 'utf8').digest('hex')
  } catch {
    return `unreadable:${file}`
  }
}

/**
 * 解析全局层的真实落盘文件。
 *  - `AGENTS.md` 存在               → 生效，目标是它
 *  - 只有 `AGENTS.md.disabled` 存在 → 已暂停，目标是它（仍可编辑，一开启即生效）
 *  - 两个都不存在                   → 生效（保存时会创建 `AGENTS.md`）
 */
async function resolveGlobalTarget() {
  const dshHome = resolveDshHome()
  const activePath = join(dshHome, FILE_NAME)
  const pausedPath = join(dshHome, FILE_NAME + PAUSED_SUFFIX)
  const active = await probeFile(activePath)
  if (active.exists) {
    return { dshHome, activePath, pausedPath, path: activePath, paused: false, file: active }
  }
  const paused = await probeFile(pausedPath)
  if (paused.exists) {
    return { dshHome, activePath, pausedPath, path: pausedPath, paused: true, file: paused }
  }
  return { dshHome, activePath, pausedPath, path: activePath, paused: false, file: active }
}

/**
 * 解析工作区目录。只接受绝对路径；留空回落到 dsh 启动目录。
 * 拒绝盘符根，避免把整个盘当成工作区。
 */
function resolveWorkspaceDir(rawCwd) {
  if (typeof rawCwd !== 'string' || rawCwd.trim() === '') {
    return { dir: process.cwd() }
  }
  const dir = resolve(rawCwd.trim())
  if (!dir || dir === resolve(dir, sep)) return { error: 'cwd 非法' }
  return { dir }
}

/* -------------------------------------------- 官方发现链（复刻自官方源码语义） */

/** 向上找到第一个含项目根标记的目录；找不到则回落到 cwd。 */
async function findProjectRoot(cwd, markers) {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      try {
        await stat(join(current, marker))
        return current
      } catch {
        /* 继续找下一个标记 / 上一层 */
      }
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** 从根到 cwd 的目录链，顺序为「宽泛 → 具体」。 */
function ancestorChain(root, cwd) {
  const chain = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/* ------------------------------------------------ 层清单与链内白名单（可写范围） */

/**
 * 构造「完整层清单」—— 界面上那份**可点击的列表**的数据源。
 *
 * 本函数是**唯一的发现器**：既复刻官方「全局 + 项目根→cwd 逐层 + 4 个候选名 +
 * 同目录 trimmed 去重」的发现语义，也**保留已暂停的层** —— 用户才能看见「暂停」这个
 * 状态、也才能把它恢复回来（预算统计再从这里派生"官方此刻真正会加载的那些份"）。
 *
 * ⚠️ 同一个目录里的候选**逐个列出，不做「一层一行」的折叠**。
 * 折叠过一版，实测立刻出问题：`deepseek-harness/` 下同时有 `AGENTS.md`(17,182B)
 * 和 `CLAUDE.md`(9B)，官方两份都读，而折叠后的列表只出一行 ⇒ ① 第二份没有编辑入口；
 * ② 界面同时显示「3 个文件都会生效」和 2 行，自相矛盾。
 *
 * 每行的 `included` = 按官方语义「这一份此刻真的会被加载」：
 * 文件存在 ∧ 用官方名（未被暂停）∧ 未被同目录去重 ∧ 未超单文件上限。
 */
async function buildLayerView(workspaceDir, global) {
  const rows = []
  const globalActive = await probeFile(global.activePath)
  const globalPaused = await probeFile(global.pausedPath)
  const globalCurrent = globalActive.exists ? globalActive : globalPaused
  rows.push({
    base: global.activePath,
    path: globalCurrent.exists ? globalCurrent.path : global.activePath,
    displayPath: '<DSH_HOME>/AGENTS.md',
    layer: 'user-global',
    kind: 'global',
    enabled: globalActive.exists,
    exists: globalActive.exists || globalPaused.exists,
    bytes: globalCurrent.bytes,
    duplicate: false,
    included: globalActive.exists && globalCurrent.exists && globalCurrent.bytes <= MAX_SOURCE_BYTES,
  })

  const cwd = resolve(workspaceDir)
  const projectRoot = await findProjectRoot(cwd, PROJECT_ROOT_MARKERS)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    // 官方在同目录内按 trimmed 内容去重（保留最早的候选，不同目录不合并）
    const digests = new Set()
    let dirHasFile = false
    for (const candidate of ALL_CANDIDATES) {
      const base = join(dir, candidate)
      // ⚠️ 工作区就是 DSH_HOME 时，这里的 `AGENTS.md` 与**全局层是同一个文件**。
      // 再列一行会让同一份文件在列表里出现两次，并让「切生效范围」的改名计划自相冲突：
      // 同一个文件先暂停再启用（或反过来），**执行顺序决定结果** ——
      // 实测点「仅全局」（全局启用 + 项目暂停）反而把它暂停了，界面上则显示成"自定义"。
      if (samePath(base, global.activePath)) continue
      const active = await probeFile(base)
      const paused = await probeFile(base + PAUSED_SUFFIX)
      if (!active.exists && !paused.exists) continue
      dirHasFile = true
      const current = active.exists ? active : paused
      let duplicate = false
      if (active.exists) {
        const digest = await trimmedDigest(base)
        if (digests.has(digest)) duplicate = true
        else digests.add(digest)
      }
      rows.push({
        base,
        path: current.path,
        displayPath: relative(projectRoot, base) || candidate,
        layer: 'project',
        // 本地叠加层（AGENTS.local.md / CLAUDE.local.md）与基础候选要能区分开 ——
        // 界面据此把它呈现为「个性化规则」而不是普通的「工作区文件」。
        kind: LOCAL_CANDIDATES.includes(candidate) ? 'local' : 'project',
        enabled: active.exists,
        exists: true,
        bytes: current.bytes,
        duplicate,
        included: active.exists && !duplicate && current.bytes <= MAX_SOURCE_BYTES,
      })
    }
    // 给**工作区目录本身**补「可创建」入口（其余层不补，否则列表会被空条目塞满）：
    if (samePath(dir, cwd)) {
      // ① 基础候选（AGENTS.md）—— 仅当这一层一份候选都没有时补
      if (!dirHasFile) {
        const base = join(dir, FILE_NAME)
        // 这个「可创建」占位就是全局层本身时，不重复列一行
        if (!samePath(base, global.activePath)) {
          rows.push({
            base,
            path: base,
            displayPath: relative(projectRoot, base) || FILE_NAME,
            layer: 'project',
            kind: 'project',
            enabled: false,
            exists: false,
            bytes: 0,
            duplicate: false,
            included: false,
          })
        }
      }
      // ② 本地叠加层（AGENTS.local.md，界面上叫「个性化规则」）——
      //    **与 ① 无关**：它是独立的附加规则文件，所以即使 AGENTS.md 已经存在，
      //    也仍然要给「个性化」留一个入口（否则用户根本不知道这东西存在）。
      //    ⚠️ 只补项目层 —— 官方明确「用户全局 $DSH_HOME scope 没有本地 overlay」，
      //    补到全局层就是个永远不会被读取的假入口。
      const localBase = join(dir, LOCAL_FILE_NAME)
      const localActive = await probeFile(localBase)
      const localPaused = await probeFile(localBase + PAUSED_SUFFIX)
      if (!localActive.exists && !localPaused.exists) {
        rows.push({
          base: localBase,
          path: localBase,
          displayPath: relative(projectRoot, localBase) || LOCAL_FILE_NAME,
          layer: 'project',
          kind: 'local',
          enabled: false,
          exists: false,
          bytes: 0,
          duplicate: false,
          included: false,
        })
      }
    }
  }
  return rows
}

/**
 * 链内白名单：**按规则重算**出全部合法目标路径（官方候选闭集 × 祖先链 × {原名, .disabled}）。
 *
 * ⚠️ 不能拿 `buildLayerView` 的结果当白名单。那份清单是**磁盘现状**（只含真实存在的文件，
 * 加上工作区目录那一个"可创建"占位），拿它做校验会漏掉两类合法目标：
 *   ① 尚未创建的文件位 —— 用户正是要靠它来新建；
 *   ② 同目录里还没出现的其它候选名（例如只建 `CLAUDE.md`、不建 `AGENTS.md`）。
 * 白名单必须是**位置**的集合（规则推导），不能是**文件**的集合（磁盘扫描）。
 *
 * 关键安全性质：**链外路径（用户主目录、系统目录、任意其它文件）永远不在集合里**，
 * 这条路由因此不会退化成通用文件读写口。
 */
async function buildAllowedTargets(workspaceDir, dshHome) {
  const allowed = new Map()
  const put = (file, meta) => {
    allowed.set(pathKey(file), Object.assign({ path: file }, meta))
  }

  // 全局层：官方硬编码 `join(dshHome, USER_GLOBAL_FILE)`（render.ts:98），
  // 不走候选列表 —— 所以这里也只放这一个名字的两种形态。
  const globalBase = join(dshHome, FILE_NAME)
  put(globalBase, { layer: 'user-global', displayPath: '<DSH_HOME>/AGENTS.md', pausedVariant: false, base: globalBase })
  put(globalBase + PAUSED_SUFFIX, { layer: 'user-global', displayPath: '<DSH_HOME>/AGENTS.md', pausedVariant: true, base: globalBase })

  const cwd = resolve(workspaceDir)
  const projectRoot = await findProjectRoot(cwd, PROJECT_ROOT_MARKERS)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidate of ALL_CANDIDATES) {
      const base = join(dir, candidate)
      const displayPath = relative(projectRoot, base) || candidate
      // `base` 是这一层的**身份**（官方名所在的路径）；`pausedVariant` 只是它此刻的形态。
      put(base, { layer: 'project', displayPath, pausedVariant: false, base })
      put(base + PAUSED_SUFFIX, { layer: 'project', displayPath, pausedVariant: true, base })
    }
  }
  return allowed
}

/**
 * 把外部传入的目标解析成**白名单内**的绝对路径，并**归一化到该层实际存在的形态**。
 * @returns `{ path }` 命中；`{ error }` 表示链外或非法（调用方回 403）。
 */
async function resolveTargetPath(rawTarget, workspaceDir, dshHome) {
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') return { error: '缺少 target 路径' }
  const target = resolve(rawTarget.trim())
  const allowed = await buildAllowedTargets(workspaceDir, dshHome)
  const hit = allowed.get(pathKey(target))
  if (!hit) return { error: '拒绝：该路径不在当前指令链内（只允许官方候选名所在的位置）' }

  // 归一化：一层的**身份**是 `base`（官方名所在路径），`X.md` 与 `X.md.disabled` 只是它此刻的形态。
  // 界面会把上次的编辑目标记在 localStorage 里，而那个路径可能是改名前的形态 ——
  // 不归一化的话，一打开面板就会看到「正在编辑 …/AGENTS.md.disabled」+「还没有这个文件 · 保存后创建」，
  // 可那一层其实有文件（只是叫官方名）。用户会被误导去"重新创建一个"。
  // 注：只在**另一形态确实存在**时才归一 —— 该层一份都没有（可创建的新层）时保持原样，
  // 否则会把"新建"入口也一起改掉。
  if (hit.path === target) {
    const wanted = await probeFile(hit.path)
    if (!wanted.exists) {
      const sibling = hit.pausedVariant ? hit.base : hit.base + PAUSED_SUFFIX
      const siblingInfo = await probeFile(sibling)
      if (siblingInfo.exists) return Object.assign({}, hit, { path: sibling })
    }
  }
  return hit
}

/**
 * 按「启用/暂停」改名一个层。**只改名，不删内容**。
 * @param base 该层的官方名全路径（`.../AGENTS.md`）；暂停态即它加 `.disabled`。
 * @returns `{ path, changed }` —— path 是操作后的实际落盘文件。
 */
async function setLayerEnabled(base, enabled) {
  const pausedPath = base + PAUSED_SUFFIX
  const active = await probeFile(base)
  const paused = await probeFile(pausedPath)
  if (enabled) {
    if (active.exists || !paused.exists) return { path: active.exists ? base : pausedPath, changed: false }
    await rename(pausedPath, base)
    return { path: base, changed: true }
  }
  if (paused.exists || !active.exists) return { path: paused.exists ? pausedPath : base, changed: false }
  await rename(base, pausedPath)
  return { path: pausedPath, changed: true }
}

/**
 * 某个生效范围下，这一层**应该**是启用还是暂停。
 *  - `both`    一起生效：全部启用
 *  - `project` 仅项目：全局层暂停，项目各层启用
 *  - `global`  仅全局：全局层启用，项目各层暂停
 */
function wantEnabledFor(mode, row) {
  if (mode === 'global') return row.layer === 'user-global'
  if (mode === 'project') return row.layer !== 'user-global'
  return true
}

/**
 * 切到某个生效范围时，**状态需要真正改变**的那些层。
 * 界面拿它渲染确认框的清单 —— 只列会动的文件，不把"本来就是这样"的层也列进去。
 * 由 host 统一算，client 不再自己复制一份规则：两份规则一定会漂移，
 * 而"确认框说改 2 个、实际改了 3 个"是最难被发现的那类不一致。
 */
function pendingModeChanges(mode, rows) {
  return rows
    .filter((row) => row.exists && wantEnabledFor(mode, row) !== row.enabled)
    .map((row) => ({
      base: row.base,
      displayPath: row.displayPath,
      layer: row.layer,
      enabled: wantEnabledFor(mode, row),
    }))
}

/**
 * 切到某个生效范围时要逐层执行的改名清单（含"本来就是这个状态"的层，靠 `setLayerEnabled` 幂等）。
 * 不存在的层不在清单里 —— 没有文件可改，也不会凭空造出文件来。
 */
function planModeChanges(mode, rows) {
  return rows.filter((row) => row.exists).map((row) => ({ base: row.base, enabled: wantEnabledFor(mode, row) }))
}

/**
 * 由磁盘现状反推当前处于哪种模式（界面高亮用）。
 *
 * `project` 与 `global` 都要求项目层**整体一致**：只要链上有一层项目文件与其余层不同，
 * 就返回 `custom` —— 否则「项目根那份被暂停、只有子目录那份还在生效」会被显示成
 * 「仅全局」，用户会以为项目层全停了。模式是用来告诉用户现状的，宁可说「自定义」，
 * 也不能给一个近似但错误的结论。
 *
 * 不存在的层不参与判定（没有文件就无所谓启用/暂停）。
 */
function deriveMode(rows) {
  const globalRow = rows.filter((row) => row.layer === 'user-global')[0]
  const projectRows = rows.filter((row) => row.layer === 'project' && row.exists)
  const globalOn = !globalRow || !globalRow.exists ? true : globalRow.enabled
  const allProjectOn = projectRows.length === 0 || projectRows.every((row) => row.enabled)
  const allProjectOff = projectRows.length > 0 && projectRows.every((row) => !row.enabled)
  if (globalOn && allProjectOn) return 'both'
  if (!globalOn && allProjectOn) return 'project'
  if (globalOn && allProjectOff) return 'global'
  return 'custom'
}

/* ------------------------------------------------- preset 平面（只读，不写） */

/** 从 `settings.yaml` 里取 `agent-presets.default`：逐行解析，避免依赖 YAML 库。 */
function parsePresetDefault(raw) {
  const lines = raw.split(/\r?\n/)
  let inSection = false
  for (const line of lines) {
    if (/^agent-presets:\s*$/.test(line)) {
      inSection = true
      continue
    }
    if (!inSection) continue
    if (/^\S/.test(line)) break // 顶层下一个键，段结束
    const match = line.match(/^\s+default:\s*(\S+)/)
    if (match) return match[1]
  }
  return null
}

/**
 * 解析一个 preset 文件里的 `agent-instructions` 行。
 * `disabled: true` 视为未启用；找不到即该 preset 不加载指令文件（如 `minimal`）。
 */
function parseAgentInstructionsRow(raw) {
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s*id:\s*agent-instructions\s*$/.test(lines[i])) continue
    let maxBytes = null
    let disabled = false
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (/^\s*-\s*id:/.test(line)) break // 下一条 entry
      const bytes = line.match(/^\s+maxBytes:\s*(\d+)/)
      if (bytes) maxBytes = Number(bytes[1])
      if (/^\s+disabled:\s*true\b/.test(line)) disabled = true
    }
    return { enabled: !disabled, maxBytes }
  }
  return { enabled: false, maxBytes: null }
}

/**
 * 从 `process.argv[1]` 反推 harness 仓库根。
 * dsh 以 `node <repo>/apps/cli/lib/bin.js …` 启动，故可上溯到含 preset 目录的那一级。
 * 纯只读探测；找不到返回 null（预算回落官方默认值）。
 */
function resolveHarnessRoot() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return null
  let dir = resolve(entry)
  for (let i = 0; i < 6; i += 1) {
    dir = dirname(dir)
    if (!dir || dir === dirname(dir)) return null
    if (existsSync(join(dir, PRESETS_RELATIVE))) return dir
  }
  return null
}

/**
 * 解析当前生效的指令上限与归属。**只读** preset 平面，绝不写入。
 * 用户 preset（`$DSH_HOME/.agent-presets/<id>/`）优先于官方 shipped preset。
 */
async function resolveInstructionConfig() {
  const presetId = await (async () => {
    try {
      return parsePresetDefault(await readFile(join(resolveDshHome(), SETTINGS_FILE), 'utf8'))
    } catch {
      return null
    }
  })()

  const fallback = {
    presetId,
    limit: DEFAULT_MAX_BYTES,
    limitSource: 'default',
    instructionsEnabled: true,
    presetPath: null,
    planeNote: '未能定位 preset 声明，按官方默认上限估算',
  }
  if (!presetId) return { ...fallback, planeNote: 'settings.yaml 未记录默认 preset，按官方默认上限估算' }

  const roots = [{ dir: join(resolveDshHome(), USER_PRESET_DIR), source: 'user-preset' }]
  const harnessRoot = resolveHarnessRoot()
  if (harnessRoot) roots.push({ dir: join(harnessRoot, PRESETS_RELATIVE), source: 'shipped-preset' })

  for (const root of roots) {
    const presetPath = join(root.dir, presetId, PRESET_AGENT_FILE)
    let raw
    try {
      raw = await readFile(presetPath, 'utf8')
    } catch {
      continue
    }
    const parsed = parseAgentInstructionsRow(raw)
    if (!parsed.enabled) {
      return {
        presetId,
        limit: DEFAULT_MAX_BYTES,
        limitSource: root.source,
        instructionsEnabled: false,
        presetPath,
        planeNote: `preset「${presetId}」未声明 agent-instructions ⇒ 该 preset 下 AGENTS.md 完全不加载`,
      }
    }
    return {
      presetId,
      limit: parsed.maxBytes ?? DEFAULT_MAX_BYTES,
      limitSource: root.source,
      instructionsEnabled: true,
      presetPath,
      planeNote: `preset「${presetId}」声明上限 ${parsed.maxBytes ?? DEFAULT_MAX_BYTES} 字节（${root.source === 'user-preset' ? '用户 preset' : '官方 preset'}，只读）`,
    }
  }
  return fallback
}

/* ------------------------------------------------------------------ 预算统计 */

/**
 * 按官方语义统计预算并模拟裁剪。
 *
 * 官方规则（`agent-instructions/src/render.ts` 的 `renderInstructionContext`）：
 * 文件已按「宽泛 → 具体」排好；超出 `maxBytes` 时从最宽泛的一层开始逐个丢弃，
 * 只保留最具体的；连最具体那份也放不下才截断它。⇒ 全局这份最先出局。
 *
 * 注意：这里是**文件字节合计**，不含官方渲染时的分段标题/标记行，
 * 故为近似值（真实占用会略高几十字节／文件）。
 */
function summarizeBudget(layers, limit, enablement) {
  // 官方 readBounded：单文件超过 maxSourceBytes 直接 return undefined ⇒ 该文件**不参与渲染**
  const usable = layers.filter((layer) => layer.bytes <= MAX_SOURCE_BYTES)
  const totalBytes = usable.reduce((sum, layer) => sum + layer.bytes, 0)
  const over = totalBytes > limit
  let omittedCount = 0
  if (over) {
    let remaining = totalBytes
    for (let start = 1; start < usable.length && remaining > limit; start += 1) {
      remaining -= usable[start - 1].bytes
      omittedCount = start
    }
  }
  const brief = ({ displayPath, bytes, layer }) => ({ displayPath, bytes, layer })
  return {
    limit,
    sourceLimitBytes: MAX_SOURCE_BYTES,
    totalBytes,
    over,
    layers: layers.map(({ path, displayPath, bytes, layer }) => ({
      path,
      displayPath,
      bytes,
      layer,
      ignored: bytes > MAX_SOURCE_BYTES,
    })),
    omitted: usable.slice(0, omittedCount).map(brief),
    notRendered: layers.filter((layer) => layer.bytes > MAX_SOURCE_BYTES).map(brief),
    // `...enablement` 带出 presetId / instructionsEnabled / planeNote（界面用它们解释上限从哪来）。
    // 这里曾额外回传 approximated / limitSource / pruningNotice 三个字段，
    // 但契约测试逐字段核对后确认**从来没有任何消费方** —— 已删。
    ...enablement,
  }
}

/**
 * 从「完整层清单」派生「官方此刻真的会加载的那些份」，供预算统计。
 *
 * 这里曾经是**独立的第二次发现**（各遍历一次祖先链、各读一遍文件算摘要）——
 * 既是重复逻辑，又存在真实的自相矛盾窗口：两次读取之间文件被改动，
 * 界面就会同时说「列表 3 层」和「合计 2 层」，同一个面板两个答案。
 * 现在两者同源，不可能再打架。
 */
function includedLayersOf(rows) {
  return rows
    .filter((row) => row.exists && row.enabled && !row.duplicate)
    .map((row) => ({
      path: row.path,
      displayPath: row.displayPath,
      bytes: row.bytes,
      layer: row.layer,
    }))
}

/**
 * 预算统计。输入是**已经发现好的层清单**（不再自己发现一次）；只读 preset 平面取上限。
 */
async function buildBudget(rows) {
  const instruction = await resolveInstructionConfig()
  const globalRow = rows.filter((row) => row.layer === 'user-global')[0]
  return {
    ...summarizeBudget(includedLayersOf(rows), instruction.limit, {
      presetId: instruction.presetId,
      instructionsEnabled: instruction.instructionsEnabled,
      planeNote: instruction.planeNote,
    }),
    // 全局层被改名暂停时，这里给的是**暂停后**的真实路径（`.disabled`），界面据此提示
    globalPath: globalRow && globalRow.exists ? globalRow.path : null,
    globalPaused: Boolean(globalRow && globalRow.exists && !globalRow.enabled),
  }
}

/* ------------------------------------------------------------------ 插件入口 */

/**
 * 纯函数出口，仅供离线单测使用（不含任何 I/O）。
 * 让「官方语义复刻」这部分可被独立验证，无需改动用户配置。
 */
export const __test = {
  parsePresetDefault,
  parseAgentInstructionsRow,
  summarizeBudget,
  findProjectRoot,
  ancestorChain,
  isLocalOrigin,
  guard,
  samePath,
  pathKey,
  deriveMode,
  buildAllowedTargets,
  buildLayerView,
  planModeChanges,
  pendingModeChanges,
  setLayerEnabled,
  DEFAULT_MAX_BYTES,
  MAX_SOURCE_BYTES,
  GUARD_HEADER,
  ALL_CANDIDATES,
  PAUSED_SUFFIX,
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      // 读取状态：完整层清单 + 当前编辑目标 + 全局层开关 + 指令预算（真实发现链）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-agent/state',
        handler: async (req, res) => {
          if (!guard(req, res, false)) return
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rawCwd = url.searchParams.get('cwd')
          const rawTarget = url.searchParams.get('target')
          const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'workspace'
          const workspace = resolveWorkspaceDir(rawCwd)
          if (workspace.error) {
            writeJson(res, 400, { error: workspace.error })
            return
          }
          try {
            const global = await resolveGlobalTarget()
            const layersView = await buildLayerView(workspace.dir, global)
            const workspaceTarget = join(workspace.dir, FILE_NAME)

            // 明确给了 target ⇒ 以它为准（必须在链内，否则拒绝）；
            // 只给了 scope ⇒ 按旧语义回落，保证老调用方（通用设置行等）不退化。
            let editing
            if (typeof rawTarget === 'string' && rawTarget.trim() !== '') {
              const resolved = await resolveTargetPath(rawTarget, workspace.dir, global.dshHome)
              if (resolved.error) {
                writeJson(res, 403, { error: resolved.error })
                return
              }
              editing = resolved
            } else {
              editing = scope === 'global'
                ? { path: global.path, layer: 'user-global', displayPath: '<DSH_HOME>/AGENTS.md' }
                : { path: workspaceTarget, layer: 'project', displayPath: FILE_NAME }
            }

            const file = await readStateAt(editing.path)
            // 把「这一层此刻是启用还是暂停」附给编辑目标 —— 界面据此提示
            // 「已加载（这是已暂停的文件）」，而不是靠猜。
            const editingRow = layersView.filter((row) => samePath(row.path, editing.path))[0]
            if (editingRow) file.enabled = editingRow.enabled
            const budget = await buildBudget(layersView)
            writeJson(res, 200, {
              // `cwd` 语义已统一：**永远**是工作区目录（输入框当前值）。
              // 旧版在 scope=global 时会回传 dshHome，导致输入框显示被换掉，
              // 也让「同一个面板两条发现链」的 bug 有了生存空间。
              cwd: workspace.dir,
              editingTarget: editing.path,
              dshHome: global.dshHome,
              // 工作区目录恰好就是 dsh 配置目录时，全局那层与工作区那份是同一个文件 —— 界面据此就地说明。
              // ⚠️ 必须比 `activePath`（官方名所在路径），不能比 `global.path`：
              // 全局被暂停时 `global.path` 是 `.disabled`，与工作区目标不同名，这个判定就会**失效**，
              // 提示随之消失（实测过）。比 `activePath` 才能表达"是不是同一个文件位"。
              targetsCollide: samePath(global.activePath, workspaceTarget),
              pluginVersion: PLUGIN_VERSION,
              file,
              // 完整层清单（含已暂停的层）—— 界面上那份可点击的列表
              layersView,
              // 三选一模式的高亮依据，由磁盘现状反推
              mode: deriveMode(layersView),
              // 三种生效范围各自「会改动哪些层」—— 由 host 统一算，界面只负责显示。
              // 这样确认框里列的清单与真正执行的清单**必然**一致（曾各写一份规则，注定漂移）。
              modePlans: {
                both: pendingModeChanges('both', layersView),
                project: pendingModeChanges('project', layersView),
                global: pendingModeChanges('global', layersView),
              },
              budget,
              // 说明：这里**不再**回传 v0.3.x 的 cwdSource / defaultCwd / fileName /
              // sourceLimitBytes / workspaceDir / scope / activation。它们在新架构下
              // 要么可由 layersView 推导、要么从来没有任何消费方（tests/contract.test.mjs
              // 会逐字段核对"谁提供、谁消费"）。全局层的独立契约保留在
              // `/api/dsh-agent/activation` 那条兼容路由里，没有丢。
            })
          } catch (error) {
            writeJson(res, 500, { error: String(error?.message ?? 'unknown') })
          }
        },
      }),

      // 写入内容：工作区 = <dir>/AGENTS.md；全局 = 当前生效的那个名字（含 .disabled）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-agent/file',
        handler: async (req, res) => {
          if (req.method !== 'PUT' && req.method !== 'POST') {
            if (!guard(req, res, false)) return
            writeJson(res, 405, { error: 'method not allowed' })
            return
          }
          if (!guard(req, res, true)) return
          let payload
          try {
            payload = await readJsonBody(req, MAX_BODY_BYTES)
          } catch (error) {
            const tooLarge = error?.code === 'BODY_TOO_LARGE'
            writeJson(res, tooLarge ? 413 : 400, { error: error?.message ?? '请求体读取失败' })
            return
          }
          const scope = payload.scope === 'global' ? 'global' : 'workspace'
          if (typeof payload.content !== 'string') {
            writeJson(res, 400, { error: '缺少 content 字段' })
            return
          }
          if (Buffer.byteLength(payload.content, 'utf8') > MAX_SOURCE_BYTES) {
            writeJson(res, 413, {
              error: `内容超过官方单文件上限 ${MAX_SOURCE_BYTES} 字节 —— 超过该值的文件会被官方静默忽略`,
            })
            return
          }
          const workspace = resolveWorkspaceDir(payload.cwd)
          if (workspace.error) {
            writeJson(res, 400, { error: workspace.error })
            return
          }
          try {
            const global = await resolveGlobalTarget()
            // `target`（链内任意一层）优先；没有则按旧 `scope` 回落。
            // 两处都允许写 `.disabled` 文件 —— 这是刻意的：暂停态仍要能编辑内容，
            // 否则「先改好内容、再启用」这个正常流程就断了。
            let targetPath
            if (typeof payload.target === 'string' && payload.target.trim() !== '') {
              const resolved = await resolveTargetPath(payload.target, workspace.dir, global.dshHome)
              if (resolved.error) {
                writeJson(res, 403, { error: resolved.error })
                return
              }
              targetPath = resolved.path
            } else {
              targetPath = scope === 'global' ? global.path : join(workspace.dir, FILE_NAME)
            }
            // 乐观并发控制：调用方带上读取时的 mtime；不一致说明磁盘已被别的
            // 标签页/外部编辑器改过，此时拒绝写入并回传磁盘现状，避免静默覆盖。
            if (typeof payload.expectedMtime === 'string' || payload.expectedMtime === null) {
              const current = await probeFile(targetPath)
              const currentMtime = current.exists ? current.mtime : null
              if (currentMtime !== payload.expectedMtime) {
                writeJson(res, 409, {
                  error: 'conflict: 磁盘上的文件已被改动，未保存以免覆盖',
                  file: await readStateAt(targetPath),
                })
                return
              }
            }
            await writeAtomic(targetPath, payload.content)
            const nextGlobal = await resolveGlobalTarget()
            const layersView = await buildLayerView(workspace.dir, nextGlobal)
            const budget = await buildBudget(layersView)
            const file = await readStateAt(targetPath)
            // 与 `/state` 保持一致地把「这一层此刻是启用还是暂停」附上 ——
            // 否则保存一个 `.disabled` 文件之后，界面不会提示「这是已暂停的文件」。
            const savedRow = layersView.filter((row) => samePath(row.path, targetPath))[0]
            if (savedRow) file.enabled = savedRow.enabled
            ctx.logger?.info?.(`AGENTS.md 已保存（原子写）：${targetPath}`)
            writeJson(res, 200, {
              ok: true,
              file,
              budget,
              layersView,
              mode: deriveMode(layersView),
            })
          } catch (error) {
            const code = error?.code === 'ENOENT' ? 404 : 500
            writeJson(res, code, { error: String(error?.message ?? 'unknown') })
          }
        },
      }),

      // 全局层开关：改名，不改内容、不删文件
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-agent/activation',
        handler: async (req, res) => {
          if (req.method !== 'PUT' && req.method !== 'POST') {
            if (!guard(req, res, false)) return
            writeJson(res, 405, { error: 'method not allowed' })
            return
          }
          if (!guard(req, res, true)) return
          let payload
          try {
            payload = await readJsonBody(req, MAX_TOGGLE_BODY_BYTES)
          } catch (error) {
            const tooLarge = error?.code === 'BODY_TOO_LARGE'
            writeJson(res, tooLarge ? 413 : 400, { error: error?.message ?? '请求体读取失败' })
            return
          }
          if (typeof payload.globalEnabled !== 'boolean') {
            writeJson(res, 400, { error: '缺少 globalEnabled 布尔字段' })
            return
          }
          const workspace = resolveWorkspaceDir(payload.cwd)
          if (workspace.error) {
            writeJson(res, 400, { error: workspace.error })
            return
          }
          try {
            const before = await resolveGlobalTarget()
            if (payload.globalEnabled === before.paused) {
              // 要暂停、但压根没有可暂停的文件 ⇒ 明确报错，别静默"成功"
              //（否则界面会以为已经暂停，而实际上什么都没发生）。
              if (!payload.globalEnabled) {
                const source = await probeFile(before.activePath)
                if (!source.exists) {
                  writeJson(res, 404, { error: `找不到 ${before.activePath}，没有可暂停的全局文件` })
                  return
                }
              }
              // ⚠️ 与 `/layers` 共用同一套改名实现。这里曾自己写了一遍 rename，
              // 于是「切某一层」这件事有两份实现、两处会各自漂移 —— 现在只有一处。
              const result = await setLayerEnabled(before.activePath, payload.globalEnabled)
              if (result.changed) {
                ctx.logger?.info?.(
                  payload.globalEnabled
                    ? `全局 AGENTS.md 已启用：${result.path}`
                    : `全局 AGENTS.md 已暂停（文件保留）：${result.path}`,
                )
              }
            }
            const global = await resolveGlobalTarget()
            const budget = await buildBudget(await buildLayerView(workspace.dir, global))
            writeJson(res, 200, {
              ok: true,
              activation: {
                globalEnabled: !global.paused,
                activePath: global.activePath,
                pausedPath: global.pausedPath,
                editingPath: global.path,
              },
              budget,
            })
          } catch (error) {
            writeJson(res, 500, { error: `切换失败：${error?.message ?? 'unknown'}` })
          }
        },
      }),

      // 指令层开关（三种模式的唯一写入口）：批量把每一层「启用/暂停」= 改名，不改内容。
      //  - `{ mode: 'both' | 'project' | 'global' }` → 界面上的三选一模式按钮
      //  - `{ changes: [{ base, enabled }] }`        → 列表行上的单层开关
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-agent/layers',
        handler: async (req, res) => {
          if (req.method !== 'PUT' && req.method !== 'POST') {
            if (!guard(req, res, false)) return
            writeJson(res, 405, { error: 'method not allowed' })
            return
          }
          if (!guard(req, res, true)) return
          let payload
          try {
            payload = await readJsonBody(req, MAX_LAYERS_BODY_BYTES)
          } catch (error) {
            const tooLarge = error?.code === 'BODY_TOO_LARGE'
            writeJson(res, tooLarge ? 413 : 400, { error: error?.message ?? '请求体读取失败' })
            return
          }
          const workspace = resolveWorkspaceDir(payload.cwd)
          if (workspace.error) {
            writeJson(res, 400, { error: workspace.error })
            return
          }
          try {
            const global = await resolveGlobalTarget()

            let changes
            if (typeof payload.mode === 'string') {
              if (['both', 'project', 'global'].indexOf(payload.mode) < 0) {
                writeJson(res, 400, { error: 'mode 必须是 both | project | global' })
                return
              }
              changes = planModeChanges(payload.mode, await buildLayerView(workspace.dir, global))
            } else if (Array.isArray(payload.changes)) {
              changes = payload.changes
            } else {
              writeJson(res, 400, { error: '缺少 mode 或 changes 字段' })
              return
            }
            if (changes.length > 64) {
              writeJson(res, 400, { error: '一次最多修改 64 层' })
              return
            }

            // ⚠️ 逐项过白名单。`base` 必须是**官方候选名位置**（不含 .disabled 形态）——
            // `.disabled` 由 base 推导，不接受外部直接指定，避免绕过「只能改候选名」的约束。
            const allowed = await buildAllowedTargets(workspace.dir, global.dshHome)
            const applied = []
            for (const change of changes) {
              if (!change || typeof change.base !== 'string' || typeof change.enabled !== 'boolean') {
                writeJson(res, 400, { error: 'changes 每一项都需要 base(字符串) + enabled(布尔)' })
                return
              }
              const base = resolve(change.base)
              const hit = allowed.get(pathKey(base))
              if (!hit || hit.pausedVariant) {
                writeJson(res, 403, { error: `拒绝：${base} 不是当前指令链内的候选位置` })
                return
              }
              const result = await setLayerEnabled(base, change.enabled)
              applied.push({ base, enabled: change.enabled, path: result.path, changed: result.changed })
            }

            const nextGlobal = await resolveGlobalTarget()
            const layersView = await buildLayerView(workspace.dir, nextGlobal)
            const changedCount = applied.filter((item) => item.changed).length
            if (changedCount > 0) ctx.logger?.info?.(`指令层开关已应用：${changedCount} 个文件改名`)
            writeJson(res, 200, {
              ok: true,
              applied,
              layersView,
              mode: deriveMode(layersView),
              budget: await buildBudget(layersView),
            })
          } catch (error) {
            writeJson(res, 500, { error: `切换失败：${error?.message ?? 'unknown'}` })
          }
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* 卸载阶段的异常不应影响其他路由 */
        }
      }
    }
  })
}
