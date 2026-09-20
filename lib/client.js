/**
 * dsh-agent · 浏览器侧
 *
 * 形态：closure-factory 产物，由 dsh 的 `__ModuleLoader__` 加载。
 * 实现：**React + 官方 `ui-primitives` 控件**（用 `React.createElement`，不用 JSX ⇒ 仍然零构建链）。
 *
 * 两个入口共用**同一份组件树**（`AgentApp`）：
 *   1. 设置页独立页 —— 注册进官方 `settings.section`（设置导航里有自己的一项）
 *   2. 右下角浮动按钮 —— 打开模态外壳，内嵌同一个组件
 *
 * 与官方源码的一致性（均已实测）：
 *   - `ctx.slots.register(options, component)` **只有两个参数**；slot 名未被父节点声明时会 throw
 *     ⇒ 注册必须包 try/catch，并有回退入口（否则入口消失就是功能退化）。
 *   - `require('react')` / `require('react-dom/client')` / `require('@deepseek-ai/dsh-client-ui-primitives')`
 *     都能直接解析（共享静态表），**无需在 package.json 里声明**。
 *   - `exports.inject` 是 **cordis 服务注入表**：用 `ctx.slots` 就必须声明 `'slots'`。
 *   - `Switch` 的 `label` 只作 `aria-label`，不渲染可见文字。
 *   - `Tooltip` 的 children 必须是能接 ref 的元素 ⇒ 只包原生元素（官方 Button 先套一层 span）。
 *
 * 失败策略：任何一段出问题都只降级对应入口，绝不影响 dsh 界面本身。
 */
