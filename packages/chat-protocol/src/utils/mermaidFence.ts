/**
 * ```mermaid 围栏 → 图：对话（chat-ui 的 MermaidBlock）与笔记本（atomic-editor 的 mermaid-blocks）
 * 共用的那一半。
 *
 * 渲染器是 pele（Obsidian 团队的 mermaid → SVG 渲染器，2026-10-17 替换了 mermaid.js）。换它的理由，
 * 也是 mermaid 现在与 ```svg 围栏走同一条路的理由：
 *
 *  - **产物是 token 着色的静态 SVG。** 没有 `<style>` / `<foreignObject>` / `url()`，颜色全是
 *    `var(--pele-*)`。于是它过的是**手写档**净化（sanitizeAuthoredSvg，比 mermaid.js 那档严），
 *    颜色由 themes.css 里 `.pele` 那段映射到 ShuviX 的 token —— 切主题不重渲；导出走手写图
 *    同一条烘焙路径（bakeAuthoredSvg），不再按主题另渲一张。
 *  - **同步、亚毫秒级。** 于是流式中能逐帧画（见 mermaidFrameSources），不必等源码写完；
 *    也不再需要 mermaid.js 那套串行队列、超时与按主题分键的缓存。
 *
 * chat-protocol 是零依赖叶子包，所以渲染器由调用方注入（MermaidEngine 只是 pele `render` 的形状）。
 * 这里只放两边都要、而且两份拷贝会悄悄写岔的东西：帧判定、固定的渲染选项、净化与失败语义。
 * 按图类型懒加载（pele/lazy 的 `load`）是各自的事 —— 一边是 React 状态，一边是 CM6 widget。
 */
import { sanitizeAuthoredSvg, SVG_MAX_LENGTH } from './svgSanitize'

/** 围栏语言名：两个消费方认的是同一个字面量（大小写敏感，与 ```svg 那档一致） */
export const MERMAID_FENCE_LANG = 'mermaid'

/** 这里会传给渲染器的选项 —— pele `RenderOptions` 的子集 */
export interface MermaidRenderOptions {
  fontFamily?: string
  fontSize?: number
  maxWidth?: number
  directionBreakpoint?: number
  links?: boolean
  images?: boolean
  idPrefix?: string
  outputLimit?: number
}

/** 注入的渲染器：pele 的 `render`（同步；解析失败、图类型没加载都是抛错） */
export interface MermaidEngine {
  render(
    source: string,
    options: MermaidRenderOptions
  ): { svg: string; width: number; height: number }
}

/** 一张画好的图：`svg` 已过手写档净化；宽高是图的自然像素尺寸 */
export interface MermaidFigure {
  svg: string
  width: number
  height: number
}

export type MermaidRenderResult = { figure: MermaidFigure } | { error: string }

/**
 * 两个消费方都固定传的选项。
 *
 * - `links` / `images` 关掉：图里的链接与外链图片都是「一被渲染就外发请求」的信标，和手写档
 *   净化拒绝远程地址是同一个理由（本地优先、不出网）；手写档反正也会把它们剥掉，这里关掉是让
 *   产物从一开始就不带它们。
 * - `outputLimit` 对齐净化的长度上限：超限时拿到的是 pele 自己的「太大」错误，而不是一句
 *   含糊的「净化失败」。
 * - `idPrefix` 写死即可：净化会按内容给 id 加前缀（scopeAuthoredIds），同一页两张图不会撞。
 */
export const MERMAID_RENDER_OPTIONS = {
  links: false,
  images: false,
  outputLimit: SVG_MAX_LENGTH,
  idPrefix: 'mermaid'
} as const satisfies MermaidRenderOptions

/**
 * 按栏宽重排时，自然尺寸缩到这个比例以下就允许横排改竖排（与 chat-ui mermaidFit 的
 * MERMAID_MIN_READABLE_SCALE 同一个数：13px 的字缩到 0.6 约 8px）。
 *
 * pele 自己只在可用宽度低于 640 时才改方向（`directionBreakpoint` 缺省 640）；对话栏常常比 640 宽，
 * 于是一条十个节点的横向链只收一点间距、照旧两千像素宽，再被整张缩到栏宽 —— 字只剩 4px。
 * 读得清就保持作者写的方向（缩一点而已），读不清才改竖排：把断点抬到栏宽之上。
 */
const MERMAID_REFLOW_SCALE = 0.6

/**
 * 围栏还开着时，补在一帧末尾、替它关上还没写完的块的尾巴，按常见程度排：`subgraph` / `alt` /
 * `loop` 等用 `end` 收，类 / 实体 / 复合状态的块用 `}` 收，两层嵌套的也试一下。
 */
const FRAME_CLOSERS = ['', '\nend', '\n}', '\nend\nend', '\n}\n}', '\n}\nend', '\nend\nend\nend']

