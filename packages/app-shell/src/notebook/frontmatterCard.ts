/**
 * shuvix 契约 md 的 frontmatter「属性卡」—— Obsidian Properties 风格的块级 live-preview。
 *
 * 行为：文件以 `shuvix: <type> v<n>` 标记开头时，把整段 frontmatter（首行 `---` 到闭合
 * `---`）替换为一张结构化属性卡；光标（含选区）触及该区间且编辑器聚焦时还原为 YAML
 * 源码（与 inline-preview / mermaid-blocks 的揭示规则一致 —— blur / 只读下恒为卡片）。
 * 无标记的普通 markdown 完全不受影响（零装饰）。
 *
 * 编辑模型：**文档文本是唯一事实源**。布尔字段的开关做行级 scoped edit（改值段或在
 * 闭合线前插一行），文本/列表字段点击把光标送到对应行（露出源码编辑）——绝不整体
 * 重序列化 frontmatter，注释、键序、未知键、undo 栈全部保持。已知字段由 chat-protocol
 * 的类型描述符驱动；无描述符的类型 / 未列出的键落通用 key/value 行（未来类型免改降级）。
 *
 * 实现样板：块级替换装饰必须来自 StateField（CM6 限制），揭示又依赖 hasFocus ——
 * 照 atomic-editor mermaid-blocks：焦点经 ViewPlugin 镜像进 state。放 app-shell 而非
 * atomic-editor（同 wikiEmbed.ts 的取舍）：ShuviX 语义（契约/描述符/i18n）不进 vendored
 * 包，经 LivePreviewEditor 的 extensions 注入，桌面与扩展两宿主同时生效。
 */
import { parse as parseYaml } from 'yaml'
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Line
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import {
  SHUVIX_MARKER_KEY,
  readShuvixMarker,
  type ShuvixMarker,
  type ShuvixMdValidation
} from '@shuvix/chat-protocol/shuvixMdContract'
import {
  descriptorForType,
  type ShuvixMdFieldKind,
  type ShuvixMdFieldSpec
} from '@shuvix/chat-protocol/shuvixMdDescriptors'

export interface FrontmatterCardConfig {
  /** i18n 解析（注入 i18n.t —— extensions 在 mount 时一次性捕获，实例稳定、按当前语言取值） */
  t: (key: string) => string
  /**
   * 解析器级校验（宿主经 ChatApi 注入：桌面走 IPC、扩展进程内直调 agent-runtime）。
   * 不提供则卡片只做本地 YAML 语法提示。text 为重组的 `---\n<yaml>\n---\n` 最小文件：
   * 合法性只由 frontmatter 决定，正文编辑不触发重校验。
   */
  validate?: (params: { type: string; text: string; name?: string }) => Promise<ShuvixMdValidation>
  /**
   * 诊断文案里的文件名（解析器 warn 的 who，缺省 'file'）。必须参与校验缓存 key ——
   * frontmatter 完全相同的两个文件不得串用对方横幅里的文件名。
   */
  name?: string
  /**
   * 把**宿主的成熟选择器**挂进卡片的字段槽位（csv → ToolSelectList，select → ModelSelect）。
   * 卡片自身保持纯 DOM：它只负责开槽、告知当前值、接收写回，React 组件的生命周期
   * 由宿主在返回的 cleanup 里收尾（widget.destroy 时调用）。
   *
   * 刻意不在卡片内自绘候选项菜单 —— 工具选择要处理分组/MCP 连接态/skill 启停，
   * 模型选择要处理提供商图标/能力标记/搜索，仓库里这两个组件早已成熟，重造只会分叉。
   * 不提供本接缝时，两类字段退回只读 + 跳源码。
   */
  mountField?: (slot: HTMLElement, ctx: FrontmatterFieldMount) => (() => void) | void
}

/** 字段槽位的挂载上下文 —— 宿主据此渲染选择器并写回 */
export interface FrontmatterFieldMount {
  key: string
  kind: ShuvixMdFieldKind
  /** 当前行的原始值（csv 为逗号串，select 为单值）；键不存在时为空串 */
  value: string
  /** 写回（null = 整行删除）—— 与布尔开关同一条行级 scoped edit 路径 */
  onChange: (next: string | null) => void
  /** 只读（内置档案 / 只读预览）：控件照常挂，但禁用 —— 形态一致，只读靠禁用体现 */
  readOnly: boolean
}

// ---------------------------------------------------------------------
// frontmatter 定位（行扫描，不依赖语法树 —— lezer-markdown 不解析 frontmatter，
// 现状里它退化为 HR + 普通段落，本扩展的块级替换恰好把这段整体接管）

