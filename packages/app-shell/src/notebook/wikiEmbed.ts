/**
 * wiki 内嵌图片（Obsidian `![[image.png]]`）—— atomic 原生不识别这个语法
 * （它的 imageBlocks 只认标准 `![](url)`），故自写一个 CM6 装饰：
 * 把「整行只有一个 ![[图片]]」且光标不在该行时，块级替换为内嵌图片，
 * 图片经主进程 shuvix-preview:// 协议加载（带沙箱校验）。光标移到该行则露出原文便于编辑。
 *
 * 块级装饰必须来自 StateField（CM6 不允许 ViewPlugin 产出块级装饰），故用 StateField 实现。
 */
import {
  type Extension,
  type EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType
} from '@codemirror/view'

/** 文件列表异步就绪后由外部 dispatch，触发内嵌装饰重算 */
export const refreshEmbeds = StateEffect.define<null>()

/**
 * 图片异步加载完成后请求 CM 重新测量行高。
 *
 * atomic-editor 的图片块（`![](url)`）与本文件的 `![[wiki]]` 内嵌都把 `<img>` 当块级 widget。
 * 图片 decode 完才有真实高度，但若不通知 CM，块级 widget 在高度图里仍按加载前(≈0)记账，
 * 导致其下方 posAtCoords（坐标→文档位置）映射偏移——鼠标点击落点与文本光标错位，
 * 且上方图片越多累积越大。`<img>` 的 load 事件不冒泡，故在编辑器根上用捕获阶段统一监听，
 * 任一图片 load/error 即请求重测，覆盖两种图片来源。
 */
export const imageLoadRemeasure: Extension = ViewPlugin.fromClass(
  class {
    private readonly onLoad: (e: Event) => void
    constructor(private readonly view: EditorView) {
      this.onLoad = (e: Event): void => {
        const target = e.target as HTMLElement | null
        // 冷缓存首次加载时图片由 0 撑开，请求重测让 CM 回填块级 widget 高度（暖缓存已由
        // EmbedImageWidget 预留尺寸，无跳变）。注意：盒子留白须用 padding 而非 margin，
        // 否则外边距空隙永远统计不进高度图，重测也无济于事（见 atomic-panel.css 内嵌图片规则）。
        if (target && target.tagName === 'IMG') this.view.requestMeasure()
      }
      // load/error 不冒泡，须 capture=true 才能在根节点收到子孙 <img> 的事件
      view.dom.addEventListener('load', this.onLoad, true)
      view.dom.addEventListener('error', this.onLoad, true)
    }
    destroy(): void {
      this.view.dom.removeEventListener('load', this.onLoad, true)
      this.view.dom.removeEventListener('error', this.onLoad, true)
    }
  }
)

/** 单个文件条目（供 [[ ]] 自动补全搜索用，token 在建表时一次性算好） */
export interface FileEntry {
  /** 原始大小写相对路径（如 `docs/Notes.md`） */
  rel: string
  /** 原始大小写文件名（含扩展名，如 `Notes.md`） */
  base: string
  /** 绝对路径 */
  abs: string
  /**
   * 可直接写进 `[[token]]` 且能被 lookupAbs 解析回本文件的「最短无歧义」token。
   * 优先级：.md 去扩展名的裸名 > 含扩展名文件名 > 相对路径（仅当更短形式会解析到别的文件时才回退）。
   */
  token: string
}

/** 项目文件名 → 绝对路径 的查表（按文件名全局匹配，类 Obsidian） */
export interface FileMap {
  root: string
  /** 小写文件名（含扩展名）→ 绝对路径，首个命中优先 */
  byBase: Map<string, string>
  /** 小写相对路径 → 绝对路径 */
  byRel: Map<string, string>
  /** 全部条目（保持 scan 顺序）；[[ 补全在此之上做内存内过滤，避免每次击键回后端 */
  entries: FileEntry[]
}