/**
 * 一帧最多试这么多个候选（尾巴 × 往回退的行数）。一次失败的解析在 0.1ms 量级，这个上限兜住
 * 「怎么补都画不出来」的病态源码 —— 帧只在多写完一行时重算，所以最坏也只是每行几毫秒。
 */
const MAX_FRAME_ATTEMPTS = 48

/** 前置 frontmatter 之后、去掉空行与 `%%` 注释（含 `%%{init}%%`）之后的行数；frontmatter 没写完 = 0 */
function contentLineCount(lines: readonly string[]): number {
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (lines[i]?.trim() === '---') {
    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') {
        close = j
        break
      }
    }
    if (close === -1) return 0
    i = close + 1
  }
  let n = 0
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t && !t.startsWith('%%')) n++
  }
  return n
}

/**
 * 这一刻拿去渲染的候选源码，按优先级排 —— 第一个画得出来的就是这一帧。
 *
 * **围栏闭合了**（或消息写完了）：只有源码本身。写完了还画不出来就是写坏了，不补、不退 ——
 * 补出来的图会把错误藏起来。
 *
 * **围栏还开着**（流式中）：
 *  1. **丢掉最后一行**：它可能写到一半（`B --> C[调`）。代价是图总比源码慢一行。
 *  2. **至少两行内容**才出帧：只有图类型那一行的「图」是一个空框，与其闪一下不如继续显示占位。
 *  3. **补尾巴**：没闭合的 `subgraph` / `alt` / `class {` 本身就是语法错误，补上 `end` / `}` 才画得出。
 *  4. **往回退**：补什么都不行（例如刚写下一个 `else`）就再丢一行重试 —— 这一帧于是退回上一帧，
 *     而不是从图变回占位。这让组件不必自己记「上一张好图」：帧是源码的纯函数。
 */
export function* mermaidFrameSources(code: string, closed: boolean): Generator<string> {
  if (closed) {
    yield code
    return
  }
  const lines = code.split('\n')
  lines.pop()
  for (let n = lines.length; n > 0; n--) {
    // 以空行或注释结尾的那一截与少一行的那一截等价，不必各试一遍
    const last = lines[n - 1].trim()
    if (last === '' || last.startsWith('%%')) continue
    const body = lines.slice(0, n)
    if (contentLineCount(body) < 2) return
    const base = body.join('\n')
    for (const tail of FRAME_CLOSERS) yield base + tail
  }
}

/**
 * 渲染一段 mermaid 源码：按帧挑候选 → 渲染 → 手写档净化。
 *
 * - `closed`：见 mermaidFrameSources。
 * - `fitWidth`：放图的那一格有多宽。图按自然尺寸放得下就用自然尺寸；放不下才按这个宽度重排一次
 *   （pele 会换行、收间距；整张缩进来字就读不清时还会把横向流程图改成竖排，见 MERMAID_REFLOW_SCALE）
 *   —— 只在放不下时传，是为了让宽栏里的图与宽度无关、可以缓存。
 *
 * 返回 `null` = 围栏还开着、此刻没有能画的帧（显示占位）；`{ error }` 只在 `closed` 时出现。
 * 净化返回空串一律当失败（失败关闭），绝不注入未经检查的标记。
 */
export function renderMermaidFigure(
  engine: MermaidEngine,
  code: string,
  opts: { closed: boolean; fontFamily?: string; fontSize: number; fitWidth?: number }
): MermaidRenderResult | null {
  const options: MermaidRenderOptions = {
    ...MERMAID_RENDER_OPTIONS,
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize
  }
  let attempts = 0
  let lastError: string | null = null
  for (const source of mermaidFrameSources(code, opts.closed)) {
    if (++attempts > MAX_FRAME_ATTEMPTS) break
    let rendered: { svg: string; width: number; height: number }
    try {
      rendered = engine.render(source, options)
      if (opts.fitWidth && opts.fitWidth > 0 && rendered.width > opts.fitWidth) {
        try {
          const unreadable = opts.fitWidth / rendered.width < MERMAID_REFLOW_SCALE
          rendered = engine.render(source, {
            ...options,
            maxWidth: opts.fitWidth,
            ...(unreadable ? { directionBreakpoint: opts.fitWidth + 1 } : {})
          })
        } catch {
          // 按窄栏重排失败不算失败：自然尺寸那张已经画出来了，交给外层缩放
        }
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      continue
    }
    const svg = sanitizeAuthoredSvg(rendered.svg)
    if (!svg) {
      lastError = 'SVG sanitization failed'
      continue
    }
    return { figure: { svg, width: rendered.width, height: rendered.height } }
  }
  return opts.closed ? { error: lastError ?? 'Mermaid render failed' } : null
}