/** 闭合定界线（容忍行尾空白，对齐契约正则）；开头线要求恰为 `---`（容 BOM） */
const CLOSER_RE = /^---[ \t]*$/
/** 扫描上限 —— frontmatter 是元数据头，闭合线太远即视为普通正文，不认卡 */
const MAX_SCAN_LINES = 200

interface FmRange {
  from: number
  to: number
  /** 两条定界线之间的 YAML 原文（空 frontmatter 为空串 —— 无标记行，自然不成卡） */
  yaml: string
  /** 闭合定界线的行号 */
  endLine: number
}

function findFrontmatter(state: EditorState): FmRange | null {
  const doc = state.doc
  if (doc.lines < 2) return null
  const first = doc.line(1)
  const text0 = first.text.charCodeAt(0) === 0xfeff ? first.text.slice(1) : first.text
  if (text0 !== '---') return null
  const last = Math.min(doc.lines, MAX_SCAN_LINES)
  for (let n = 2; n <= last; n++) {
    if (CLOSER_RE.test(doc.line(n).text)) {
      const yaml = n === 2 ? '' : doc.sliceString(doc.line(2).from, doc.line(n - 1).to)
      return { from: first.from, to: doc.line(n).to, yaml, endLine: n }
    }
  }
  return null
}

// ---------------------------------------------------------------------
// 焦点镜像（mermaid-blocks 同款：StateField 读不到 view.hasFocus，经 ViewPlugin
// 在微任务里 dispatch 进 state —— 同步 dispatch 属非法的重入更新）

const setFmFocused = StateEffect.define<boolean>()

const fmFocusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFmFocused)) return effect.value
    }
    return value
  }
})

const fmFocusWatcher = ViewPlugin.fromClass(
  class {
    view: EditorView
    constructor(view: EditorView) {
      this.view = view
    }
    update(update: ViewUpdate): void {
      if (!update.focusChanged) return
      const view = this.view
      queueMicrotask(() => {
        try {
          view.dispatch({ effects: setFmFocused.of(view.hasFocus) })
        } catch {
          // 事件与微任务之间视图已销毁
        }
      })
    }
  }
)

// ---------------------------------------------------------------------
// 卡上编辑：行级 scoped edit（文档文本是唯一事实源）

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** frontmatter 顶层键所在行（锚零缩进 —— 嵌套键有缩进不会误中，同 wiki 契约的 NAME_LINE_RE） */
function keyLine(
  state: EditorState,
  fm: FmRange,
  key: string
): { line: Line; prefixLen: number } | null {
  const re = new RegExp(`^(${escapeRe(key)}[ \\t]*:)`)
  for (let n = 2; n < fm.endLine; n++) {
    const line = state.doc.line(n)
    const m = re.exec(line.text)
    if (m) return { line, prefixLen: m[1].length }
  }
  return null
}

/** 「编辑源码」：光标送进 frontmatter（YAML 首行行尾），标准揭示语义接管 */
function revealSource(view: EditorView): void {
  const fm = findFrontmatter(view.state)
  if (!fm) return
  const line = view.state.doc.line(fm.endLine > 2 ? 2 : 1)
  view.focus()
  view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true })
}

/**
 * 该键的值是否为「单行简单标量」—— 行级 scoped edit 的前提条件。
 *
 * 排除两种会被单行重写破坏的形态：
 *   - **块标量 / 折行续行**（`key: >-` 或引号跨行）：YAML 解析出的仍是字符串，
 *     卡片会误判为可编辑；只重写首行会把缩进续行留成孤儿 —— 多数情况下这是**静默污染**
 *     （YAML 按折行把孤儿并进值里，不报错、UI 上也看不出来），只有新值需要加引号时
 *     才整份解析失败。静默那半更危险，故一律不给编辑。
 *   - **行尾注释**：改值段会连注释一起吞掉，与本模块「注释保真」的承诺相悖。
 * 两种形态一律退回只读 + 跳源码（源码编辑本就是它们的正确归宿）。
 * 键不存在时返回 true —— 插入新行没有这些风险。
 */