/** 用宿主机分隔符拼接 base 与相对路径（不引 node:path，兼容 win 反斜杠） */
export function joinHostPath(base: string, rel: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[/\\]+$/, '')}${sep}${rel.replace(/^[/\\]+/, '')}`
}

export function buildFileMap(root: string, paths: string[]): FileMap {
  const byBase = new Map<string, string>()
  const byRel = new Map<string, string>()
  for (const rel of paths) {
    const abs = joinHostPath(root, rel)
    byRel.set(rel.toLowerCase(), abs)
    const base = (rel.split(/[/\\]/).pop() ?? rel).toLowerCase()
    if (!byBase.has(base)) byBase.set(base, abs)
  }
  // byBase/byRel 填好后再算每个条目的最短 token（依赖 lookupAbs 判定唯一性）
  const map: FileMap = { root, byBase, byRel, entries: [] }
  map.entries = paths.map((rel) => {
    const abs = joinHostPath(root, rel)
    const base = rel.split(/[/\\]/).pop() ?? rel
    return { rel, base, abs, token: pickToken(map, rel, base, abs) }
  })
  return map
}

/**
 * 选出能解析回本文件的最短 token。逐个候选用 lookupAbs 校验「解析回来是否还是自己」，
 * 命中重名时更短形式会解析到别的文件 → 自动回退到相对路径（byRel 保证唯一）。
 */
function pickToken(map: FileMap, rel: string, base: string, abs: string): string {
  const candidates: string[] = []
  if (/\.md$/i.test(base)) candidates.push(base.slice(0, -3)) // 裸名（lookupAbs 会补 .md）
  candidates.push(base, rel)
  for (const c of candidates) {
    if (lookupAbs(map, c) === abs) return c
  }
  return rel
}

/** 解析 [[name]] / ![[name]] 的 name 到绝对路径：相对路径 > 文件名 > 文件名补 .md */
export function lookupAbs(map: FileMap | null, name: string): string | null {
  if (!map) return null
  const n = name.trim().toLowerCase()
  return map.byRel.get(n) ?? map.byBase.get(n) ?? map.byBase.get(`${n}.md`) ?? null
}

/** [[ ]] 自动补全的一条候选（token 直接写入文档，label/detail 仅用于下拉展示） */
export interface FileSuggestion {
  /** 插入 [[token]] 的内容 */
  token: string
  /** 下拉主文案（文件名） */
  label: string
  /** 下拉副文案（所在目录，仅嵌套文件才有；顶层文件与文件名重复故省略） */
  detail?: string
}

/**
 * 在已建好的内存文件表内搜索匹配 query 的文件，供 [[ ]] 自动补全。
 *
 * 海量文件性能：只在内存里线性过滤 + 排序，绝不每次击键回后端扫盘（后端 scan 已一次性把
 * 至多 SCAN_LIMIT 条路径缓存进 FileMap，并随 files.changed 事件刷新）。单遍 O(n) 打分，
 * 命中子集再排序，20000 条量级下每次击键 < 几毫秒，配合补全侧 120ms 防抖足够。
 *
 * 打分：文件名前缀 > 文件名子串 > 相对路径子串；同分按路径更短（层级更浅）、再按字典序。
 * 空 query（仅 Ctrl-Space 显式触发时可能出现）返回层级最浅的前 limit 条。
 */
export function searchFileMap(map: FileMap | null, query: string, limit = 12): FileSuggestion[] {
  if (!map) return []
  const q = query.trim().toLowerCase()
  const scored: { entry: FileEntry; score: number }[] = []
  for (const entry of map.entries) {
    const baseL = entry.base.toLowerCase()
    let score: number
    if (!q) score = 0
    else if (baseL.startsWith(q)) score = 3
    else if (baseL.includes(q)) score = 2
    else if (entry.rel.toLowerCase().includes(q)) score = 1
    else continue
    scored.push({ entry, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.rel.length - b.entry.rel.length ||
      (a.entry.rel < b.entry.rel ? -1 : a.entry.rel > b.entry.rel ? 1 : 0)
  )
  return scored.slice(0, limit).map(({ entry }) => {
    // 目录部分（顶层文件无目录 → 省略 detail，避免与文件名重复）
    const dir = entry.rel.slice(0, entry.rel.length - entry.base.length).replace(/[/\\]+$/, '')
    return { token: entry.token, label: entry.base, detail: dir || undefined }
  })
}

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(p)
}

export interface WikiEmbedConfig {
  /** 把 ![[name]] 的 name 解析成可加载的图片 URL；非图片/未找到返回 null */
  resolveSrc: (name: string) => string | null
}

/** 整行恰好是单个 ![[...]]（允许 |alias） */
const SINGLE_EMBED_RE = /^!\[\[([^\]\n|]+?)(?:\|[^\]\n]*)?\]\]$/

/**
 * 已观测到的图片自然尺寸缓存（按 URL）。块级 widget 若不预留正确高度，
 * 图片 decode 后才从 0 撑开，CM 高度图来不及回填 → 其下方坐标→位置映射偏移、点击错位。
 * 仿 atomic-editor imageBlocks：从缓存把自然宽高写入 width/height 属性，挂载即预留正确比例的盒子
 * （CSS `max-width:100%; height:auto` 仍按列宽缩放），重挂载不再有「先 0 后撑开」的跳变。
 */
const embedDimCache = new Map<string, { w: number; h: number }>()

class EmbedImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly srcLine: number
  ) {
    super()
  }
  eq(other: EmbedImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-atomic-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    const cached = embedDimCache.get(this.src)
    if (cached) {
      img.width = cached.w
      img.height = cached.h
    } else {
      img.addEventListener('load', () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          embedDimCache.set(this.src, { w: img.naturalWidth, h: img.naturalHeight })
        }
      })
    }
    wrap.appendChild(img)
    // 点击图片把光标落到源行 → 露出 ![[...]] 原文便于编辑
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const lineNo = Math.min(this.srcLine, view.state.doc.lines)
      view.focus()
      view.dispatch({ selection: { anchor: view.state.doc.line(lineNo).from } })
    })
    return wrap
  }
  ignoreEvent(e: Event): boolean {
    return e.type === 'mousedown' || e.type === 'click'
  }
}

function buildEmbedDecos(
  state: EditorState,
  resolveSrc: WikiEmbedConfig['resolveSrc']
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const sel = state.selection.main
  const activeFrom = state.doc.lineAt(sel.from).number
  const activeTo = state.doc.lineAt(sel.to).number
  for (let n = 1; n <= state.doc.lines; n++) {
    if (n >= activeFrom && n <= activeTo) continue // 光标所在行：显示原文供编辑
    const line = state.doc.line(n)
    const m = SINGLE_EMBED_RE.exec(line.text.trim())
    if (!m) continue
    const src = resolveSrc(m[1].trim())
    if (!src) continue
    builder.add(
      line.from,
      line.to,
      Decoration.replace({ widget: new EmbedImageWidget(src, m[1].trim(), n), block: true })
    )
  }
  return builder.finish()
}

export function wikiImageEmbeds(config: WikiEmbedConfig): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildEmbedDecos(state, config.resolveSrc)
    },
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshEmbeds))) {
        return buildEmbedDecos(tr.state, config.resolveSrc)
      }
      return value.map(tr.changes)
    },
    provide: (f) => EditorView.decorations.from(f)
  })
}
