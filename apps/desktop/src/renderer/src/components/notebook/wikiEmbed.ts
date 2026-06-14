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
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

/** 文件列表异步就绪后由外部 dispatch，触发内嵌装饰重算 */
export const refreshEmbeds = StateEffect.define<null>()

/** 项目文件名 → 绝对路径 的查表（按文件名全局匹配，类 Obsidian） */
export interface FileMap {
  root: string
  /** 小写文件名（含扩展名）→ 绝对路径，首个命中优先 */
  byBase: Map<string, string>
  /** 小写相对路径 → 绝对路径 */
  byRel: Map<string, string>
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
  return { root, byBase, byRel }
}

/** 解析 [[name]] / ![[name]] 的 name 到绝对路径：相对路径 > 文件名 > 文件名补 .md */
export function lookupAbs(map: FileMap | null, name: string): string | null {
  if (!map) return null
  const n = name.trim().toLowerCase()
  return map.byRel.get(n) ?? map.byBase.get(n) ?? map.byBase.get(`${n}.md`) ?? null
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