function isSimpleScalarLine(state: EditorState, fm: FmRange, key: string): boolean {
  const hit = keyLine(state, fm, key)
  if (!hit) return true
  const value = hit.line.text.slice(hit.prefixLen)
  // 行尾注释（YAML 要求 # 前有空白才起注释；# 紧贴值时属于值的一部分）
  if (/\s#/.test(value)) return false
  // 块标量指示符
  if (/^\s*[|>][+-]?\s*$/.test(value)) return false
  // 续行：下一行仍在 frontmatter 内且有缩进
  const next = hit.line.number + 1
  if (next < fm.endLine && /^\s+\S/.test(state.doc.line(next).text)) return false
  return true
}

/**
 * YAML 标量的最小安全写出。`key: ${value}` 直接拼接会在几种取值上被误解析
 * （含 ` #` 起注释、含 `: ` 变映射、以指示符起头等）—— 这些取值在工具名
 * （`mcp:<用户自取的 server 名>`）与模型 id 上都真实可达。需要时加单引号并转义。
 */
function yamlScalar(value: string): string {
  const risky =
    value === '' ||
    value !== value.trim() ||
    /\s#/.test(value) ||
    value.includes(': ') ||
    value.endsWith(':') ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
  return risky ? `'${value.replace(/'/g, "''")}'` : value
}

/**
 * 行级 scoped edit：改值段 / 无键时在闭合线前插一行 / 值为 null 时整行删除。
 * 始终只动一行 —— 注释、键序、未知键、undo 栈全部保住（文档文本是唯一事实源）。
 * 行尾注释随值让位：frontmatter 标量行带尾注释极罕见，取舍从简。
 */
function setScalarKey(view: EditorView, key: string, value: string | null): void {
  const state = view.state
  const fm = findFrontmatter(state)
  if (!fm) return
  const hit = keyLine(state, fm, key)
  if (hit) {
    if (value === null) {
      // 删除整行（含换行符 —— 闭合定界线恒在其后，行尾必有换行）
      view.dispatch({ changes: { from: hit.line.from, to: hit.line.to + 1, insert: '' } })
    } else {
      view.dispatch({
        changes: {
          from: hit.line.from + hit.prefixLen,
          to: hit.line.to,
          insert: ` ${yamlScalar(value)}`
        }
      })
    }
    return
  }
  if (value === null) return
  const closer = state.doc.line(fm.endLine)
  view.dispatch({ changes: { from: closer.from, insert: `${key}: ${yamlScalar(value)}\n` } })
}

/** 布尔开关：光标不动 → 卡片保持渲染态，开关原地翻转 */
function setBooleanKey(view: EditorView, key: string, next: boolean): void {
  setScalarKey(view, key, String(next))
}

// ---------------------------------------------------------------------
// 卡片 DOM
//
// 视觉语言直接沿用设置页的 SettingsSection / SettingsRow（同一套 Tailwind 类名 ——
// tailwind.config 的 content 覆盖 packages/app-shell/src/**/*.ts，故 .ts 里的类名
// 照常被扫描）：标题行在外、圆角描边卡片在内、行间 divide 分隔。属性卡本质就是
// 一张「设置卡片」，没有理由自成一套观感。
//
// `.cm-shuvix-fmcard*` 类名保留为**测试与宿主的稳定钩子**，不承担样式。

const CARD_BOX =
  'rounded-xl border border-border-secondary/60 bg-bg-secondary/30 overflow-hidden divide-y divide-border-secondary/40'
const ROW = 'flex items-center justify-between gap-3 px-4 py-2.5'
const ROW_BLOCK = 'px-4 py-2.5 space-y-1.5'
const LABEL = 'min-w-0 flex-1 text-[13px] text-text-primary'
const VALUE = 'shrink-0 max-w-[62%] text-[13px] text-text-primary text-right break-words'
const MUTED = 'text-[11px] text-text-tertiary'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** 非字符串标量的显示化（对象/数组只给形状 —— 嵌套结构按设计只摘要） */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return `[${value.length}]`
  if (value !== null && typeof value === 'object') return '{…}'
  return String(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 条件映射 → `key: v1, v2 · key2: v3`（键即 CEL 路径，原样展示：所见即引擎所评估） */
function conditionsText(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, v]) => `${key}: ${Array.isArray(v) ? v.map(String).join(', ') : String(v)}`)
    .join('  ·  ')
}

/** csv 值 → 条目数组（保序去空） */
function csvEntries(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
}

