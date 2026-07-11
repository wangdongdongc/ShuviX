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

// 工作区文件表的纯数据工具已下沉到 @shuvix/chat-protocol（leaf，供聊天输入框 @ 引用共用）。
// 此处 re-export 保持既有 `from './wikiEmbed'` 导入不变。
export {
  buildFileMap,
  lookupAbs,
  searchFileMap,
  joinHostPath,
  type FileEntry,
  type FileMap,
  type FileSuggestion
} from '@shuvix/chat-protocol/utils/fileMap'

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