window.__ModuleLoader__.load({
  // ⚠️ 这个 id **必须与 package.json 的 name 完全一致** —— 它是 dsh 客户端模块表的键。
  // 改名时漏改这里，启动会报 `duplicate factory registration` 并导致整个插件加载失败（实测踩过）。
  id: 'dsh-agent-instructions',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 注意：**不能**做「已加载就 early return」那种防重。HMR 重载时 factory 会被再次调用，
    // early return 会返回没有 apply 的对象，触发「预期是一个带有 apply 方法的函数或对象」。
    // 重复挂载由 cordis 的 ctx.effect 生命周期负责。

    const API_STATE = '/api/dsh-agent/state'
    const API_FILE = '/api/dsh-agent/file'
    const API_LAYERS = '/api/dsh-agent/layers'
    /** 与 Host 侧 `GUARD_HEADER` 对应：跨站 no-cors 无法设置自定义头。 */
    const GUARD_HEADER = 'x-dsh-agent'
    /**
     * 与 Host 侧 `LANG_HEADER` 对应：把**当前界面语言**告诉 Host。
     *
     * Host 的面向用户文案（`planeNote`、错误信息）是当**数据**发过来原样渲染的，
     * 不带这个头它就只能猜 —— 猜错就是「英文界面里冒出一行中文」。
     */
    const LANG_HEADER = 'x-dsh-lang'
    const FAB_ID = 'dsh-agent-fab'
    const MODAL_HOST_ID = 'dsh-agent-modal-host'
    const STYLE_ID = 'dsh-agent-style'
    const LS_CWD = 'dsh-agent:cwd'
    const LS_TARGET = 'dsh-agent:target'
    const NS = 'dsh-agent-instructions'
    /** 界面侧构建标记：改本文件必须提升（Host 的 PLUGIN_VERSION 反映不了界面侧是否更新）。 */
    const CLIENT_BUILD = 'ui-2026-09-21z5'
    const POLL_MS = 10000

    /* ------------------------------------------------------------------ i18n */

    const MESSAGES = {
      zh: {
        title: 'Agent 身份与指令',
        subtitle: '编辑 AGENTS.md · 看哪些文件会生效',
        openPanel: '打开面板',
        reload: '重新读取',
        reloadHint: '从磁盘重新载入；有未保存的改动会先确认',
        copyPath: '复制路径',
        copyHint: '复制当前编辑目标的完整路径',
        copied: '路径已复制',
        copyFailed: '复制失败',
        close: '关闭',
        workspace: '工作区',
        modeTitle: '生效范围',
        modeBoth: '工作区 + 全局',
        modeProject: '仅工作区',
        modeGlobal: '仅全局',
        modeCustom: '自定义',
        listHint: '点一行就能编辑那一份',
        editingBadge: '正在编辑',
        editTargetTitle: '正在编辑',
        rowMissing: '还没有这个文件 · 保存后创建',
        switchLayerTitle: (name) => `切换「${name}」`,
        // ⚠️ 这两条曾**整对写反**（实测坐实：切「仅全局」时提示说"全局那份会改名"，
        // 而实际被改名的是工作区那份）。归属记牢：
        //   project =「仅工作区」= 停全局，只留工作区生效
        //   global  =「仅全局」  = 停工作区，只留全局生效
        modeConfirmProject: '全局那一份会改名为 .disabled（内容保留、不删除），只剩工作区里的生效。',
        modeConfirmGlobal: '工作区里的文件会改名为 .disabled（内容保留、不删除），只剩全局那一份生效。',
        modeConfirmBoth: '所有被暂停的文件都会改回官方名，全部一起生效。',
        modeRecoverHint: '随时点「工作区 + 全局」就能全部恢复。',
        modeAlready: (name) => `当前已经是「${name}」了`,
        modeConfirmLabel: '切换',
        modeChanged: '生效范围已改',
        workspacePlaceholder: '工作区绝对路径（留空 = dsh 默认工作区）',
        pickDir: '选择文件夹…',
        pickDirTitle: '打开系统文件夹选择器',
        pickFailed: '选择文件夹失败',
        save: '保存',
        revert: '放弃改动',
        dirty: '有未保存的改动',
        clean: '与磁盘内容一致',
        loading: '读取中…',
        saving: '保存中…',
        saved: '已保存',
        loaded: '已加载',
        loadedPaused: '已加载（这是已暂停的文件 · 启用后才会生效）',
        loadFailed: '读取失败',
        saveFailed: '保存失败',
        conflict: '保存冲突：磁盘上的文件已被改动，本次未写入。再点一次保存将覆盖磁盘版本',
        diskChanged: '磁盘上的文件已被外部改动，点「重新读取」查看最新内容',
        created: '尚不存在 · 保存后创建',
        lastModified: '上次修改',
        orderTitle: '会读取哪些文件',
        layerGlobal: '全局文件',
        layerGlobalNote: '每个工作区都会读它',
        layerProject: '工作区文件',
        layerProjectRootNote: '只在这个工作区里读它',
        layerProjectNestedNote: '只在这个子文件夹里读它',
        layerLocal: '个性化规则',
        // 「可叠加」是这层的**卖点**，括号里补两个限定：作用范围 + 唯一不可用的模式。
        // 用户定的措辞，照搬。
        layerLocalNote: '可叠加（仅本工作区，且仅全局不可用）',
        rowMissingLocal: '未创建',
        layerIgnoredNote: '超过 1 MB，不会被读取',
        layerOmittedFirstNote: '太长，会先被丢掉',
        layerOmittedNote: '太长，会被丢掉',
        // 注：「同目录内容去重」不再有提示文案 —— 见 layerHealth 里的说明。
        // `row.duplicate` 字段仍在（预算统计要用），但用户侧不需要知道它发生了什么。
        pausedRowNote: '已暂停，不会生效',
        totalPrefix: '合计',
        draftPrefix: '草稿',
        totalFromDisk: '（磁盘上的内容 · 未含未保存改动）',
        allEffective: (n) => `${n} 个文件都会生效`,
        noneEffective: '现在没有任何文件会生效',
        singleEffective: '只有这 1 个文件会生效',
        notAllEffective: '有些文件不会生效（见下方）',
        layerTruncatedNote: '太长，会被截断',
        diagTitle: '需要注意',
        diagPresetTitle: (id) => `当前模式 preset「${id}」不读取这些文件`,
        diagPresetBody: '跟文件内容无关 —— 换一个 preset 才会生效。',
        diagIgnoredTitle: (n, limit) => `${n} 个文件超过 ${limit} 字节，不会被读取`,
        diagIgnoredBody: '它们会被完全跳过，也不会报错：',
        diagOverTitle: (total, limit) => `内容太长：${total} 字节，超过上限 ${limit}`,
        diagOverBody: '太长时会先丢掉全局文件，尽量保住工作区里的。',
        diagOverOmit: '会被丢掉的是',
        diagOverFix: '可以：删掉一些内容 · 暂停全局文件 · 或者调高上限。',
        diagPausedTitle: '全局文件已暂停',
        diagPausedBody: '它被改名为 .disabled（内容没丢），dsh 找不到它，所以不会生效：',
        onlyOneFileNote: '工作区就是 dsh 配置目录 —— 这里只有一份 AGENTS.md，所以「工作区 + 全局」和「仅全局」是同一个结果',
        howTitle: '它是怎么生效的？',
        howEditTarget: '「生效范围」决定哪些文件会被用上；下面点哪一行，就在编辑器里改那一份 —— 改哪份和用哪份是同一件事。',
        how1: '这些文件会全部一起读，不是只读一个；如果全局和工作区都写了，以工作区里的为准（但不会覆盖系统提示和你的直接指令）。',
        how2: '文件要放在工作区目录里（从有 .git 的那层往下）才会被读到；同一个文件夹里有多份时只取一份，AGENTS.md 优先于 CLAUDE.md。',
        how3: '只认 4 个文件名：AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md —— 所以「暂停」就是把名字加个 .disabled，改回名就恢复。',
        howLocal: '只给自己的规则用「个性化规则」（AGENTS.local.md）：叠加在 AGENTS.md 之上，只对这个工作区生效。要给所有工作区加规则，用上面的全局文件。',
        how4: '改完立刻生效，不用重启；但内容太长时，会先丢掉全局文件。',
        globalEnabled: '全局已启用',
        globalPaused: '全局已暂停',
        budgetLabel: '指令预算',
        budgetUnavailable: '当前 preset 不加载指令文件，预算不适用',
        bytesUnit: '字节',
        linesUnit: '行',
        unsavedTitle: '有未保存的改动',
        reloadConfirmBody: '从磁盘重新读取会丢弃这些改动。',
        discardReload: '丢弃并重新读取',
        switchConfirmBody: (name) => `切换到「${name}」会丢弃这些改动。`,
        closeConfirmBody: '直接关闭会丢弃这些改动。',
        discardSwitch: '丢弃并切换',
        discardClose: '丢弃并关闭',
        revertConfirmBody: '编辑器里的内容会全部丢失，且无法撤销。',
        discardRevert: '丢弃改动',
        cancel: '取消',
        enableLayerTitle: (name) => `启用「${name}」`,
        pauseLayerTitle: (name) => `暂停「${name}」`,
        enableBody1: '把文件改回官方名，内容不变：',
        pauseBody1: '把文件改名，内容完整保留、不删除：',
        enableBody2: '官方在每一步请求前都会重新读取，改完即对之后的请求生效。',
        pauseBody2: '改名后官方探测不到它，因而不会导入对话。',
        enable: '启用',
        pause: '暂停',
        enabledToast: '已启用 · 对之后的请求即时生效',
        pausedToast: '已暂停（文件保留）· 对之后的请求即时生效',
        switchFailed: '切换失败',
        tooLarge: '超过官方单文件上限，官方会完全忽略该文件',
        overBudget: '内容太长：会被截断，也可能整份被丢掉',
        placeholder: (name) => `在此撰写 ${name} …\n\n## 身份\n你是……，称我为……\n\n## 工作规范\n- 提交前先 typecheck\n- 改代码必同步改文档`,
        // 个性化层是**额外的补充**，不是又一份"身份 + 工作规范"⇒ 预设换成补充规则的语气。
        // 复用主模板会诱导用户把 AGENTS.md 的内容抄一遍，反而稀释了它"叠加"的意义。
        placeholderLocal: (name) => `在此撰写 ${name} …\n\n## 我的偏好\n- 称呼我……\n- 用中文回答，技术名词保留英文\n\n## 补充约定\n- 动手前先说明方案\n- 提交前先 typecheck`,
      },
      en: {
        title: 'Agent identity & instructions',
        subtitle: 'Edit AGENTS.md · see which files apply',
        openPanel: 'Open panel',
        reload: 'Reload',
        reloadHint: 'Reload from disk; unsaved edits are confirmed first',
        copyPath: 'Copy path',
        copyHint: 'Copy the full path of the file being edited',
        copied: 'Path copied',
        copyFailed: 'Copy failed',
        close: 'Close',
        workspace: 'Workspace',
        modeTitle: 'Applies to',
        modeBoth: 'Workspace + global',
        modeProject: 'Workspace only',
        modeGlobal: 'Global only',
        modeCustom: 'Custom',
        listHint: 'Click a row to edit that one',
        editingBadge: 'editing',
        editTargetTitle: 'Editing',
        rowMissing: 'Not created yet · saving creates it',
        switchLayerTitle: (name) => `Toggle "${name}"`,
        // Both lines were once swapped as a pair (caught by an actual run: picking "Global only"
        // said the global file would be renamed, while the workspace one was renamed in reality).
        modeConfirmProject: 'The global file is renamed to .disabled (content kept, nothing deleted), leaving only the workspace ones active.',
        modeConfirmGlobal: 'The workspace files are renamed to .disabled (content kept, nothing deleted), leaving only the global one active.',
        modeConfirmBoth: 'Every paused file is renamed back and all of them apply together.',
        modeRecoverHint: 'Pick "Workspace + global" any time to restore everything.',
        modeAlready: (name) => `Already on "${name}"`,
        modeConfirmLabel: 'Switch',
        modeChanged: 'Scope changed',
        workspacePlaceholder: 'Absolute workspace path (blank = dsh default)',
        pickDir: 'Choose folder…',
        pickDirTitle: 'Open the system folder picker',
        pickFailed: 'Folder picker failed',
        save: 'Save',
        revert: 'Discard',
        dirty: 'Unsaved changes',
        clean: 'Matches disk',
        loading: 'Loading…',
        saving: 'Saving…',
        saved: 'Saved',
        loaded: 'Loaded',
        loadedPaused: 'Loaded (paused file · applies once enabled)',
        loadFailed: 'Load failed',
        saveFailed: 'Save failed',
        conflict: 'Save conflict: the file changed on disk, nothing was written. Save again to overwrite.',
        diskChanged: 'The file changed on disk. Click Reload to see the latest content.',
        created: 'Not created yet · saving creates it',
        lastModified: 'Modified',
        orderTitle: 'Which files are read',
        layerGlobal: 'Global file',
        layerGlobalNote: 'read by every workspace',
        layerProject: 'Workspace file',
        layerProjectRootNote: 'read by this workspace only',
        layerProjectNestedNote: 'read by this subfolder only',
        layerLocal: 'Personal rules',
        layerLocalNote: 'stacks on top (this workspace only; unavailable in "Global only")',
        rowMissingLocal: 'not created yet',
        layerIgnoredNote: 'over 1 MB — not read',
        layerOmittedFirstNote: 'too long — dropped first',
        layerOmittedNote: 'too long — dropped',
        // See layerHealth: the same-directory content dedup no longer surfaces any copy.
        pausedRowNote: 'paused — not applied',
        totalPrefix: 'Total',
        draftPrefix: 'draft',
        totalFromDisk: '(on disk · unsaved edits excluded)',
        allEffective: (n) => `all ${n} files apply`,
        noneEffective: 'no file applies right now',
        singleEffective: 'only this file applies',
        notAllEffective: 'some files do not apply (see below)',
        layerTruncatedNote: 'too long — truncated',
        diagTitle: 'Heads-up',
        diagPresetTitle: (id) => `The current preset "${id}" does not read these files`,
        diagPresetBody: 'Nothing to do with their content — switch to a preset that does.',
        diagIgnoredTitle: (n, limit) => `${n} file(s) exceed ${limit} bytes and are not read`,
        diagIgnoredBody: 'They are skipped entirely, without an error:',
        diagOverTitle: (total, limit) => `Too long: ${total} bytes, over the ${limit} limit`,
        diagOverBody: 'When it is too long the global file is dropped first, keeping the workspace ones.',
        diagOverOmit: 'dropped:',
        diagOverFix: 'You can: trim the content · pause the global file · or raise the limit.',
        diagPausedTitle: 'The global file is paused',
        diagPausedBody: 'It was renamed to .disabled (content kept), so dsh cannot find it:',
        onlyOneFileNote: 'The workspace is the dsh home — there is only one AGENTS.md here, so "Workspace + global" and "Global only" have the same result',
        howTitle: 'How does this apply?',
        howEditTarget: 'The "Applies to" choice decides which files are used; click a row below and you edit that same one — editing and applying are the same thing here.',
        how1: 'All of these files are read together, not just one; when both global and workspace are set, the workspace one wins (it never overrides system prompts or your direct instructions).',
        how2: 'A file must sit inside the workspace folder (from the level with .git downwards) to be read; only one file per folder is used, AGENTS.md before CLAUDE.md.',
        how3: 'Only 4 file names are recognised: AGENTS.md, CLAUDE.md, AGENTS.local.md, CLAUDE.local.md — so "pausing" just appends .disabled, and renaming back restores it.',
        howLocal: 'For rules only you need, use "Personal rules" (AGENTS.local.md): it layers on top of AGENTS.md and applies to this workspace only. For rules that apply to every workspace, use the global file above.',
        how4: 'Edits apply immediately, no restart; but when the content is too long, the global file is dropped first.',
        globalEnabled: 'Global enabled',
        globalPaused: 'Global paused',
        budgetLabel: 'Instruction budget',
        budgetUnavailable: 'The active preset does not load instruction files',
        bytesUnit: 'B',
        linesUnit: 'lines',
        unsavedTitle: 'Unsaved changes',
        reloadConfirmBody: 'Reloading from disk discards them.',
        discardReload: 'Discard and reload',
        switchConfirmBody: (name) => `Switching to "${name}" discards them.`,
        closeConfirmBody: 'Closing discards them.',
        discardSwitch: 'Discard and switch',
        discardClose: 'Discard and close',
        revertConfirmBody: 'Everything in the editor will be lost — there is no undo.',
        discardRevert: 'Discard changes',
        cancel: 'Cancel',
        enableLayerTitle: (name) => `Enable "${name}"`,
        pauseLayerTitle: (name) => `Pause "${name}"`,
        enableBody1: 'Renames the file back. Content unchanged:',
        pauseBody1: 'Renames the file. Content fully preserved, nothing deleted:',
        enableBody2: 'dsh re-reads before every step, so this applies to the next request.',
        pauseBody2: 'dsh can no longer find it, so it is not injected.',
        enable: 'Enable',
        pause: 'Pause',
        enabledToast: 'Enabled · applies to the next request',
        pausedToast: 'Paused (file kept) · applies to the next request',
        switchFailed: 'Switch failed',
        tooLarge: 'Exceeds the official single-file limit; dsh ignores this file entirely',
        overBudget: 'Too long: it gets truncated, or dropped entirely',
        placeholder: (name) => `Write ${name} here …\n\n## Identity\nYou are …, call me …\n\n## Rules\n- typecheck before commit\n- keep docs in sync`,
        placeholderLocal: (name) => `Write ${name} here …\n\n## My preferences\n- Call me …\n- Answer in English, keep technical terms as-is\n\n## Extra conventions\n- Explain the plan before changing anything\n- typecheck before commit`,
      },
    }

    /**
     * 官方 `locale` 服务的引用（可选）。在 `apply()` 里探测赋值。
     *
     * ⚠️ **不要把它写进 `inject`** —— 某些组合里没有该服务，硬依赖会让整个插件不加载。
     * 只做「探测得到就用、探测不到就跳过」。
     */
    let localeService = null

    /** 把任意 BCP 47 标签归一成 `zh` / `en`；空值返回空串（表示「没给信号」）。 */
    function normalizeLang(tag) {
      const value = String(tag || '').trim().toLowerCase()
      if (!value) return ''
      return value.startsWith('en') ? 'en' : 'zh'
    }

    /**
     * 当前语言。**权威源是官方 `locale` 服务，不是 `<html lang>`。**
     *
     * ⚠️ 为什么不能只认 `<html lang>`：dsh 服务端出的 HTML **写死** `lang="en"`
     * （`apps/web/index.html`），要等 locale 插件激活后才异步改写成 `zh-CN`
     * （`locale/src/client/index.ts` 的 `syncDocumentLanguage`）。在那之前读必然拿到 `en`；
     * 而观察器若又在写入**之后**才挂上，那一次变化就永远收不到 —— 界面**永久停在英文**，
     * 且没有任何自愈通道。（官方 e2e 自己都注明 markup already ships en, so this
     * alone cannot prove the sync ran。）
     *
     * 顺序：官方 locale 服务 → `<html lang>` → `navigator.language`。
     * 必须**每次现读**，不能在初始化时抓一次。
     */
    function currentLang() {
      try {
        const snapshot = localeService && typeof localeService.getSnapshot === 'function'
          ? localeService.getSnapshot()
          : null
        const fromService = normalizeLang(snapshot && snapshot.active)
        if (fromService) return fromService
        const fromDoc = normalizeLang(document.documentElement.lang)
        if (fromDoc) return fromDoc
        const fromNav = normalizeLang(navigator.language)
        if (fromNav) return fromNav
        return 'zh'
      } catch {
        return 'zh'
      }
    }

    let lang = currentLang()

    /**
     * 取文案。
     *
     * ⚠️ **参数是可变的** —— 带占位的文案按顺序多传：
     * `t('diagOverTitle', total, limit)`。**不能只接收一个参数**，
     * 否则第二个占位会渲染成 `undefined`（实测踩过，静态检查抓不到）。
     */
    function t(key) {
      const args = Array.prototype.slice.call(arguments, 1)
      const dict = MESSAGES[currentLang()] || MESSAGES.zh
      const value = dict[key] !== undefined ? dict[key] : MESSAGES.zh[key]
      return typeof value === 'function' ? value.apply(null, args) : value
    }

    /**
     * 监听 `<html lang>` 变化。
     * 官方 `settings.section` 契约要求注册方**在语言变化时用新文案重新注册**
     * （ledger 变动同时充当设置外壳的重渲染触发器）。
     */
    function watchLang(onChange) {
      try {
        // **只报「有可能变了」**，是否真的换语言交给 onLangSourceChanged 统一判定 ——
        // 两个来源各判一次会导致行为不一致（一个改了 lang 另一个没跟）。
        const observer = new MutationObserver(() => onChange())
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        return () => observer.disconnect()
      } catch {
        return () => {}
      }
    }

    /**
     * 语言来源变化的**唯一漏斗**：只有解析出来的语言真的变了才刷新。
     * 官方 `settings.section` 契约要求注册方**在语言变化时用新文案重新注册**
     * （ledger 变动同时充当设置外壳的重渲染触发器）。
     */
    function onLangSourceChanged(ctx) {
      const next = currentLang()
      if (next === lang) return
      lang = next
      setFabLabel(document.getElementById(FAB_ID))
      try {
        registerSettingsSection(ctx)
      } catch (error) {
        console.warn('[dsh-agent] 语言切换后重新注册失败：', error)
      }
    }

    /* ------------------------------------------------------------- 依赖与工具 */

    let React = null
    let ReactDOMClient = null
    let P = {}

    /** 官方目录选择器服务（可选）：取不到就是 null，界面不渲染「选择…」按钮。 */
    let pickDirectory = null

    /**
     * `React.createElement` 的简写。
     * ⚠️ 必须是**函数声明**而非箭头函数 —— 要用 `arguments` 收可变子节点，
     * 而箭头函数没有自己的 `arguments`（`node --check` 抓不到这种错，只在运行时炸）。
     */
    function e(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    /** 加载官方依赖。任何一项拿不到只降级对应功能，不抛。 */
    function loadVendors() {
      if (React) return true
      React = require('react')
      try {
        ReactDOMClient = require('react-dom/client')
      } catch {
        ReactDOMClient = null
      }
      try {
        P = require('@deepseek-ai/dsh-client-ui-primitives') || {}
      } catch {
        P = {}
      }
      return true
    }

    async function readJson(response) {
      let payload = null
      try {
        payload = await response.json()
      } catch {
        /* 保留 null */
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
        throw new Error(message)
      }
      return payload
    }

    /**
     * 带护栏头的 fetch。
     *
     * Host 侧要求 `x-dsh-agent: 1`；同时带上当前语言，让 Host 的**面向用户文案**
     * （`planeNote`、错误信息）跟着界面语言走 —— 否则切到英文界面时它们仍是中文。
     */
    function apiFetch(path, options) {
      const init = options || {}
      const headers = Object.assign(
        { [GUARD_HEADER]: '1', [LANG_HEADER]: currentLang() },
        init.headers || {},
      )
      return fetch(path, Object.assign({}, init, { headers }))
    }

    function formatInt(n) {
      return (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US')
    }

    /** 优先用官方 `relativeTime`，取不到则用绝对时间。 */
    function timeText(iso) {
      if (!iso) return '—'
      try {
        if (typeof P.relativeTime === 'function') {
          const value = P.relativeTime(iso)
          if (typeof value === 'string' && value) return value
        }
      } catch {
        /* 回落 */
      }
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (v) => String(v).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function countLines(text) {
      if (!text) return 1
      return text.split('\n').length
    }

    /**
     * 从绝对路径取文件名。
     * 文案里需要"指名道姓"说清在讲哪个文件 —— 现在链上可能有 AGENTS.md / CLAUDE.md /
     * AGENTS.local.md（个性化）等多个候选，写死 "AGENTS.md" 就会指错。
     */
    function fileNameOf(file) {
      const parts = String(file || '').split(/[\\/]/)
      return parts[parts.length - 1] || 'AGENTS.md'
    }

    /**
     * 取「用户认知里的文件名」—— 剥掉暂停用的 `.disabled` 后缀。
     *
     * 暂停是靠**改名**实现的（内部机制），它不该出现在对用户说话的地方：
     * 实测截图里出现过「在此撰写 AGENTS.local.md.disabled …」—— 用户想的是
     * "我在写个性化规则"，而不是"我在写一个 .disabled 文件"。
     * 注意只用于**文案**；「正在编辑」那里的路径仍显示真实文件名（便于定位/复制）。
     */
    function baseNameOf(file) {
      const name = fileNameOf(file)
      const suffix = '.disabled'
      return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name
    }

    /**
     * 两个绝对路径是否指向同一个文件。
     * 两侧都来自**同一个 host 进程**的同一套 `join`，大小写与分隔符必然一致，
     * 所以严格比较即可（不需要再做平台相关的大小写折叠）。
     */
    function sameDiskPath(a, b) {
      return typeof a === 'string' && typeof b === 'string' && a !== '' && a === b
    }

    function byteLength(text) {
      try {
        return new TextEncoder().encode(text).length
      } catch {
        return text.length
      }
    }

    function readStore(key, fallback) {
      try {
        const value = window.localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function writeStore(key, value) {
      try {
        window.localStorage.setItem(key, String(value))
      } catch {
        /* 忽略存储失败 */
      }
    }

    async function copyText(text) {
      try {
        if (typeof P.writeClipboard === 'function') {
          await P.writeClipboard(text)
          return true
        }
      } catch {
        /* 回落 */
      }
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------------ 样式 */

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const css = `
/* 默认**实心显示**（不透明、边框清楚）；只有与聊天输入区冲突时才淡出。
   透明度调过两轮：一度做成 50% 半透明，结果用户反馈"太透明，看不清" ——
   既然"会不会挡住"已经交给几何判定处理了，平时就不需要靠半透明去降存在感，
   直接给足对比度，让人一眼能找到它。 */
.dsh-agent-fab{position:fixed;right:16px;bottom:16px;z-index:2147482000;display:flex;align-items:center;justify-content:center;
  width:34px;height:34px;padding:0;border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));border-radius:50%;
  background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);
  cursor:pointer;box-shadow:var(--dsw-elevation-panel,0 6px 24px rgba(0,0,0,.16));
  transition:transform .16s ease,background .12s ease,opacity .18s ease}
/* 与输入区重叠时淡出，并且**不拦任何点击** —— 否则它看不见却仍会吃掉发送按钮的点击 */
.dsh-agent-fab[data-hidden="true"]{opacity:0;pointer-events:none}
.dsh-agent-fab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));transform:translateY(-1px)}
.dsh-agent-fab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dsh-agent-fab svg{flex:none}

.dsh-agent-modal-mask{position:fixed;inset:0;z-index:2147482001;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.28));
  display:flex;align-items:center;justify-content:center;padding:32px}
.dsh-agent-modal-card{display:flex;flex-direction:column;width:min(840px,100%);height:min(660px,100%);min-height:0;
  overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:14px;
  background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);
  box-shadow:var(--dsw-elevation-prominent,0 18px 56px rgba(0,0,0,.22))}

.dsh-agent-app{display:flex;flex-direction:column;gap:14px;min-height:0;
  color:var(--dsw-alias-label-primary,#1a1a1a);
  font:400 var(--dsh-content-font-size,14px)/1.5 var(--font-sans,-apple-system,"Segoe UI",sans-serif)}
/* 页面变体也做成「有界高度 + 内层滚动」—— 吸底页脚需要稳定的滚动容器。
   直接让 app 当普通流容器时 sticky 的约束块是 app 自己 ⇒ 页脚会漂到编辑器中间（v0.9.1 踩过）。 */
.dsh-agent-app[data-variant="page"]{padding:4px 0 0;max-width:840px;
  height:100%;min-height:0;overflow-y:auto;overflow-x:hidden}
.dsh-agent-app[data-variant="page"] .dsh-agent-editor{min-height:140px}
.dsh-agent-app[data-variant="page"] .dsh-agent-foot{position:sticky;bottom:0;z-index:2;
  padding:8px 0 10px;background:var(--dsw-alias-bg-layer-2,#fff);
  border-top:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.dsh-agent-app[data-variant="modal"]{padding:18px 20px 16px;flex:1;min-height:0;gap:12px;
  overflow-y:auto;overflow-x:hidden}

/* head 允许换行：窄屏时右侧动作按钮换到下一行，标题才拿得到整行宽度 ——
   否则标题会被压成省略号「…」（480px 实测）。宽屏一行放得下，不受影响。 */
.dsh-agent-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-agent-head-text{flex:1 1 170px;min-width:0}
/* 标题与副标题**恒为单行**：空间不足时宁可截断，也不要逐字竖排 ——
   480px 实测会被挤成一列单字（overflow-wrap:anywhere 是元凶）。 */
.dsh-agent-h1{font-weight:500;font-size:15px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-agent-sub{color:var(--dsw-alias-label-caption,#8a8a8a);font-size:12px;margin-top:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-agent-head-actions{display:flex;align-items:center;gap:8px;flex:none}

.dsh-agent-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dsh-agent-label{color:var(--dsw-alias-label-caption,#8a8a8a);font-size:12px;flex:none;min-width:56px;white-space:nowrap}
.dsh-agent-note{flex:1 1 auto;min-width:0;font-size:11.5px;line-height:1.6;
  color:var(--dsw-alias-label-caption,#8a8a8a);overflow-wrap:anywhere}
.dsh-agent-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#a15c00)}
.dsh-agent-note[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dsh-agent-stack{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-agent-btnwrap{display:inline-flex;flex:none}

.dsh-agent-bar{display:flex;height:8px;min-width:160px;flex:0 1 220px;border-radius:999px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));border:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dsh-agent-bar>i{display:block;height:100%;width:0;flex:0 0 auto;transition:width .18s ease}
.dsh-agent-bar>i[data-tone="global"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-agent-bar>i[data-tone="project"]{background:var(--dsw-alias-state-success-primary,#1a7f47)}
.dsh-agent-bar>i[data-tone="over"]{background:var(--dsw-alias-state-error-primary,#c0392b)}
.dsh-agent-bar[data-off="true"]{background:transparent;border-style:dashed}


.dsh-agent-editor{flex:1;min-height:200px;width:100%;resize:vertical;padding:12px 14px;border-radius:10px;
  border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));
  background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);
  font:400 13px/1.65 var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  tab-size:2;white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:auto;overflow-x:hidden}
.dsh-agent-editor:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-agent-editor::placeholder{color:var(--dsw-alias-label-tertiary,#b0b0b0)}

.dsh-agent-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-agent-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;
  color:var(--dsw-alias-label-caption,#8a8a8a);min-width:0}
/* 尺寸/行数标签：超限时把结论直接写在脸上
   （红 = 超过官方单文件上限、会被完全忽略；橙 = 超渲染预算、会被截断或整份丢掉） */
.dsh-agent-size[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#a15c00)}
.dsh-agent-size[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#c0392b);font-weight:500}
.dsh-agent-status{display:flex;align-items:center;gap:6px;font-size:12px;min-width:0}
.dsh-agent-spacer{flex:1 1 auto}

.dsh-agent-dialog-scrim{position:fixed;inset:0;z-index:2147482010;display:flex;align-items:center;justify-content:center;
  padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.28))}
.dsh-agent-dialog{display:flex;flex-direction:column;gap:12px;width:min(430px,100%);padding:16px;
  border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:12px;
  background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);
  box-shadow:var(--dsw-elevation-prominent,0 18px 56px rgba(0,0,0,.22))}
.dsh-agent-dialog-title{font-weight:500;font-size:14px;line-height:1.4}
.dsh-agent-dialog-body{display:flex;flex-direction:column;gap:5px}
.dsh-agent-dialog-line{font:400 12px/1.6 var(--font-mono,ui-monospace,Consolas,monospace);
  color:var(--dsw-alias-label-secondary,#5f5e5a);overflow-wrap:anywhere}
.dsh-agent-dialog-line[data-kind="text"]{font-family:var(--font-sans,-apple-system,"Segoe UI",sans-serif);font-size:12.5px}
.dsh-agent-dialog-actions{display:flex;justify-content:flex-end;gap:8px}

.dsh-agent-bot{display:inline-flex;align-items:center;margin-right:7px;color:var(--dsw-alias-label-secondary,#5f5e5a);vertical-align:-2px}

.dsh-agent-order-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsh-agent-order{display:flex;flex-direction:column;gap:2px;
  border:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:4px 10px}
.dsh-agent-order-row{display:flex;align-items:flex-start;flex-wrap:wrap;gap:4px 9px;padding:7px 0;min-width:0}
.dsh-agent-order-row+.dsh-agent-order-row{border-top:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.dsh-agent-order-index{flex:none;width:17px;height:17px;border-radius:50%;font-size:11px;margin-top:1px;
  display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#5f5e5a)}
/* flex-basis:140px：空间不足时**整块换到下一行**，而不是把路径压成一列单字（480px 实测）。
   配合 nowrap + ellipsis：宽屏完整显示，窄屏截断 —— 完整值仍由行上的 title 兜住。 */
.dsh-agent-order-text{flex:1 1 140px;min-width:0}
/* 主行 = 路径（等宽、主色、稍大）+ 可选徽章；「全局/工作区」分类与作用范围降到下面那行注解 */
.dsh-agent-order-main{display:flex;align-items:baseline;gap:7px;flex-wrap:nowrap;min-width:0;overflow:hidden}
.dsh-agent-order-path{font:400 12.5px/1.5 var(--font-mono,ui-monospace,Consolas,monospace);
  color:var(--dsw-alias-label-primary,#1a1a1a);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-agent-order-scope{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-caption,#8a8a8a);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 行的**状态说明**（已暂停 / 未创建 / 超长 / 会被省略…）—— 追加在「层语义行」下方，
   只在**非正常**时出现。语义行恒常、状态行按需，两者**互不覆盖**。 */
.dsh-agent-order-rule{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-caption,#8a8a8a);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.9}
.dsh-agent-order-rule[data-tone="warning"]{color:var(--dsw-alias-state-warn-primary,#a15c00)}
.dsh-agent-order-rule[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dsh-agent-order-row[data-health="warning"] .dsh-agent-order-scope{color:var(--dsw-alias-state-warn-primary,#a15c00)}
.dsh-agent-order-row[data-health="error"] .dsh-agent-order-scope{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dsh-agent-order-bytes{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#8a8a8a)}
.dsh-agent-order-dot{align-self:flex-start;margin-top:6px}
/* 每一行既是「这层生不生效」的展示，也是「点它就编辑它」的入口。
   左右各借 8px 内边距并等量收回外边距 —— 悬停/选中底色因此能撑成一块，
   而不会溢出 .dsh-agent-order 的 10px 内边距。 */
.dsh-agent-order-row{padding:7px 8px;margin:0 -8px;cursor:pointer;
  transition:background .12s ease,box-shadow .12s ease}
.dsh-agent-order-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dsh-agent-order-row[data-editing="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(77,107,254,.09));
  box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4d6bfe)}
/* 行是 role=button，键盘可达 ⇒ 必须给焦点环，否则 Tab 过去看不出在哪 */
.dsh-agent-order-row:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-agent-order-row[data-editing="true"]:focus-visible{
  box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4d6bfe),inset 0 0 0 1.5px var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-agent-order-hint{font-size:11.5px;color:var(--dsw-alias-label-caption,#8a8a8a)}
.dsh-agent-order-badge{padding:1px 6px;border-radius:999px;font-size:10.5px;font-weight:400;
  background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.dsh-agent-order-switch{flex:none;display:inline-flex;align-items:center}

.dsh-agent-editor-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;min-width:0}
.dsh-agent-editor-path{font:400 11.5px/1.5 var(--font-mono,ui-monospace,Consolas,monospace);
  color:var(--dsw-alias-label-secondary,#5f5e5a);overflow-wrap:anywhere;min-width:0}

.dsh-agent-diag{display:flex;flex-direction:column;gap:3px;padding:9px 12px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));border-left:3px solid var(--dsw-alias-state-warn-primary,#a15c00)}
.dsh-agent-diag[data-tone="err"]{border-left-color:var(--dsw-alias-state-error-primary,#c0392b)}
.dsh-agent-diag-title{font-size:12.5px;font-weight:500;overflow-wrap:break-word;line-break:strict}
.dsh-agent-diag[data-tone="err"] .dsh-agent-diag-title{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dsh-agent-diag-body{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5f5e5a);overflow-wrap:break-word;line-break:strict}

.dsh-agent-how{display:flex;flex-direction:column;gap:6px;font-size:11.5px;line-height:1.65;
  color:var(--dsw-alias-label-secondary,#5f5e5a)}

/* ⚠️ 我们自己的元素统一 border-box。
   实测教训：.dsh-agent-editor 是 width:100% + padding:12px 14px + 1px border，
   在默认的 content-box 下净增约 29px，把设置面板的内容列撑出横向滚动条。
   注意只作用于我们自己的类，不碰官方 ui-primitives 组件（它们可能依赖既有盒模型）。 */
.dsh-agent-app,.dsh-agent-editor,.dsh-agent-bar,.dsh-agent-diag,.dsh-agent-dialog,
.dsh-agent-dialog-scrim,.dsh-agent-how,.dsh-agent-modal-card,.dsh-agent-modal-mask,
.dsh-agent-order,.dsh-agent-order-index,.dsh-agent-order-row,.dsh-agent-editor-head,
.dsh-agent-fab,.dsh-agent-btnwrap{box-sizing:border-box}

/* 弹窗里编辑器最小高调小，避免把页脚挤出可视区（卡片是固定高 + overflow:hidden） */
.dsh-agent-app[data-variant="modal"] .dsh-agent-editor{min-height:140px}
/* 页脚吸底：滚动内容从它下面穿过，保存/放弃始终可见可点 */
/* 吸底**只在模态里**：模态卡片是固定高 + 内层滚动，sticky 有稳定的滚动容器。
   页面变体靠 dsh 外层滚动容器，sticky 的约束块是 app 自己 ⇒ 页脚会漂到编辑器中间（实测踩过）。 */
.dsh-agent-app[data-variant="modal"] .dsh-agent-foot{position:sticky;bottom:0;z-index:2;
  padding-top:8px;background:var(--dsw-alias-bg-layer-2,#fff)}
`
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-agent'
      style.textContent = css
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------ 官方控件适配 */

    /** 官方控件缺失时退回等价原生元素，保证任何环境都能渲染。 */
    function uiButton(props) {
      if (P.Button) return e(P.Button, props, props.children)
      return e('button', { type: 'button', onClick: props.onClick, disabled: props.disabled }, props.children)
    }

    function uiInput(props) {
      if (P.Input) return e(P.Input, props)
      return e('input', props)
    }

    function uiPill(props) {
      if (P.Pill) return e(P.Pill, props, props.children)
      return e('button', { type: 'button', onClick: props.onClick }, props.children)
    }

    function uiSwitch(props) {
      if (P.Switch) return e(P.Switch, props)
      return e('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        disabled: props.disabled,
        onClick: () => props.onChange(!props.checked),
      }, props.label)
    }

    function uiStateDot(props) {
      if (P.StateDot) return e(P.StateDot, props)
      return e('span', { 'aria-hidden': 'true' }, '•')
    }

    /**
     * Tooltip 的 children 必须能接 ref ⇒ 只包**原生元素**。
     * 包官方组件时先套一层 span（span 能接 ref），避免 ref 转发告警与错位。
     */
    function uiTooltip(label, child) {
      if (!P.Tooltip || !label) return child
      try {
        return e(P.Tooltip, { label, side: 'top' }, child)
      } catch {
        return child
      }
    }

    function wrapForTooltip(label, element) {
      return uiTooltip(label, e('span', { className: 'dsh-agent-btnwrap' }, element))
    }

    /* ------------------------------------------------------------------ 组件 */

    function ConfirmDialog(props) {
      const cardRef = React.useRef(null)
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            props.onDone(false)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            props.onDone(true)
          }
        }
        document.addEventListener('keydown', onKey, true)
        const timer = setTimeout(() => {
          const buttons = cardRef.current ? cardRef.current.querySelectorAll('button') : []
          const last = buttons[buttons.length - 1]
          if (last && last.focus) last.focus()
        }, 30)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          clearTimeout(timer)
        }
      }, [])

      const lines = (props.lines || []).filter((line) => line !== '').map((line, index) =>
        e('div', {
          key: index,
          className: 'dsh-agent-dialog-line',
          'data-kind': /[\\/]/.test(line) ? 'path' : 'text',
        }, line))

      return e('div', {
        className: 'dsh-agent-dialog-scrim',
        onClick: (event) => {
          if (event.target === event.currentTarget) props.onDone(false)
        },
      }, e('div', { className: 'dsh-agent-dialog', ref: cardRef }, [
        e('div', { key: 'title', className: 'dsh-agent-dialog-title' }, props.title),
        e('div', { key: 'body', className: 'dsh-agent-dialog-body' }, lines),
        e('div', { key: 'actions', className: 'dsh-agent-dialog-actions' }, [
          uiButton({ key: 'cancel', variant: 'outline', onClick: () => props.onDone(false), children: props.cancelLabel }),
          uiButton({ key: 'ok', variant: 'primary', onClick: () => props.onDone(true), children: props.confirmLabel }),
        ]),
      ]))
    }

    /**
     * 主界面。两个入口共用：
     * `onRequestClose` 是函数时渲染为模态（带关闭按钮），否则为设置页内嵌页。
     */
    function AgentApp(props) {
      const isModal = typeof props.onRequestClose === 'function'

      const [cwd, setCwd] = React.useState(readStore(LS_CWD, ''))
      /** 当前编辑目标的**绝对路径**（链内任意一层）；空串 = 让 host 用默认的「工作区 AGENTS.md」。 */
      const [target, setTarget] = React.useState(readStore(LS_TARGET, ''))
      /** 完整层清单（含已暂停的层）—— 列表的数据源，点行即编辑。 */
      const [layersView, setLayersView] = React.useState([])
      /** 当前生效范围：both | project | global | custom，由磁盘现状反推。 */
      const [mode, setMode] = React.useState('both')
      /** 三种生效范围各自「会改动哪些层」（host 算好回传）—— 确认框的清单直接用它，不再自己算。 */
      const [modePlans, setModePlans] = React.useState({})
      /**
       * 用户最近一次点选的生效范围。
       * 只在「工作区就是 dsh 配置目录」这个特例下使用：那时只有一份 AGENTS.md，
       * 「工作区 + 全局」与「仅全局」在物理上是同一个状态，host 只能反推出 `both` ——
       * 于是点「仅全局」会跳到「工作区 + 全局」上，看着像"没点动"。用这个记住意图。
       */
      const [chosenMode, setChosenMode] = React.useState('')
      const [dshHome, setDshHome] = React.useState(null)
      const [targetsCollide, setTargetsCollide] = React.useState(false)
      const [file, setFile] = React.useState(null)
      const [budget, setBudget] = React.useState(null)
      const [pluginVersion, setPluginVersion] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [dirty, setDirty] = React.useState(false)
      const [bytes, setBytes] = React.useState(0)
      /**
       * 行数必须**显式记账**，不能在渲染时读 `editorRef.current.value`。
       * 踩过的坑：textarea 是**非受控**的，它的值由 `useEffect` 在**渲染之后**才推进，
       * 所以「切换到另一个工作区」的那一帧读到的是上一个文件的内容 —— 界面上出现过
       * 「打开一个 2 行的文件，页脚却写着 180 行」，而且之后没有重渲染来纠正它。
       */
      const [lineCount, setLineCount] = React.useState(1)
      const [status, setStatus] = React.useState({ text: t('loading'), tone: 'idle' })
      const [toast, setToast] = React.useState(null)
      const [dialog, setDialog] = React.useState(null)
      const [diskChanged, setDiskChanged] = React.useState(false)
      const [openHow, setOpenHow] = React.useState(false)
      const [revision, setRevision] = React.useState(0)

      const dialogResolveRef = React.useRef(null)
      const editorRef = React.useRef(null)
      const sourceRef = React.useRef('')
      const fileRef = React.useRef(null)
      const busyRef = React.useRef(false)
      const dirtyRef = React.useRef(false)
      const targetRef = React.useRef(target)
      const cwdRef = React.useRef(cwd)
      /** 只在组件**首次** load 时为 true —— 用来区分「重建后的草稿恢复」与「用户主动重新读取」。 */
      const firstLoadRef = React.useRef(true)

      fileRef.current = file
      busyRef.current = busy
      dirtyRef.current = dirty
      targetRef.current = target
      cwdRef.current = cwd

      const say = React.useCallback((text, tone) => setStatus({ text, tone: tone || 'idle' }), [])

      /** 把权威文本推进非受控 textarea（受控大文本每次按键重渲染会卡）。 */
      React.useEffect(() => {
        if (editorRef.current) editorRef.current.value = sourceRef.current
      }, [revision])

      function askConfirm(options) {
        return new Promise((resolve) => {
          // ⚠️ resolver 存在 ref 里：不能放进 state 的 updater 里调用
          //（updater 必须是纯函数，StrictMode 会双调用它）。
          dialogResolveRef.current = resolve
          setDialog(Object.assign({}, options))
        })
      }

      function finishDialog(ok) {
        const resolve = dialogResolveRef.current
        dialogResolveRef.current = null
        setDialog(null)
        if (typeof resolve === 'function') resolve(ok)
      }

      /**
       * 组装查询串。
       *  - `cwd`    工作区目录（发现链与预算都需要它）
       *  - `target` 当前编辑的层（链内绝对路径）；省略时用 ref 里的当前值
       *
       * ⚠️ 两个参数都走**同一个工作区值**：曾经「工作区文件」用输入框的值、
       * 「全局文件」用上次解析出的目录 ⇒ 同一个面板会给出两条不同的发现链，
       * 用户看到「切一下编辑目标，列表就变了」。
       */
      function queryFor(targetCwd, targetPath) {
        const params = new URLSearchParams()
        const effectiveCwd = targetCwd === undefined ? cwdRef.current : targetCwd
        if (effectiveCwd) params.set('cwd', effectiveCwd)
        const effectiveTarget = targetPath === undefined ? targetRef.current : targetPath
        if (effectiveTarget) params.set('target', effectiveTarget)
        const query = params.toString()
        return query ? '?' + query : ''
      }

      const load = React.useCallback(async (overrides) => {
        const opts = overrides || {}
        const nextCwd = Object.prototype.hasOwnProperty.call(opts, 'cwd') ? opts.cwd : cwdRef.current
        let nextTarget = Object.prototype.hasOwnProperty.call(opts, 'target') ? opts.target : targetRef.current
        setBusy(true)
        say(t('loading'), 'idle')
        try {
          let payload
          try {
            payload = await readJson(await apiFetch(API_STATE + queryFor(nextCwd, nextTarget), { method: 'GET' }))
          } catch (error) {
            // 记住的目标可能已经不在链内（换了工作区、文件被删、目录被移走）⇒
            // 丢弃它、回退到默认目标**重试一次**，别让面板直接卡在错误态。
            if (!nextTarget) throw error
            writeStore(LS_TARGET, '')
            nextTarget = ''
            payload = await readJson(await apiFetch(API_STATE + queryFor(nextCwd, nextTarget), { method: 'GET' }))
          }
          setCwd(payload.cwd || '')
          if (payload.cwd) writeStore(LS_CWD, payload.cwd)
          setDshHome(payload.dshHome || null)
          setFile(payload.file || null)
          setBudget(payload.budget || null)
          setLayersView(payload.layersView || [])
          setMode(payload.mode || 'both')
          setModePlans(payload.modePlans || {})
          setPluginVersion(payload.pluginVersion || null)
          setTargetsCollide(Boolean(payload.targetsCollide))
          // 编辑目标以 host 返回的实际路径为准（可能是默认值，也可能被规范化过）
          const editing = payload.editingTarget || ''
          setTarget(editing)
          if (editing) writeStore(LS_TARGET, editing)
          sourceRef.current = (payload.file && payload.file.content) || ''
          setRevision((value) => value + 1)
          setBytes(byteLength(sourceRef.current))
          setLineCount(countLines(sourceRef.current))
          setDirty(false)
          setDiskChanged(false)
          if (payload.file && payload.file.exists) {
            say(payload.file.enabled === false ? t('loadedPaused') : t('loaded'), payload.file.enabled === false ? 'warn' : 'ok')
          } else {
            say(t('created'), 'warn')
          }

          // 组件**首次** load = 可能是「语言切换导致的重建」。若重建前留有未保存草稿、
          // 且目标仍是同一份文件，就把它放回编辑器 —— 用户没做错任何事，不该丢内容。
          const isFirstLoad = firstLoadRef.current
          firstLoadRef.current = false
          if (isFirstLoad && draftKeep.text && sameDiskPath(draftKeep.target, editing)) {
            const kept = draftKeep.text
            sourceRef.current = kept
            setRevision((value) => value + 1)
            setBytes(byteLength(kept))
            setLineCount(countLines(kept))
            setDirty(true)
            say(t('dirty'), 'warn')
          } else {
            // 其余情况（用户主动重新读取、切换编辑目标）：草稿已经过用户确认放弃
            draftKeep.target = ''
            draftKeep.text = ''
          }
        } catch (error) {
          say(t('loadFailed') + '：' + ((error && error.message) || 'unknown'), 'err')
        } finally {
          setBusy(false)
        }
      }, [say])

      React.useEffect(() => {
        void load()
      }, [])

      /** 外部改动检测：只在页面可见、且没有未保存改动时低频轮询；不覆盖草稿。 */
      React.useEffect(() => {
        let alive = true
        const timer = setInterval(async () => {
          if (!alive || document.visibilityState !== 'visible') return
          if (busyRef.current || dirtyRef.current) return
          const current = fileRef.current
          if (!current || !current.exists) return
          try {
            const payload = await readJson(
              await apiFetch(API_STATE + queryFor(cwdRef.current, targetRef.current), { method: 'GET' }),
            )
            if (!alive) return
            const next = payload.file
            if (next && next.exists && next.mtime !== current.mtime) {
              // 自己（另一个实例）刚写的：静默吸收，不要吓唬用户
              if (selfWrites.get(next.path) !== next.mtime) setDiskChanged(true)
            }
            setBudget(payload.budget || null)
            // 层清单与模式可能被另一个实例（设置页 / 模态是两份独立挂载）改过 —— 一并刷新，
            // 否则同一个面板的两个入口会显示互相矛盾的状态。
            setLayersView(payload.layersView || [])
            setMode(payload.mode || 'both')
          } catch {
            /* 轮询失败静默 */
          }
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      /** 模态下按 Esc 关闭。旧 DOM 面板有此能力，React 重写时必须补回。 */
      React.useEffect(() => {
        if (!isModal) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          // 对话框自己处理 Esc，别把它一起关掉
          if (document.querySelector('.dsh-agent-dialog')) return
          event.stopPropagation()
          void requestClose()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [isModal, dirty, file])

      /** 有未保存改动时，刷新/关闭标签页给浏览器原生确认 —— 防误丢。 */
      React.useEffect(() => {
        if (!dirty) return undefined
        const onBeforeUnload = (event) => {
          event.preventDefault()
          event.returnValue = ''
        }
        window.addEventListener('beforeunload', onBeforeUnload)
        return () => window.removeEventListener('beforeunload', onBeforeUnload)
      }, [dirty])

      /** 「重新读取」：有未保存改动时先确认，别静默丢草稿。 */
      async function reload() {
        if (dirty) {
          const ok = await askConfirm({
            title: t('unsavedTitle'),
            lines: [t('reloadConfirmBody'), (file && file.path) || 'AGENTS.md'],
            confirmLabel: t('discardReload'),
            cancelLabel: t('cancel'),
            tone: 'danger',
          })
          if (!ok) return
        }
        await load()
      }

      async function save() {
        if (busy) return
        const text = editorRef.current ? editorRef.current.value : sourceRef.current
        setBusy(true)
        say(t('saving'), 'idle')
        try {
          const response = await apiFetch(API_FILE, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              // 编辑目标是**链内绝对路径**（由列表点选而来）；为空则 host 用默认的「工作区 AGENTS.md」
              target: targetRef.current || null,
              cwd: cwdRef.current,
              content: text,
              expectedMtime: fileRef.current && fileRef.current.exists ? fileRef.current.mtime : null,
            }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            /* 保留 null */
          }
          if (response.status === 409) {
            if (payload && payload.file) setFile(payload.file)
            setDiskChanged(false)
            say(t('conflict'), 'err')
            return
          }
          if (!response.ok) {
            throw new Error(payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status)
          }
          if (payload && payload.file) {
            setFile(payload.file)
            if (payload.file.path && payload.file.mtime) selfWrites.set(payload.file.path, payload.file.mtime)
            // 新建（或默认目标）时 host 会把实际落盘路径告诉我们 —— 以它为准
            if (payload.file.path) {
              setTarget(payload.file.path)
              writeStore(LS_TARGET, payload.file.path)
            }
          }
          if (payload && payload.budget) setBudget(payload.budget)
          if (payload && payload.layersView) setLayersView(payload.layersView)
          if (payload && payload.mode) setMode(payload.mode)
          sourceRef.current = text
          draftKeep.target = ''
          draftKeep.text = ''
          setBytes(byteLength(text))
          setLineCount(countLines(text))
          setDirty(false)
          setDiskChanged(false)
          setToast(t('saved'))
          say(t('saved'), 'ok')
        } catch (error) {
          say(t('saveFailed') + '：' + ((error && error.message) || 'unknown'), 'err')
        } finally {
          setBusy(false)
        }
      }

      /**
       * 改名之后，同一个「层位置」（`row.base`）在磁盘上的真实路径会变（`X.md` ↔ `X.md.disabled`）。
       * 用它把编辑目标对准到新路径。
       *
       * ⚠️ 不这么做的**实测后果**：暂停「正在编辑的那一层」之后，编辑器仍去读旧路径 ——
       * 那个文件已经不存在了，于是**内容被清空**，状态还显示「尚不存在，保存即创建」，
       * 而列表里明明白白写着「已暂停，不会生效」。同一个面板给出两套互相矛盾的说法。
       */
      function pathOfSameLayer(nextRows, previousRow) {
        if (!previousRow || !Array.isArray(nextRows)) return null
        const next = nextRows.filter((item) => item.base === previousRow.base)[0]
        return next ? next.path : null
      }

      /**
       * 某一层在人话里的名字。
       * 「本地叠加层」（`AGENTS.local.md`）单独叫「个性化规则」——
       * 它是官方候选名里的 local overlay，定位是"个人规则"，和普通工作区文件不是一回事。
       */
      function layerDisplayName(row) {
        if (!row) return t('layerProject')
        if (row.layer === 'user-global') return t('layerGlobal')
        if (row.kind === 'local') return t('layerLocal')
        return t('layerProject')
      }

      /** 生效范围的名字。 */
      function modeName(value) {
        if (value === 'project') return t('modeProject')
        if (value === 'global') return t('modeGlobal')
        if (value === 'custom') return t('modeCustom')
        return t('modeBoth')
      }

      /**
       * 点列表里的某一行 ⇒ 编辑器切到那一层。
       * **这就是「编辑工作区文件」的入口** —— 不再需要先选一个 scope、再猜它到底对应哪个文件。
       */
      async function editRow(row) {
        if (!row || busy) return
        if (sameDiskPath(row.path, targetRef.current)) return
        if (dirty) {
          const ok = await askConfirm({
            title: t('unsavedTitle'),
            lines: [t('switchConfirmBody', prettyPath(row.displayPath)), (file && file.path) || 'AGENTS.md'],
            confirmLabel: t('discardSwitch'),
            cancelLabel: t('cancel'),
            tone: 'danger',
          })
          if (!ok) return
        }
        await load({ target: row.path })
        // 「点一行 = 我要编辑它」—— 把焦点交给编辑器，省掉一次 Tab。
        // 用 preventScroll：不抢走滚动位置，想连续点几行浏览的人不会被打断。
        if (editorRef.current && typeof editorRef.current.focus === 'function') {
          try {
            editorRef.current.focus({ preventScroll: true })
          } catch {
            /* 老浏览器不支持 preventScroll：不聚焦也不影响功能 */
          }
        }
      }

      /**
       * 切换**某一层**的启用/暂停（= 给文件名加/去 `.disabled` 后缀，内容一个字节不动）。
       * 全局层与项目各层走的是同一个机制 —— 不再有「只有全局能暂停」这种特例。
       */
      async function toggleLayer(row, enabled) {
        if (busy || !row) return
        const name = layerDisplayName(row)
        const paused = row.base + '.disabled'
        const ok = await askConfirm({
          title: enabled ? t('enableLayerTitle', name) : t('pauseLayerTitle', name),
          lines: enabled
            ? [t('enableBody1'), paused, '→ ' + row.base, t('enableBody2')]
            : [t('pauseBody1'), row.base, '→ ' + paused, t('pauseBody2')],
          confirmLabel: enabled ? t('enable') : t('pause'),
          cancelLabel: t('cancel'),
          tone: enabled ? 'default' : 'danger',
        })
        if (!ok) return
        setBusy(true)
        try {
          const payload = await readJson(await apiFetch(API_LAYERS, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: cwdRef.current, changes: [{ base: row.base, enabled }] }),
          }))
          if (payload.layersView) setLayersView(payload.layersView)
          if (payload.mode) setMode(payload.mode)
          if (payload.budget) setBudget(payload.budget)
          setToast(enabled ? t('enabledToast') : t('pausedToast'))
          say(enabled ? t('enabledToast') : t('pausedToast'), enabled ? 'ok' : 'warn')
          // 这一层刚换了文件名 ⇒ 如果它正是当前编辑目标，把编辑器对准**改名后的新路径**。
          // 直接 `await load()` 会拿旧路径去读一个已经不存在的文件，实测后果是内容被清空。
          if (row.exists && sameDiskPath(row.path, targetRef.current)) {
            await load({ target: pathOfSameLayer(payload.layersView, row) || row.path })
          }
        } catch (error) {
          say(t('switchFailed') + '：' + ((error && error.message) || 'unknown'), 'err')
        } finally {
          setBusy(false)
        }
      }

      /**
       * 切换「生效范围」三选一：一起 / 仅工作区 / 仅全局。
       * 一次会动多个文件（例如「仅全局」要暂停链上所有项目层），所以先用一个确认框把话说清楚，
       * 再由 host 一次性执行 —— 提交的是 `mode`，不是客户端逐条拼出来的改名清单。
       */
      async function switchMode(next) {
        // ⚠️ 早退判定必须把 chosenMode 算进来。
        // 碰撞场景（工作区就是 dsh 配置目录）下，物理状态无法区分「工作区 + 全局」与「仅全局」——
        // host 反推出来的 mode 恒为 'both'，而用户看到的高亮可能停在「仅全局」上。
        // 若只比 mode，用户点「工作区 + 全局」会被当成"已经是这个状态"而静默返回，高亮就再也回不去了。
        const alreadyActive = mode === next && (!sameTarget || chosenMode === next)
        if (busy || next === 'custom') return
        // 点**已经激活**的那个 Pill：必须给一句回执。静默早退时，用户只会以为"点了没反应/坏了"
        //（实测踩过 —— 同一区域此前还因为静默早退，让人误以为"三个模式的选项没了"）。
        if (alreadyActive) {
          say(t('modeAlready', modeName(next)), 'ok')
          return
        }
        const affected = (modePlans && modePlans[next]) || []
        const ok = await askConfirm({
          title: t('switchLayerTitle', modeName(next)),
          lines: [
            next === 'project' ? t('modeConfirmProject') : next === 'global' ? t('modeConfirmGlobal') : t('modeConfirmBoth'),
            affected.length > 0 ? affected.map((row) => prettyPath(row.displayPath)).join('、') : '',
            next === 'both' ? '' : t('modeRecoverHint'),
          ],
          confirmLabel: t('modeConfirmLabel'),
          cancelLabel: t('cancel'),
          tone: next === 'both' ? 'default' : 'danger',
        })
        if (!ok) return
        // 记下切换前的编辑目标所在行 —— 切模式可能把这一层改名（原名 ↔ .disabled），
        // 之后要按同一个「层位置」把编辑器对准新路径。
        const editingRowBefore = layersView.filter((row) => sameDiskPath(row.path, targetRef.current))[0] || null
        setBusy(true)
        try {
          const payload = await readJson(await apiFetch(API_LAYERS, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: cwdRef.current, mode: next }),
          }))
          if (payload.layersView) setLayersView(payload.layersView)
          if (payload.mode) setMode(payload.mode)
          if (payload.budget) setBudget(payload.budget)
          // 当前编辑的那一层可能刚被改名 ⇒ 用**同一个层位置的新路径**重载，
          // 否则会去读一个不存在的旧文件（与单层开关同源的清空问题）。
          await load({ target: pathOfSameLayer(payload.layersView, editingRowBefore) || targetRef.current })
          // 记住这次的选择：特例场景下物理状态无法区分「工作区 + 全局」与「仅全局」，
          // 靠它才能让高亮停在用户真正点的那一项上（见 activeMode）。
          setChosenMode(next)
          setToast(t('modeChanged') + ' · ' + modeName(next))
          say(t('modeChanged') + ' · ' + modeName(next), 'ok')
        } catch (error) {
          say(t('switchFailed') + '：' + ((error && error.message) || 'unknown'), 'err')
        } finally {
          setBusy(false)
        }
      }

      async function requestClose() {
        if (!isModal) return
        if (dirty) {
          const ok = await askConfirm({
            title: t('unsavedTitle'),
            lines: [t('closeConfirmBody'), (file && file.path) || 'AGENTS.md'],
            confirmLabel: t('discardClose'),
            cancelLabel: t('cancel'),
            tone: 'danger',
          })
          if (!ok) return
        }
        props.onRequestClose()
      }

      /** 调官方目录选择器挑一个文件夹作为工作区。 */
      async function pickWorkspaceDir() {
        if (!pickDirectory) return
        try {
          const picked = await pickDirectory()
          if (typeof picked !== 'string' || picked.trim() === '') return
          const next = picked.trim()
          setCwd(next)
          // 同上：换工作区同时把编辑目标重置到新工作区的默认文件
          await load({ cwd: next, target: '' })
        } catch (error) {
          say(t('pickFailed') + '：' + ((error && error.message) || 'unknown'), 'err')
        }
      }

      /**
       * 放弃编辑器里的改动。
       *
       * ⚠️ **必须先确认**：这是不可逆操作（内容只活在编辑器里，没有撤销），
       * 而「关闭」那条路径早就有确认框 —— 两条路径都在丢弃用户写的东西，行为必须一致。
       * （实测发现不对称：误点「放弃改动」内容当场就没了，一次问都不问。）
       */
      async function revert() {
        if (!dirty) return
        const ok = await askConfirm({
          title: t('revert'),
          lines: [t('revertConfirmBody'), (file && file.path) || 'AGENTS.md'],
          confirmLabel: t('discardRevert'),
          cancelLabel: t('cancel'),
          tone: 'danger',
        })
        if (!ok) return
        sourceRef.current = (file && file.content) || ''
        draftKeep.target = ''
        draftKeep.text = ''
        setRevision((value) => value + 1)
        setBytes(byteLength(sourceRef.current))
        setLineCount(countLines(sourceRef.current))
        setDirty(false)
        say(t('clean'), 'ok')
      }

      /* --------------------------------------------------------------- 计算值 */

      const limit = (budget && budget.limit) || 65536
      const total = (budget && budget.totalBytes) || 0
      const off = Boolean(budget && budget.instructionsEnabled === false)
      const over = Boolean(budget && budget.over)
      const layers = (budget && budget.layers) || []
      const notRendered = (budget && budget.notRendered) || []
      const omitted = (budget && budget.omitted) || []
      const sourceLimit = (budget && budget.sourceLimitBytes) || (file && file.sourceLimitBytes) || 1048576
      const limitBytes = (file && file.limitBytes) || 65536
      const lines = lineCount
      const statusTone = status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : status.tone === 'ok' ? 'done' : 'idle'

      const segments = []
      if (!off && total > 0) {
        const scale = over ? limit / total : 1
        layers.forEach((layer, index) => {
          if (layer.ignored) return
          segments.push(e('i', {
            key: index,
            'data-tone': over ? 'over' : layer.layer === 'user-global' ? 'global' : 'project',
            style: { width: (((layer.bytes * scale) / limit) * 100) + '%' },
          }))
        })
      }

      const omittedPaths = omitted.map((item) => item.displayPath)
      /**
       * 工作区目录就是 dsh 的配置目录时，「全局」与「工作区」两层其实落在同一个文件上 ——
       * 由 host 按**实际路径**判定（不能只看目录名：全局暂停时它的目标是 .disabled，
       * 两者就不再是同一个文件了）。
       */
      const sameTarget = targetsCollide

      /**
       * 三个生效范围里，哪一个该高亮。
       *
       * 普通场景直接用 host 反推的 `mode`。但**工作区就是 dsh 配置目录**时，那里只有一份
       * AGENTS.md ⇒「工作区 + 全局」与「仅全局」在物理上是同一个状态，host 只能反推出 `both`，
       * 于是点「仅全局」会跳到「工作区 + 全局」上，看着像"点了没动"。这种特例改用
       * **用户最近一次的选择**表达意图，且只在它与当前物理状态相容时才采信
       *（避免被外部改动之后显示与实际不符）。
       */
      const activeMode = (() => {
        if (!sameTarget || mode === 'custom' || !chosenMode) return mode
        const compatible = (chosenMode === 'project') === (mode === 'project')
        return compatible ? chosenMode : mode
      })()

      /**
       * 当前编辑目标是不是「个性化」（本地叠加）那一层 —— 决定编辑器用哪套**预设文案**。
       *
       * 个性化是"额外的补充规则"，跟 AGENTS.md 那种"身份 + 工作规范"不是一回事；
       * 共用一份模板会诱导用户把主文件的内容抄一遍，反而稀释了"叠加"的意义。
       * 用 `sameDiskPath(row.path, …)` 匹配：**暂停态也匹配得上**（row.path 与目标同为 .disabled 路径）。
       */
      const editingLayerRow = layersView.filter((row) => sameDiskPath(row.path, targetRef.current))[0] || null
      const editingIsLocal = Boolean(editingLayerRow && editingLayerRow.kind === 'local')

      /**
       * 官方给出的 displayPath 里带有 `<DSH_HOME>` 占位符 —— **不能直接给用户看**（那是环境变量名）。
       * 换成家目录简写（如 C:\Users\X\.dsh → ~\.dsh），看不到家目录时退回「dsh 配置目录」。
       */
      const prettyPath = (text) => {
        const raw = String(text || '')
        if (raw.indexOf('<DSH_HOME>') < 0) return raw
        const shortHome = String(dshHome || '').replace(/^[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/i, '~')
        return raw.split('<DSH_HOME>').join(shortHome || 'dsh 配置目录')
      }

      /** 这一层的作用范围（人话）。 */
      function rowScopeNote(row) {
        if (row.layer === 'user-global') return t('layerGlobalNote')
        // 本地叠加层要说清三件事：只对本工作区、在 AGENTS.md 之后加载（优先级更高）、通常不进版本控制
        if (row.kind === 'local') return t('layerLocalNote')
        return /[\\/]/.test(row.displayPath) ? t('layerProjectNestedNote') : t('layerProjectRootNote')
      }

      /**
       * 一行的状态说明。优先级：
       *   未创建 / 已暂停 → 中性；被官方忽略（>1MB）→ 错误；会被丢弃或截断 → 警告；否则正常。
       * 「是否被忽略/丢弃」只有 host 的预算统计知道（它复刻了官方裁剪），所以按 displayPath 关联过去。
       */
      function layerHealth(row) {
        if (!row.exists) {
          // 「未创建」对普通文件是"保存后创建"；对个性化那一层还要点明它是什么、落在哪个范围
          return { state: 'idle', note: row.kind === 'local' ? t('rowMissingLocal') : t('rowMissing') }
        }
        if (!row.enabled) return { state: 'idle', note: t('pausedRowNote') }
        // 官方「同目录内容去重」**故意不给用户提示**：它只在两份**逐字节相同**时才发生，
        // 此时"读一份"与"读两份"对结果毫无差别 —— 提示它反而让用户以为"个性化不能叠加"，
        // 而叠加恰恰是这个功能的卖点（实测收到过这个反问）。
        // 不返回 note ⇒ 渲染处自动回落到这一层的范围说明（"可叠加"）。
        // ⚠️ `row.duplicate` 字段本身**必须保留**：它是预算统计的依据
        //（`lib/index.js` 的 `included` 与 `summarizeBudget` 都在用它），别顺手删掉。
        if (row.duplicate) return { state: 'idle' }
        const entry = layers.filter((item) => item.displayPath === row.displayPath)[0]
        if (!entry) return { state: 'idle', note: '' }
        if (entry.ignored) return { state: 'error', note: t('layerIgnoredNote') }
        if (omittedPaths.indexOf(entry.displayPath) >= 0) {
          // 裁剪从最宽泛的开始 ⇒ 只有全局文件是「先」被丢
          return { state: 'warning', note: entry.layer === 'user-global' ? t('layerOmittedFirstNote') : t('layerOmittedNote') }
        }
        // 官方规则：连最具体那份也放不下时才截断它（区别于「被丢弃」）
        if (entry.bytes > limit) return { state: 'warning', note: t('layerTruncatedNote') }
        return { state: 'done', note: '' }
      }

      /**
       * 列表行 —— 官方发现链上的每一层（全局 + 项目根 → cwd）。
       * 每行同时是「这一层生不生效」的展示**和**「点它就在下面编辑它」的入口。
       * 已暂停的层也留在清单里（host 的 layersView 含暂停态），否则开关一关就再也开不回来了。
       */
      const orderRows = layersView.map((row, index) => {
        const health = layerHealth(row)
        const isEditing = sameDiskPath(row.path, target)
        const name = layerDisplayName(row)
        return e('div', {
          className: 'dsh-agent-order-row',
          key: row.base || String(index),
          'data-health': health.state,
          'data-editing': isEditing ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          title: row.path,
          onClick: () => { void editRow(row) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            void editRow(row)
          },
        }, [
          layersView.length > 1 ? e('span', { className: 'dsh-agent-order-index', key: 'i' }, String(index + 1)) : null,
          uiStateDot({ key: 'd', state: health.state, size: 8, className: 'dsh-agent-order-dot' }),
          e('div', { className: 'dsh-agent-order-text', key: 't' }, [
            // 主标题给**路径**：同一屏里常常有两三行都叫「工作区文件」，把分类放在主标题上，
            // 等于让用户逐行去第二行找差异。分类降到注解里 —— 扫读顺序变成"先认清是哪个文件"。
            e('div', { className: 'dsh-agent-order-main', key: 'm' }, [
              e('span', { key: 'p', className: 'dsh-agent-order-path' }, prettyPath(row.displayPath)),
              isEditing ? e('span', { key: 'badge', className: 'dsh-agent-order-badge' }, t('editingBadge')) : null,
            ]),
            // ① **层语义行** —— 恒常显示。内容只由"这一层是什么"决定，**不受状态影响**。
            //    旧写法是 `health.note || rowScopeNote(row)`（二选一），后果是一旦出现健康提示
            //   （已暂停 / 未创建 / 超长），层语义整条被顶掉 —— 用户实测反馈过两次。
            //    现在改成：语义归语义，状态归状态，**各占一行、互不覆盖**。
            e('div', { className: 'dsh-agent-order-scope', key: 's' }, name + ' · ' + rowScopeNote(row)),
            // ② **状态行** —— 仅"非正常"时出现，**追加**而不覆盖（正常态不占位置，行高不变）。
            health.note
              ? e('div', { key: 'h', className: 'dsh-agent-order-rule', 'data-tone': health.state }, health.note)
              : null,
          ]),
          row.exists
            ? e('span', { className: 'dsh-agent-order-bytes', key: 'b' }, formatInt(row.bytes) + ' ' + t('bytesUnit'))
            : null,
          // 开关要自己吃掉点击事件，否则点它会顺带把这一层加载进编辑器
          e('span', {
            key: 'sw',
            className: 'dsh-agent-order-switch',
            onClick: (event) => event.stopPropagation(),
            onKeyDown: (event) => event.stopPropagation(),
          }, uiSwitch({
            checked: row.exists ? Boolean(row.enabled) : false,
            // 「个性化」是**项目层**文件：官方在「仅全局」模式下会把整个项目层暂停，
            // 那一刻它本来就不该被启用 ⇒ **只有这一种情况**禁用开关。
            // 其余两种模式（工作区 + 全局 / 仅工作区）都必须可点 —— 包括"文件尚未创建"的行，
            // 否则用户看到的是一个灰开关，只会以为"这是坏的"（实测收到过这个反馈）。
            disabled: busy || (row.kind === 'local' && activeMode === 'global'),
            label: name,
            title: t('switchLayerTitle', name),
            onChange: (next) => {
              // 文件还不存在时，「暂停 / 启用」在物理上无从谈起（没有文件可改名）。
              // 唯一有意义的动作是**开始写它** ⇒ 载入编辑器，并说清"写+存"才生效。
              if (!row.exists) {
                // 载入编辑器就够了：紧随其后的 `load()` 会给出「尚不存在 · 保存后创建」的状态提示。
                // ⚠️ 这里**不要**再 `say(...)` —— 它会被那次 `load()` 的状态覆盖，
                // 先说的那句永远看不见（实测坐实，是句死文案，已删）。
                void editRow(row)
                return
              }
              void toggleLayer(row, next)
            },
          })),
        ])
      })

      /**
       * 「会生效的文件数」——**直接数列表里的行**，而不是另算一套。
       * 曾经用 host 的预算层数来算，结果列表折叠成 2 行、这里却说 3 个，
       * 同一个面板给出两个互相矛盾的数字。数字与行数必须同源。
       */
      const healthyCount = layersView.filter((row) => row.included && omittedPaths.indexOf(row.displayPath) < 0).length
      /**
       * 占比：极小时显示「<1%」而不是四舍五入成「0%」。
       * 实测过「合计 72 / 65,536 字节 · 0%」这种读起来像"根本没有内容"的显示，
       * 而其实是有内容的 —— 只是小。数字不该把事实说反。
       */
      const percentValue = limit > 0 ? (total / limit) * 100 : 0
      const percentText = percentValue >= 1 ? String(Math.round(percentValue)) : percentValue > 0 ? '<1' : '0'
      const totalLine = off
        ? t('budgetUnavailable')
        : (() => {
            const tail = notRendered.length > 0 || over
              ? t('notAllEffective')
              : healthyCount === 0
                ? t('noneEffective')
                : healthyCount === 1
                  ? (layersView.length > 1 ? t('singleEffective') : '')
                  : t('allEffective', healthyCount)
            return t('totalPrefix') + ' ' + formatInt(total) + ' / ' + formatInt(limit) + ' ' + t('bytesUnit')
              + ' · ' + percentText + '%'
              + (tail ? ' · ' + tail : '')
              + (dirty ? ' ' + t('totalFromDisk') : '')
          })()

      /** 体检：只列出「确实会出问题」的项，把技术数据翻译成人话。 */
      const diagnostics = []
      if (off) {
        diagnostics.push({
          key: 'preset',
          tone: 'err',
          title: t('diagPresetTitle', (budget && budget.presetId) || '?'),
          body: t('diagPresetBody'),
        })
      }
      if (notRendered.length > 0) {
        diagnostics.push({
          key: 'size',
          tone: 'err',
          title: t('diagIgnoredTitle', notRendered.length, formatInt(sourceLimit)),
          body: notRendered.map((item) => prettyPath(item.displayPath)).join('、') + t('diagIgnoredBody'),
        })
      }
      if (over) {
        diagnostics.push({
          key: 'over',
          tone: 'err',
          title: t('diagOverTitle', formatInt(total), formatInt(limit)),
          body: t('diagOverBody')
            + (omitted.length > 0
                ? ' ' + t('diagOverOmit') + ' ' + omitted.map((item) => prettyPath(item.displayPath)).join(' → ') + '。'
                : '')
            + ' ' + t('diagOverFix'),
        })
      }
      if (budget && budget.globalPaused) {
        diagnostics.push({
          key: 'paused',
          tone: 'warn',
          title: t('diagPausedTitle'),
          body: t('diagPausedBody') + ' ' + (budget.globalPath || ''),
        })
      }

      /** 上限是从哪来的（preset 声明 / 回落默认）—— 常显，否则用户看不懂 65,536 这个数。 */
      const planeLine = (budget && budget.planeNote) || ''

      const sizeTitle = bytes > sourceLimit ? t('tooLarge') : bytes > limitBytes ? t('overBudget') : ''

      /** 「它是怎么加载的？」—— 把官方的叠加模型与裁剪规则讲清楚。 */
      const howLines = [t('howEditTarget'), t('how1'), t('how2'), t('how3'), t('howLocal'), t('how4')]
      const howBody = e('div', { className: 'dsh-agent-how' }, howLines.map((line, index) => e('div', { key: index }, line)))
      const howBlock = P.DisclosureRow
        ? e(P.DisclosureRow, {
            key: 'how',
            icon: e('span', { 'aria-hidden': 'true' }, '?'),
            title: t('howTitle'),
            open: openHow,
            expandable: true,
            onToggle: () => setOpenHow((value) => !value),
            expandOnRowClick: true,
          }, howBody)
        : e('div', { key: 'how', className: 'dsh-agent-how' }, howLines.map((line, index) => e('div', { key: index }, line)))

      /* ---------------------------------------------------------------- 渲染 */

      const children = [
        e('div', { className: 'dsh-agent-head', key: 'head' }, [
          e('div', { className: 'dsh-agent-head-text', key: 'text' }, [
            e('div', { className: 'dsh-agent-h1', key: 'h1' }, [
              e('span', { className: 'dsh-agent-bot', key: 'bot', 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: ICON } }),
              t('title'),
            ]),
            e('div', {
              className: 'dsh-agent-sub',
              key: 'sub',
              // 构建标记只放在 hover 里给排查用，不占用户视线
              title: 'UI ' + CLIENT_BUILD + (pluginVersion ? ' · v' + pluginVersion : ''),
            }, t('subtitle')),
          ]),
          e('div', { className: 'dsh-agent-head-actions', key: 'actions' }, [
            // tooltip 用来给**补充信息**，不是复读按钮文字（复读等于没有 tooltip）。
            wrapForTooltip(t('reloadHint'),
              uiButton({ key: 'reload', variant: 'outline', size: 'sm', disabled: busy, onClick: () => void reload(), children: t('reload') })),
            file && file.path
              ? wrapForTooltip(t('copyHint'),
                  uiButton({
                    key: 'copy',
                    variant: 'ghost',
                    size: 'sm',
                    onClick: () => {
                      copyText(file.path).then((ok) => setToast(ok ? t('copied') : t('copyFailed')))
                    },
                    children: t('copyPath'),
                  }))
              : null,
            isModal
              ? wrapForTooltip(t('close'),
                  uiButton({ key: 'close', variant: 'ghost', size: 'sm', onClick: () => void requestClose(), children: '✕' }))
              : null,
          ]),
        ]),

        e('div', { className: 'dsh-agent-stack', key: 'target' }, [
          e('div', { className: 'dsh-agent-row', key: 'mode' }, [
            e('span', { className: 'dsh-agent-label', key: 'l' }, t('modeTitle')),
            // 三个选项**始终都在**。工作区恰好是 dsh 配置目录时，「工作区 + 全局」与「仅全局」
            // 在物理上是同一个结果（那里只有一份文件），但这不代表该把选项藏起来 ——
            // 曾经整行替换成说明文字，用户的第一反应是"三个模式的选项怎么没了"。
            // 现在改为：选项照旧 + 就地说明它们为什么等价 + 高亮跟随用户的选择（见 activeMode）。
            uiPill({ key: 'both', active: activeMode === 'both', onClick: () => void switchMode('both'), children: t('modeBoth') }),
            uiPill({ key: 'proj', active: activeMode === 'project', onClick: () => void switchMode('project'), children: t('modeProject') }),
            uiPill({ key: 'glob', active: activeMode === 'global', onClick: () => void switchMode('global'), children: t('modeGlobal') }),
            // 每层的开关被单独动过、凑不成这三种之一时如实说明。只写「自定义」三个字 ——
            // 曾在这里追加过「两份都暂停了，指令不会生效」，结果在「3 层里只暂停了 1 层」时也说这句话，直接是错的。
            // 真的全都不生效时，下面合计行自己会说「现在没有任何文件会生效」。
            mode === 'custom'
              ? e('span', { className: 'dsh-agent-note', key: 'custom', 'data-tone': 'warn' }, t('modeCustom'))
              : null,
          ]),
          // 特例就地说明：不解释的话，用户点了「仅全局」却看到「工作区 + 全局」亮着，会以为没生效
          sameTarget ? e('span', { className: 'dsh-agent-note', key: 'same' }, t('onlyOneFileNote')) : null,
          e('div', { className: 'dsh-agent-row', key: 'cwd' }, [
            e('span', { className: 'dsh-agent-label', key: 'l' }, t('workspace')),
            e('div', { key: 'i', style: { flex: '1 1 260px', minWidth: 0 } },
              uiInput({
                'aria-label': t('workspace'),
                // 输入框窄时会把长路径截断，用 title 保证完整值可查
                title: cwd || '',
                value: cwd || '',
                placeholder: t('workspacePlaceholder'),
                onChange: (event) => setCwd(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    // ⚠️ 换工作区是**明确的上下文切换** ⇒ 编辑目标一并回到默认（新工作区自己的 AGENTS.md）。
                    // 不这么做时：从 ws 换到 ws/sub，旧目标 ws/AGENTS.md 仍在新的链内，于是「正在编辑」
                    // 还停在上一层 —— 用户会觉得"我明明换了工作区，怎么还在改外面那个文件"。
                    // 想改别的层？列表里点那一行就行（一行一个入口）。
                    void load({ cwd: event.target.value.trim(), target: '' })
                  }
                },
              })),
            pickDirectory
              ? uiButton({
                  key: 'pick',
                  variant: 'outline',
                  size: 'sm',
                  disabled: busy,
                  title: t('pickDirTitle'),
                  onClick: () => { void pickWorkspaceDir() },
                  children: t('pickDir'),
                })
              : null,
          ]),
        ]),

        e('div', { className: 'dsh-agent-stack', key: 'order' }, [
          e('div', { className: 'dsh-agent-order-head', key: 'head' }, [
            e('span', { className: 'dsh-agent-label', key: 'l' }, t('orderTitle')),
            e('span', { className: 'dsh-agent-order-hint', key: 'h' }, t('listHint')),
          ]),
          e('div', { className: 'dsh-agent-order', key: 'rows' }, orderRows),
          e('div', { className: 'dsh-agent-row', key: 'total' }, [
            uiTooltip(totalLine, e('div', { className: 'dsh-agent-bar', 'data-off': off ? 'true' : 'false' }, segments)),
            e('span', {
              className: 'dsh-agent-note',
              key: 'n',
              'data-tone': notRendered.length > 0 || over ? 'err' : total > limit * 0.8 ? 'warn' : 'idle',
            }, totalLine),
          ]),
          planeLine ? e('span', { className: 'dsh-agent-note', key: 'plane' }, planeLine) : null,
        ]),

        diagnostics.length > 0
          ? e('div', { className: 'dsh-agent-stack', key: 'diag' },
              [e('span', { className: 'dsh-agent-label', key: 'l' }, t('diagTitle'))].concat(
                diagnostics.map((item) => e('div', {
                  className: 'dsh-agent-diag',
                  key: item.key,
                  'data-tone': item.tone,
                }, [
                  e('div', { className: 'dsh-agent-diag-title', key: 't' }, item.title),
                  e('div', { className: 'dsh-agent-diag-body', key: 'b' }, item.body),
                ])),
              ))
          : null,

        howBlock,

        // 编辑器上方的「正在编辑」—— 让「我到底在改哪个文件」永远是一眼可见的事实，
        // 而不是要靠回想刚才点过哪一行。
        e('div', { className: 'dsh-agent-editor-head', key: 'editor-head' }, [
          e('span', { className: 'dsh-agent-label', key: 'l' }, t('editTargetTitle')),
          e('span', {
            className: 'dsh-agent-editor-path',
            key: 'p',
            title: (file && file.path) || '',
          }, (file && file.path) || '—'),
          file && file.exists === false
            ? e('span', { className: 'dsh-agent-note', key: 'new' }, t('rowMissing'))
            : null,
          file && file.exists && file.enabled === false
            ? e('span', { className: 'dsh-agent-note', key: 'paused', 'data-tone': 'warn' }, t('pausedRowNote'))
            : null,
        ]),

        e('textarea', {
          key: 'editor',
          className: 'dsh-agent-editor',
          ref: editorRef,
          spellCheck: 'false',
          'aria-label': t('title'),
          placeholder: t(editingIsLocal ? 'placeholderLocal' : 'placeholder', baseNameOf((file && file.path) || targetRef.current)),
          onInput: (event) => {
            const text = event.target.value
            // 记下草稿：万一下一刻组件被重建（切语言时会重新注册 slot），内容不至于凭空消失
            draftKeep.target = targetRef.current
            draftKeep.text = text
            setBytes(byteLength(text))
            setLineCount(countLines(text))
            const next = text !== ((file && file.content) || '')
            if (next !== dirty) setDirty(next)
            say(next ? t('dirty') : t('clean'), next ? 'warn' : 'ok')
          },
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              if (dirty && !busy) void save()
            }
          },
        }),

        e('div', { className: 'dsh-agent-foot', key: 'foot' }, [
          e('div', { className: 'dsh-agent-status', key: 'status' }, [
            uiStateDot({ key: 'dot', state: busy ? 'ongoing' : statusTone, size: 8 }),
            e('span', { key: 'text' }, status.text),
          ]),
          e('div', { className: 'dsh-agent-chips', key: 'chips' }, [
            // 超限提示必须**可见**：曾经只挂在 `title` 上，用户得 hover 才知道为什么存不进去，
            // 点保存只会拿到一个 413 —— 结论摆在眼前比藏在悬浮提示里强。
            e('span', {
              key: 'size',
              className: 'dsh-agent-size',
              'data-tone': !sizeTitle ? 'idle' : (bytes > sourceLimit ? 'err' : 'warn'),
              title: sizeTitle || '',
            },
              (dirty ? t('draftPrefix') + ' ' + formatInt(bytes) + ' / ' + formatInt(limitBytes) + ' ' + t('bytesUnit') + ' · ' : '')
              + lines + ' ' + t('linesUnit')
              + (sizeTitle ? ' · ' + sizeTitle : '')),
            file && file.mtime ? e('span', { key: 'mtime' }, t('lastModified') + ' ' + timeText(file.mtime)) : null,
          ]),
          e('div', { key: 'spacer', className: 'dsh-agent-spacer' }),
          uiButton({ key: 'revert', variant: 'outline', disabled: busy || !dirty, onClick: () => void revert(), children: t('revert') }),
          uiButton({ key: 'save', variant: 'primary', disabled: busy || !dirty, onClick: () => void save(), children: t('save') }),
        ]),

        diskChanged
          ? e('div', { className: 'dsh-agent-note', key: 'drift', 'data-tone': 'warn' }, t('diskChanged'))
          : null,

        toast
          ? (P.Toast
              ? e(P.Toast, { key: 'toast', text: toast, onDone: () => setToast(null) })
              : e('div', { key: 'toast', className: 'dsh-agent-note' }, toast))
          : null,

        dialog
          ? e(ConfirmDialog, {
              key: 'dialog',
              title: dialog.title,
              lines: dialog.lines,
              confirmLabel: dialog.confirmLabel,
              cancelLabel: dialog.cancelLabel,
              tone: dialog.tone,
              onDone: finishDialog,
            })
          : null,
      ]

      const app = e('div', {
        className: 'dsh-agent-app',
        'data-variant': isModal ? 'modal' : 'page',
      }, children)

      if (!isModal) return app
      return e('div', {
        className: 'dsh-agent-modal-mask',
        onClick: (event) => {
          if (event.target === event.currentTarget) void requestClose()
        },
      }, e('div', { className: 'dsh-agent-modal-card' }, app))
    }

    /* ------------------------------------------------------------- 挂载入口 */

    const ICON =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.7V1.5"/><rect x="2.7" y="3.3" width="10.6" height="8.3" rx="2.4"/><circle cx="6.1" cy="7.4" r="0.95" fill="currentColor" stroke="none"/><circle cx="9.9" cy="7.4" r="0.95" fill="currentColor" stroke="none"/><path d="M6.2 9.9h3.6"/></svg>'

    let modalRoot = null

    /** 停止「浮动按钮避让检测」的函数：挂载时赋值，卸载时调用。 */
    let stopFabCollision = () => {}

    /**
     * 只在**几何上确实会与聊天输入区抢右下角**时隐藏浮动按钮。
     *
     * 用户要求（原话）："平常不隐藏，这种情况他就隐藏" —— 所以默认保持可见，只在真挡住时才让位。
     *
     * 判定用**垂直方向**，理由是实测出来的：dsh 的聊天输入区只有两种布局 ——
     *   · 新会话：输入框居中（hero 态），距视口底部很远 ⇒ 不抢右下角 ⇒ 按钮正常显示
     *   · 有对话：输入区一直延伸到底部（含发送按钮与底部工具栏）⇒ 右下角必然被压 ⇒ 隐藏
     * 而"和输入框矩形做重叠判定"是**错的**：实测按钮在 x 1350~1384、输入框元素在 x 461~1205，
     * 两者水平上根本不重叠 —— 真正被压住的是输入区的**容器**（含右侧发送按钮）。
     * 所以只问一句"主输入框有没有伸进视口底部这条带子"就够了，既贴合用户感受，也不脆弱
     *（不用 dsh 的内部 class，那些是哈希会变；也不用给祖先容器猜宽度）。
     *
     * @returns 停止监听的函数。
     */
    function watchFabCollision() {
      /** 输入框伸进视口底部这个范围内，就算会与按钮抢位置。 */
      const BOTTOM_ZONE = 200
      const update = () => {
        const fab = document.getElementById(FAB_ID)
        if (!fab) return
        let collide = false
        for (const el of document.querySelectorAll('[contenteditable], textarea')) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          if (r.width < window.innerWidth * 0.5) continue // 只认主输入框，忽略消息里的可编辑片段
          if (r.bottom > window.innerHeight - BOTTOM_ZONE) {
            collide = true
            break
          }
        }
        const next = collide ? 'true' : 'false'
        // 只在真正翻转时写 DOM：否则每 500ms 都触发一次样式重算
        if (fab.dataset.hidden !== next) fab.dataset.hidden = next
      }
      update()
      const timer = setInterval(update, 500)
      return () => clearInterval(timer)
    }

    /**
     * 跨**组件重建**保留的未保存草稿。
     *
     * 为什么需要它：切换语言时官方 slot 契约要求「用新文案重新注册」设置页条目，
     * 而重新注册会**卸载并重建**这个组件 —— 草稿只活在内存里，会随之消失。
     * 用户只是换了个语言，不该丢内容。
     */
    const draftKeep = { target: '', text: '' }

    /**
     * 挂载右下角浮动按钮（34×34 圆形图标）。
     * 幂等（已在就不重复加）；卸载统一由 `apply` 里的 effect 负责。
     *
     * **只放图标、不放文字**：带文字的胶囊会压住聊天输入区右下角（见样式里的实测说明）。
     * 完整名称通过 `title`（原生 tooltip）与 `aria-label`（读屏）提供，两者随语言变化一起更新。
     */
    function mountFab() {
      // 先接管「挡住输入区就让位」的检测：无论这次是否真的要创建 DOM，
      // 都要把上一轮的定时器换掉 —— 否则热重载后可能留下一个没人管理的 interval。
      stopFabCollision()
      stopFabCollision = watchFabCollision()
      if (document.getElementById(FAB_ID)) return
      ensureStyles()
      const fab = document.createElement('button')
      fab.id = FAB_ID
      fab.className = 'dsh-agent-fab'
      fab.type = 'button'
      fab.innerHTML = ICON
      setFabLabel(fab)
      fab.addEventListener('click', () => openModal())
      document.body.appendChild(fab)
    }

    /** 同步浮动按钮的名称：`title` 给鼠标、`aria-label` 给读屏。语言切换时调用。 */
    function setFabLabel(fab) {
      if (!fab) return
      fab.title = t('title')
      fab.setAttribute('aria-label', t('title'))
    }

    /** 右下角浮动按钮：模态外壳内渲染**同一个**组件树。 */
    function openModal() {
      if (document.getElementById(MODAL_HOST_ID)) return
      ensureStyles()
      const host = document.createElement('div')
      host.id = MODAL_HOST_ID
      document.body.appendChild(host)
      try {
        if (ReactDOMClient && typeof ReactDOMClient.createRoot === 'function') {
          modalRoot = ReactDOMClient.createRoot(host)
        } else {
          const ReactDOM = require('react-dom')
          modalRoot = {
            render: (node) => ReactDOM.render(node, host),
            unmount: () => ReactDOM.unmountComponentAtNode(host),
          }
        }
        modalRoot.render(e(AgentApp, { onRequestClose: closeModal }))
      } catch (error) {
        console.warn('[dsh-agent] 模态面板渲染失败：', error)
        host.remove()
        modalRoot = null
      }
    }

    function closeModal() {
      const host = document.getElementById(MODAL_HOST_ID)
      try {
        if (modalRoot && typeof modalRoot.unmount === 'function') modalRoot.unmount()
      } catch {
        /* 卸载阶段尽力而为 */
      }
      modalRoot = null
      if (host) host.remove()
    }

    /** 「通用设置」行内的紧凑入口（回退用）：标题 + 摘要 + 打开面板。 */
    function AgentGeneralRow() {
      const [summary, setSummary] = React.useState('…')
      React.useEffect(() => {
        let alive = true
        apiFetch(API_STATE + '?cwd=' + encodeURIComponent(readStore(LS_CWD, '')), { method: 'GET' })
          .then((response) => response.json())
          .then((payload) => {
            if (!alive) return
            const budget = payload && payload.budget
            if (!budget) return setSummary('—')
            if (budget.instructionsEnabled === false) {
              return setSummary('preset「' + (budget.presetId || '?') + '」不加载指令文件')
            }
            const percent = budget.limit > 0 ? Math.round((budget.totalBytes / budget.limit) * 100) : 0
            const hasGlobal = (budget.layers || []).some((item) => item.layer === 'user-global')
            setSummary((hasGlobal ? t('globalEnabled') : t('globalPaused')) + ' · ' + t('budgetLabel') + ' ' + percent + '%')
          })
          .catch(() => {
            if (alive) setSummary(t('loadFailed'))
          })
        return () => {
          alive = false
        }
      }, [])

      const caption = { color: 'var(--dsw-alias-label-caption,#8a8a8a)', fontSize: 12 }
      return e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' } }, [
        e('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
          e('div', { key: 'title', style: { fontWeight: 500 } }, t('title')),
          e('div', { key: 'sub', style: caption }, t('subtitle')),
        ]),
        e('span', { key: 'sum', style: caption }, summary),
        e('span', { key: 'btn' }, uiButton({ variant: 'outline', size: 'sm', onClick: () => openModal(), children: t('openPanel') })),
      ])
    }

    /**
     * 本插件自己刚写过的 mtime（按绝对路径）。
     * 设置页与浮动按钮是两个独立实例，同一文件保存后另一个实例的轮询会把它
     * 误报成「磁盘已被外部改动」—— 用这张表静默吸收。
     */
    const selfWrites = new Map()

    let settingsDisposer = null

    /** 注册（或按新文案**重新**注册）设置页独立页。 */
    function registerSettingsSection(ctx) {
      if (settingsDisposer) {
        try {
          settingsDisposer()
        } catch {
          /* 旧注册已失效，忽略 */
        }
        settingsDisposer = null
      }
      settingsDisposer = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 60,
        priority: 60,
        label: t('title'),
      }, AgentApp))
    }

    /**
     * 设置页入口。
     *
     * 首选官方 `settings.section`（设置导航里的独立一页）；随后用 **ledger 自省**
     * （`ctx.slots.entries` —— 正是 `ui-settings-general` 投影导航所用的 API）
     * 确认条目真的进去了；**没进去就回退**到「通用设置」里的一行。
     * 这样无论 slot 契约怎么变，都保证有入口 —— 入口消失就是功能退化。
     */
    function mountSettingsEntry(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
        console.info('[dsh-agent-instructions] 环境未提供 slots 服务，跳过设置页入口')
        return false
      }

      try {
        registerSettingsSection(ctx)
      } catch (error) {
        console.warn('[dsh-agent] settings.section 注册失败：', error)
      }

      const landed = () => {
        try {
          if (typeof ctx.slots.entries !== 'function') return true
          const rows = ctx.slots.entries('settings.section') || []
          const ids = rows.map((row) => row && row.options && row.options.id)
          console.info('[dsh-agent-instructions] settings.section ledger = ' + JSON.stringify(ids))
          return ids.indexOf(NS) !== -1
        } catch (error) {
          console.info('[dsh-agent-instructions] ledger 自省不可用：' + ((error && error.message) || error))
          return true
        }
      }

      // inject 的触发可能是异步的，给两拍再判定
      setTimeout(() => {
        if (landed()) {
          console.info('[dsh-agent-instructions] 设置页独立页已就绪（settings.section）')
          return
        }
        console.warn('[dsh-agent] settings.section 未进 ledger，回退到「通用设置」行')
        try {
          ctx.slots.inject('settings.general.item', () => ctx.slots.register({
            name: 'settings.general.item',
            id: NS,
            order: 60,
          }, AgentGeneralRow))
        } catch (error) {
          console.warn('[dsh-agent] 回退入口注册失败：', error)
        }
      }, 600)

      return true
    }

    /** 可选：注册 zh/en 文案表。**故意不 inject locale** —— 免得某环境没有该服务就整个插件不加载。 */
    function registerLocale(ctx) {
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : (ctx && ctx.locale)
        // 顺手留住：currentLang() 要读它的 snapshot.active —— 那才是**权威**语言来源。
        if (locale && typeof locale.getSnapshot === 'function') localeService = locale
        if (!locale || typeof locale.register !== 'function') return false
        locale.register(NS, { zh: MESSAGES.zh, en: MESSAGES.en })
        return true
      } catch (error) {
        console.info('[dsh-agent-instructions] locale 注册跳过：', error && error.message)
        return false
      }
    }

    /* ------------------------------------------------ 客户端 cordis 插件入口 */

    function apply(ctx) {
      try {
        loadVendors()
      } catch (error) {
        console.warn('[dsh-agent] React 依赖加载失败，插件不挂载任何界面：', error)
        return
      }

      // 语言来源要**最早**拿到：后面 mountFab / mountSettingsEntry 的首次取文案都由它决定。
      // 顺序错了，浮动按钮和设置页入口就会停在 dsh 写入 `<html lang>` 之前的那个语言上。
      try {
        registerLocale(ctx)
      } catch {
        /* 内部已兜底 */
      }

      const boot = () => {
        try {
          mountFab()
        } catch (error) {
          console.warn('[dsh-agent] 浮动按钮挂载失败：', error)
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true })
      } else {
        boot()
      }

      // 官方目录选择器（可选能力）：u-workSpace 服务暴露 pickDirectory()
      try {
        const uiWorkspace = ctx.uiWorkspace ?? (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined)
        if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') {
          pickDirectory = () => uiWorkspace.pickDirectory()
        }
      } catch {
        /* 服务不可用：不渲染按钮，不影响其它功能 */
      }

      try {
        mountSettingsEntry(ctx)
      } catch (error) {
        console.warn('[dsh-agent] 设置页入口挂载失败：', error)
      }

      // 语言**两个来源都盯**：
      //   ① 官方 locale 服务的 snapshot —— 权威；dsh 里切语言时它会变
      //   ② `<html lang>` —— dsh 启动后异步写入；作为服务缺席时的兜底信号
      // 两者都汇进 onLangSourceChanged 这一个漏斗。
      const onLangChanged = () => onLangSourceChanged(ctx)

      let stopWatch = () => {}
      try {
        stopWatch = watchLang(onLangChanged)
      } catch {
        /* 监听失败不影响主要功能 */
      }

      let stopLocale = () => {}
      try {
        if (localeService && typeof localeService.subscribe === 'function') {
          const off = localeService.subscribe(onLangChanged)
          if (typeof off === 'function') stopLocale = off
        }
      } catch {
        /* 服务缺席时只靠 <html lang> 兜底 */
      }

      ctx.effect(
        () => () => {
          try {
            stopWatch()
            stopLocale()
            stopFabCollision()
            closeModal()
            document.getElementById(FAB_ID)?.remove()
            document.getElementById(STYLE_ID)?.remove()
          } catch {
            /* 卸载阶段尽力而为 */
          }
        },
        'dsh-agent: ui',
      )
    }

    exports.apply = apply
    // ⚠️ `inject` 是 **cordis 服务注入表**（不是模块依赖）：用 ctx.slots 就必须声明 'slots'。
    exports.inject = ['slots', 'uiWorkspace']
    return module.exports
  },
})