/** 只读结构摘要（conditions / exprMap / policyRules）；形状不符返回 null → 退回标量渲染 */
function buildStructuredValue(kind: ShuvixMdFieldKind, value: unknown): HTMLElement | null {
  if (kind === 'conditions') {
    if (!isPlainObject(value)) return null
    return el(
      'div',
      'cm-shuvix-fmcard-value font-mono text-[11px] text-text-secondary break-words',
      conditionsText(value)
    )
  }
  if (kind === 'exprMap') {
    if (!isPlainObject(value)) return null
    const box = el(
      'div',
      'cm-shuvix-fmcard-value font-mono text-[11px] text-text-secondary space-y-0.5'
    )
    for (const [name, expr] of Object.entries(value)) {
      const line = el('div', 'cm-shuvix-fmcard-let break-words')
      line.appendChild(el('span', 'cm-shuvix-fmcard-let-name text-text-primary', name))
      line.appendChild(document.createTextNode(` = ${String(expr)}`))
      box.appendChild(line)
    }
    return box
  }
  if (kind === 'policyRules') {
    if (!Array.isArray(value)) return null
    const box = el('div', 'cm-shuvix-fmcard-value space-y-1')
    for (const item of value) {
      const wrap = el('div', 'cm-shuvix-fmcard-rule-wrap')
      const rule = el('div', 'cm-shuvix-fmcard-rule flex items-baseline gap-2')
      const raw = isPlainObject(item) ? item : {}
      const effect = typeof raw.effect === 'string' ? raw.effect : '?'
      const badge = el(
        'span',
        `cm-shuvix-fmcard-effect shrink-0 px-1.5 py-0.5 rounded font-semibold uppercase text-[9px] tracking-wide ${EFFECT_CLASS[effect] ?? 'bg-bg-secondary text-text-tertiary'}`,
        effect
      )
      badge.dataset.effect = effect
      rule.appendChild(badge)
      // prompt 是给人读的一句话，不是条件 —— 单独一行散排，不混进 mono 的条件串
      const conditions = Object.fromEntries(
        Object.entries(raw).filter(([k]) => k !== 'effect' && k !== 'match' && k !== 'prompt')
      )
      const parts: string[] = []
      if (Object.keys(conditions).length > 0) parts.push(conditionsText(conditions))
      if (typeof raw.match === 'string') parts.push(raw.match)
      rule.appendChild(
        el(
          'span',
          'cm-shuvix-fmcard-rule-text font-mono text-[11px] text-text-secondary break-words',
          parts.join('  ·  ')
        )
      )
      wrap.appendChild(rule)
      if (typeof raw.prompt === 'string' && raw.prompt.trim()) {
        wrap.appendChild(
          el(
            'div',
            'cm-shuvix-fmcard-rule-prompt text-[11px] leading-snug text-text-tertiary pl-[3.25rem] break-words',
            raw.prompt.trim()
          )
        )
      }
      box.appendChild(wrap)
    }
    return box
  }
  return null
}

/**
 * effect 徽章配色 —— **按强弱从上到下排列，颜色本身编码强度**：
 * 越靠上越压得过下面的（deny > force-ask > force-allow > ask > allow）。
 * 名字里的 force- 已经说明了一半，颜色让人扫一眼列表就知道谁凶。
 * 导出给设置页的梯子图例复用 —— 两处各写一份颜色迟早漂移。
 * 键序即强弱序：Object.keys 就是图例要展示的顺序。
 */
export const EFFECT_CLASS: Record<string, string> = {
  deny: 'bg-red-500/10 text-red-600 dark:text-red-400',
  'force-ask': 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
  'force-allow': 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  ask: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  allow: 'bg-green-500/10 text-green-600 dark:text-green-400'
}

function unsetSpan(t: FrontmatterCardConfig['t']): HTMLElement {
  return el('span', `cm-shuvix-fmcard-unset ${MUTED}`, t('notebook.frontmatter.unset'))
}

/** 只读输入框：不挂提交监听（禁用态本就不会触发），保持文字可读、光标为默认 */
function finishReadOnly(wrap: HTMLElement, input: HTMLTextAreaElement): HTMLElement {
  input.classList.add('disabled:cursor-default', 'disabled:text-text-secondary')
  wrap.appendChild(input)
  return wrap
}

/**
 * 文本标量的卡上直编（name / displayName / description）。
 *
 * 这三个字段此前只读展示，改一句描述就得切源码 —— 而卡片态与源码态的块高差
 * 有一百多像素，来回切会让正文上下弹跳。让它们就地可改，源码模式才退回它该有的
 * 角色（加未知键、写注释、修坏掉的 YAML）。
 *
 * 写回仍是行级 scoped edit：回车/失焦提交，Esc 还原；清空 = 删除该键（与选择器一致）。
 * 输入框获得焦点时 CM6 的 contentDOM 并未获焦，故不会触发「光标进入 frontmatter」的
 * 揭示（hasFocus 比较的是 activeElement 与 contentDOM 本身）。
 */
function buildTextEditor(
  view: EditorView,
  config: FrontmatterCardConfig,
  spec: ShuvixMdFieldSpec,
  current: string,
  readOnly: boolean
): HTMLElement {
  const wrap = el('div', 'cm-shuvix-fmcard-value flex-1 min-w-0')
  // textarea 而非 input：描述这类长文本在单行输入框里会被裁掉，用户得移动光标才看得全。
  // field-sizing:content 让它随内容自动增高（仓库既有用法，Electron 的 Chromium 支持）。
  // 左对齐：可编辑控件右对齐读起来别扭，长文本换行后尤其乱。
  const input = document.createElement('textarea')
  input.rows = 1
  input.className = `cm-shuvix-fmcard-input w-full resize-none overflow-hidden [field-sizing:content] appearance-none bg-bg-primary rounded-md px-2.5 py-1 text-[12px] leading-relaxed text-text-primary border border-transparent transition-colors hover:border-border-secondary/60 focus:outline-none focus:border-accent/60 placeholder:text-text-tertiary${
    spec.kind === 'mono' ? ' font-mono text-[11.5px]' : ''
  }`
  input.value = current
  input.placeholder = config.t('notebook.frontmatter.unset')
  input.dataset.key = spec.key
  input.disabled = readOnly
  if (readOnly) return finishReadOnly(wrap, input)

  const commit = (): void => {
    // frontmatter 标量是单行的：粘贴进来的换行折成空格，避免写出破坏结构的值
    const next = input.value.replace(/\s*\n+\s*/g, ' ').trim()
    if (next === current.trim()) return
    setScalarKey(view, spec.key, next === '' ? null : next)
  }
  input.addEventListener('keydown', (e) => {
    // 卡内按键不外泄给编辑器（widget.ignoreEvent 已拦，这里再挡一层防 keymap 抢键）
    e.stopPropagation()
    if (e.key === 'Enter') {
      // 单行标量：回车是提交而不是换行
      e.preventDefault()
      input.blur()
    } else if (e.key === 'Escape') {
      input.value = current
      input.blur()
    }
  })
  input.addEventListener('blur', commit)
  wrap.appendChild(input)
  return wrap
}

function buildFieldRow(
  view: EditorView,
  config: FrontmatterCardConfig,
  spec: ShuvixMdFieldSpec,
  value: unknown,
  readOnly: boolean,
  cleanups: Array<() => void>
): HTMLElement {
  const t = config.t

  // 布尔：设置页 Toggle 的同款开关（w-8 h-[18px] 胶囊 + 14px 白色滑块）
  if (spec.kind === 'boolean' && (value === undefined || typeof value === 'boolean')) {
    const row = el('div', `cm-shuvix-fmcard-row ${ROW}`)
    row.dataset.key = spec.key
    row.appendChild(el('span', `cm-shuvix-fmcard-label ${LABEL}`, t(spec.labelKey)))
    const state = value === undefined ? 'unset' : value ? 'on' : 'off'
    const right = el('div', 'shrink-0 flex items-center gap-2')
    if (state === 'unset') right.appendChild(unsetSpan(t))
    const toggle = el(
      'button',
      `cm-shuvix-fmcard-toggle inline-flex items-center w-8 h-[18px] rounded-full px-[2px] transition-colors ${
        state === 'on' ? 'bg-accent' : 'bg-border-secondary'
      } ${state === 'unset' ? 'opacity-50' : ''} ${readOnly ? '' : 'cursor-pointer'}`
    )
    toggle.type = 'button'
    toggle.dataset.state = state
    toggle.disabled = readOnly
    toggle.appendChild(
      el(
        'span',
        `block w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-150 ${
          state === 'on' ? 'translate-x-[14px]' : 'translate-x-0'
        }`
      )
    )
    if (!readOnly) {
      toggle.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        setBooleanKey(view, spec.key, value !== true)
      })
    }
    right.appendChild(toggle)
    row.appendChild(right)
    return row
  }

  // 交给宿主选择器（csv → ToolSelectList，select → ModelSelect）的两个前提：
  // 宿主提供了 mountField、值是单行简单标量（块标量/续行/行尾注释退回纯文本展示）。
  // **只读不再跳过挂载**：两种模式渲染同一套控件，只读态把它们禁用 —— 否则同一张卡
  // 在只读与可编辑之间会换一副长相（右对齐静态文本 ⇄ 左对齐输入框）。
  const fm = findFrontmatter(view.state)
  const mountable = !!config.mountField && !!fm && isSimpleScalarLine(view.state, fm, spec.key)
  // 空值（`key:` → YAML null）与缺键在解析契约里等价（都=不声明），故一并算可编辑 ——
  // 否则「留空」的字段在 GUI 里再也改不回来，而这个差别用户完全看不见
  if (
    mountable &&
    (spec.kind === 'csv' || spec.kind === 'select') &&
    (value === undefined || value === null || typeof value === 'string')
  ) {
    const row = el('div', `cm-shuvix-fmcard-row ${ROW}`)
    row.dataset.key = spec.key
    row.appendChild(el('span', `cm-shuvix-fmcard-label ${LABEL}`, t(spec.labelKey)))
    const slot = el('div', 'cm-shuvix-fmcard-slot shrink-0 max-w-[70%]')
    row.appendChild(slot)
    const cleanup = config.mountField?.(slot, {
      key: spec.key,
      kind: spec.kind,
      value: typeof value === 'string' ? value : '',
      onChange: (next) => setScalarKey(view, spec.key, next),
      readOnly
    })
    if (cleanup) cleanups.push(cleanup)
    return row
  }

  // 文本标量：同一套输入框，只读时禁用（受 isSimpleScalarLine 守卫 —— 块标量/续行/行尾注释除外）
  if (
    !!fm &&
    (spec.kind === 'text' || spec.kind === 'mono') &&
    (value === undefined || value === null || typeof value === 'string') &&
    isSimpleScalarLine(view.state, fm, spec.key)
  ) {
    const textRow = el('div', `cm-shuvix-fmcard-row ${ROW}`)
    textRow.dataset.key = spec.key
    textRow.appendChild(
      el(
        'span',
        'cm-shuvix-fmcard-label w-[132px] shrink-0 text-[13px] text-text-primary',
        t(spec.labelKey)
      )
    )
    textRow.appendChild(
      buildTextEditor(view, config, spec, typeof value === 'string' ? value : '', readOnly)
    )
    return textRow
  }

  // 只读结构摘要（policy 的 scope / lets / rules）：标签在上、内容整宽在下（同 SettingsBlock）
  const structured =
    value === undefined || value === null ? null : buildStructuredValue(spec.kind, value)
  if (structured) {
    const row = el('div', `cm-shuvix-fmcard-row is-block ${ROW_BLOCK}`)
    row.dataset.key = spec.key
    row.appendChild(
      el('div', `cm-shuvix-fmcard-label text-[13px] text-text-primary`, t(spec.labelKey))
    )
    row.appendChild(structured)
    return row
  }

  // 文本 / 只读列表值
  const row = el('div', `cm-shuvix-fmcard-row ${ROW}`)
  row.dataset.key = spec.key
  row.appendChild(el('span', `cm-shuvix-fmcard-label ${LABEL}`, t(spec.labelKey)))
  const mono = spec.kind === 'mono' || spec.kind === 'select' ? ' font-mono text-[11.5px]' : ''
  const valueEl = el('div', `cm-shuvix-fmcard-value ${VALUE}${mono}`)
  if (value === undefined || value === null || value === '') {
    valueEl.appendChild(unsetSpan(t))
  } else if (spec.kind === 'csv' && typeof value === 'string') {
    const chips = el('div', 'cm-shuvix-fmcard-chips flex flex-wrap justify-end gap-1')
    for (const entry of csvEntries(value)) {
      const chip = el(
        'span',
        'cm-shuvix-fmcard-chip px-1.5 py-0.5 rounded-md border border-border-secondary/60 bg-bg-primary font-mono text-[11px]',
        entry
      )
      chip.dataset.value = entry
      chips.appendChild(chip)
    }
    valueEl.appendChild(chips)
  } else {
    valueEl.textContent = scalarText(value)
  }
  row.appendChild(valueEl)
  return row
}

function buildGenericRow(key: string, value: unknown): HTMLElement {
  const row = el('div', `cm-shuvix-fmcard-row is-generic ${ROW}`)
  row.dataset.key = key
  row.appendChild(
    el('span', `cm-shuvix-fmcard-label ${LABEL} font-mono text-[11.5px] text-text-secondary`, key)
  )
  row.appendChild(el('div', `cm-shuvix-fmcard-value ${VALUE}`, scalarText(value)))
  return row
}

/**
 * 校验结果缓存（key = 文件名 + type + YAML 原文）：光标进出导致的 widget/DOM 重建
 * 不重复打宿主校验，YAML 一变即新 key。粗暴防涨：超限整体清空。
 */
const validationCache = new Map<string, ShuvixMdValidation>()
const VALIDATION_CACHE_MAX = 64

class FrontmatterCardWidget extends WidgetType {
  /** 宿主挂载的字段选择器的卸载回调（CM6 丢弃本 widget 时执行） */
  private readonly cleanups: Array<() => void> = []

  constructor(
    readonly yaml: string,
    readonly marker: ShuvixMarker,
    readonly config: FrontmatterCardConfig
  ) {
    super()
  }

  // 身份只看 YAML 原文 —— 光标移动导致的重建经 eq 复用既有 DOM（mermaid 同策）
  eq(other: FrontmatterCardWidget): boolean {
    return other.yaml === this.yaml
  }

  // 卡内交互（开关 / 按钮 / 选择器）全由 widget 自己处理，编辑器不介入
  ignoreEvent(): boolean {
    return true
  }

  // CM6 丢弃 widget（YAML 变化 → 新实例，或卡片被揭示态替换）时卸载宿主挂载的组件
  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups.length = 0
  }

  toDOM(view: EditorView): HTMLElement {
    const { t } = this.config
    const readOnly = view.state.readOnly
    const wrap = el('div', 'cm-shuvix-fmcard my-3')
    wrap.setAttribute('contenteditable', 'false')

    // 点卡片空白处（标签、行间、卡片背景）不得把光标送进 frontmatter —— 卡片位于
    // contenteditable 区域内，浏览器默认会把选区落到 widget 旁边，于是「聚焦 + 选区
    // 触及 frontmatter」的揭示条件成立，卡片当场塌成源码（块高差一百多像素，正文
    // 随之弹跳）。mousedown 上 preventDefault 即可阻止这次聚焦与选区移动。
    // 交互控件（输入框 / 按钮 / 选择器槽位）例外：它们需要拿到焦点。
    // 卡片本身 user-select:none，故这里不会牺牲文本选中能力。
    wrap.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, button, select, .cm-shuvix-fmcard-slot')) return
      e.preventDefault()
    })

    let fields: Record<string, unknown> | null
    try {
      const parsed: unknown = parseYaml(this.yaml)
      fields =
        parsed !== null &&
        parsed !== undefined &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {}
    } catch {
      // YAML 语法错：报横幅，字段区留空（正文照常）
      fields = null
    }

    const descriptor = descriptorForType(this.marker.type)

    // 标题行在卡片之外（同 SettingsSection）：类型徽章 + 校验态 + 「编辑源码」
    const head = el('div', 'cm-shuvix-fmcard-head flex items-center gap-2 mb-2 px-1')
    const version = this.marker.version !== null ? ` · v${this.marker.version}` : ''
    head.appendChild(
      el(
        'span',
        'cm-shuvix-fmcard-badge text-[13px] font-semibold text-text-primary',
        `${descriptor?.badge ?? `ShuviX ${this.marker.type}`}${version}`
      )
    )
    if (fields === null) {
      head.appendChild(
        el(
          'span',
          'cm-shuvix-fmcard-err text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500',
          t('notebook.frontmatter.yamlError')
        )
      )
    }
    const statusChip = el('span', 'cm-shuvix-fmcard-status text-[10px] px-1.5 py-0.5 rounded')
    statusChip.hidden = true
    head.appendChild(statusChip)
    head.appendChild(el('div', 'flex-1'))
    if (!readOnly) {
      const src = el(
        'button',
        'cm-shuvix-fmcard-src shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors',
        t('notebook.frontmatter.sourceButton')
      )
      src.type = 'button'
      src.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        revealSource(view)
      })
      head.appendChild(src)
    }
    wrap.appendChild(head)

    // 解析器级校验（异步；缓存命中同步上屏）
    const banner = el(
      'div',
      'cm-shuvix-fmcard-banner mb-2 px-3 py-2 rounded-lg text-[11px] leading-relaxed break-words'
    )
    banner.hidden = true
    wrap.appendChild(banner)
    const { validate } = this.config
    if (validate) {
      const paint = (result: ShuvixMdValidation): void => {
        if (result.status === 'unknown') return
        const warned = result.status === 'valid' && result.messages.length > 0
        statusChip.hidden = false
        statusChip.classList.toggle('is-ok', result.status === 'valid' && !warned)
        statusChip.classList.toggle('is-warn', warned)
        statusChip.classList.toggle('is-err', result.status === 'invalid')
        statusChip.className = `cm-shuvix-fmcard-status text-[10px] px-1.5 py-0.5 rounded ${
          result.status === 'invalid'
            ? 'is-err bg-red-500/10 text-red-500'
            : warned
              ? 'is-warn bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'is-ok bg-green-500/10 text-green-600 dark:text-green-400'
        }`
        statusChip.textContent = t(
          result.status === 'invalid'
            ? 'notebook.frontmatter.invalid'
            : warned
              ? 'notebook.frontmatter.warned'
              : 'notebook.frontmatter.valid'
        )
        if (result.messages.length > 0) {
          banner.hidden = false
          banner.className = `cm-shuvix-fmcard-banner mb-2 px-3 py-2 rounded-lg text-[11px] leading-relaxed break-words ${
            result.status === 'invalid'
              ? 'is-err bg-red-500/10 text-red-500'
              : 'is-warn bg-amber-500/10 text-amber-600 dark:text-amber-400'
          }`
          banner.replaceChildren(
            ...result.messages.map((m) =>
              el('div', 'cm-shuvix-fmcard-banner-line whitespace-pre-wrap', m)
            )
          )
        } else {
          banner.hidden = true
        }
      }
      const cacheKey = `${this.config.name ?? ''}\n${this.marker.type}\n${this.yaml}`
      const cached = validationCache.get(cacheKey)
      if (cached) {
        paint(cached)
      } else {
        void validate({
          type: this.marker.type,
          text: `---\n${this.yaml}\n---\n`,
          name: this.config.name
        })
          .then((result) => {
            if (validationCache.size >= VALIDATION_CACHE_MAX) validationCache.clear()
            validationCache.set(cacheKey, result)
            if (wrap.isConnected) {
              paint(result)
              view.requestMeasure()
            }
          })
          .catch(() => {
            /* 校验通道失败（如宿主未实现）：不显示校验态 */
          })
      }
    }

    if (fields !== null) {
      const box = el('div', `cm-shuvix-fmcard-rows ${CARD_BOX}`)
      const known = descriptor?.fields ?? []
      const seen = new Set<string>([SHUVIX_MARKER_KEY, ...known.map((f) => f.key)])
      for (const f of known) {
        box.appendChild(buildFieldRow(view, this.config, f, fields[f.key], readOnly, this.cleanups))
      }
      for (const [key, value] of Object.entries(fields)) {
        if (seen.has(key)) continue
        box.appendChild(buildGenericRow(key, value))
      }
      wrap.appendChild(box)
    }
    return wrap
  }
}

// ---------------------------------------------------------------------
// 装饰构建与装配

const fmSourceLine = Decoration.line({ class: 'cm-shuvix-fm-srcline' })

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

function buildDecos(state: EditorState, config: FrontmatterCardConfig): DecorationSet {
  const fm = findFrontmatter(state)
  if (!fm) return Decoration.none
  const marker = readShuvixMarker(fm.yaml)
  if (!marker) return Decoration.none

  // 揭示态：不替换，只给源码行淡淡的背景 tint（标出「这段是元数据」的边界）
  if (state.field(fmFocusedField) && selectionTouches(state, fm.from, fm.to)) {
    const builder = new RangeSetBuilder<Decoration>()
    for (let n = 1; n <= fm.endLine; n++) {
      const from = state.doc.line(n).from
      builder.add(from, from, fmSourceLine)
    }
    return builder.finish()
  }

  return Decoration.set([
    Decoration.replace({
      widget: new FrontmatterCardWidget(fm.yaml, marker, config),
      block: true
    }).range(fm.from, fm.to)
  ])
}

/**
 * shuvix 契约 md 的 frontmatter 属性卡扩展。自检测 `shuvix: <type>` 标记 ——
 * 普通 markdown 零装饰、零开销（首行非 `---` 即返回）。
 */
export function frontmatterCard(config: FrontmatterCardConfig): Extension {
  const cardField = StateField.define<DecorationSet>({
    create: (state) => buildDecos(state, config),
    update(deco, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setFmFocused)) return buildDecos(tr.state, config)
      }
      if (!tr.startState.selection.eq(tr.state.selection)) return buildDecos(tr.state, config)
      if (!tr.docChanged) return deco
      // 文档变更一律重建：findFrontmatter 是 ≤200 行的行扫描，代价可忽略；
      // DOM 复用由 widget.eq（YAML 原文相同）保证，不会因重建而重绘。
      return buildDecos(tr.state, config)
    },
    provide: (f) => EditorView.decorations.from(f)
  })
  return [fmFocusedField, cardField, fmFocusWatcher]
}
