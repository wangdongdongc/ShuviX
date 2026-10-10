/**
 * 图导出的纯逻辑半 —— 不碰 DOM，node 环境可测。DOM 半（离屏烘焙、转位图、落盘、剪贴板）
 * 在 figureExport.ts。
 */

/** 导出格式 */
export type FigureFormat = 'svg' | 'png' | 'jpg'
/** 配色：跟当前主题，或按用户设定的浅色 / 深色主题重新取色 */
export type FigureScheme = 'current' | 'light' | 'dark'

/**
 * 解析成「十六进制 + 不透明度」的颜色。
 *
 * 为什么不把计算值原样写回去：Chromium 给 color-mix() 的计算值是 `color(srgb r g b / a)`，
 * 给半透明色是 `rgba()` —— 浏览器认，PowerPoint / Illustrator / 老版 Inkscape 这些图真正要
 * 去的地方不一定认。SVG 1.1 的写法（`fill="#rrggbb" fill-opacity="a"`）哪里都认。
 */
export interface ParsedColor {
  hex: string
  alpha: number
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)
const hex2 = (n: number): string =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')

/** 一个 alpha 分量：`0.5` / `50%` */
function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1
  const s = raw.trim()
  if (s.endsWith('%')) {
    const n = Number(s.slice(0, -1))
    return Number.isFinite(n) ? clamp01(n / 100) : null
  }
  const n = Number(s)
  return Number.isFinite(n) ? clamp01(n) : null
}

/**
 * 计算值里的颜色 → 十六进制 + alpha；认不出的格式返回 null（调用方再走画布兜底）。
 *
 * 只认 Chromium 的 getComputedStyle 实际会吐出来的几种：`rgb()` / `rgba()`（逗号或空格分隔）、
 * `color(srgb r g b [/ a])`（color-mix 的结果）、`#rgb` / `#rrggbb` / `#rrggbbaa`、`transparent`。
 * oklch() / lab() 这类会原样留在计算值里的不在此列 —— 交给画布逐像素读。
 */
export function parseCssColor(value: string): ParsedColor | null {
  const v = value.trim().toLowerCase()
  if (v === 'transparent') return { hex: '#000000', alpha: 0 }

  const hex = /^#([0-9a-f]{3,8})$/.exec(v)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) {
      const [r, g, b] = [h[0], h[1], h[2]].map((c) => parseInt(c + c, 16))
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1
      return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha: a }
    }
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      return { hex: `#${h.slice(0, 6)}`, alpha: a }
    }
    return null
  }

  const rgb = /^rgba?\(\s*([^)]*)\)$/.exec(v)
  if (rgb) {
    // rgb(1, 2, 3) / rgba(1, 2, 3, 0.5) / rgb(1 2 3 / 0.5)
    const [channels, alphaPart] = rgb[1].split('/')
    const parts = channels.split(/[\s,]+/).filter(Boolean)
    const alphaRaw = alphaPart ?? (parts.length === 4 ? parts[3] : undefined)
    if (parts.length < 3) return null
    const nums = parts
      .slice(0, 3)
      .map((p) => (p.endsWith('%') ? (Number(p.slice(0, -1)) * 255) / 100 : Number(p)))
    const alpha = parseAlpha(alphaRaw)
    if (nums.some((n) => !Number.isFinite(n)) || alpha === null) return null
    return { hex: `#${nums.map(hex2).join('')}`, alpha }
  }

  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/.exec(v)
  if (srgb) {
    const [channels, alphaPart] = srgb[1].split('/')
    const parts = channels.trim().split(/\s+/).filter(Boolean)
    if (parts.length !== 3) return null
    const nums = parts.map((p) => (p.endsWith('%') ? Number(p.slice(0, -1)) / 100 : Number(p)))
    const alpha = parseAlpha(alphaPart)
    if (nums.some((n) => !Number.isFinite(n)) || alpha === null) return null
    return { hex: `#${nums.map((n) => hex2(n * 255)).join('')}`, alpha }
  }

  return null
}

/** 不透明度写成短数字：`0.14`、`1`，不出现 `0.13999999999999999` */
export function formatOpacity(n: number): string {
  // 算不出来的不透明度按不透明写：宁可颜色实一点，也不写出一个 `NaN` 让整条属性作废
  if (!Number.isFinite(n)) return '1'
  return String(Math.round(clamp01(n) * 1000) / 1000)
}

/**
 * 计算值里的 `url(...)` → `url(#id)`。
 *
 * 计算值可能带上文档地址（`url("file:///…/index.html#s1-grad")`）—— 那个地址出了 ShuviX 就
 * 指向一个不存在的文件，图里的渐变会整块丢失。片段才是这张图自己的东西。
 * 不是 url 引用就返回 null。
 */
export function fragmentUrlOf(value: string): string | null {
  const m = /^url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value.trim())
  if (!m) return null
  const hash = m[2].lastIndexOf('#')
  if (hash < 0) return null
  const id = m[2].slice(hash + 1)
  return id ? `url(#${id})` : null
}

/**
 * 文件名主干：去掉文件系统不认的字符、压空白、截长度；空了就用 fallback。
 * 与会话导出（useSessionExport 的 toFilename）同一组非法字符。
 */
/** Windows 保留的设备名：不论扩展名，叫这个的文件在那里建不出来 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

export function figureFileBase(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '')
    // 控制字符也不进文件名（换行、制表符在各平台的文件对话框里都是事故）
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 文件名里一个点开头会成隐藏文件，结尾的点在 Windows 上会被吞掉
    .replace(/^\.+|\.+$/g, '')
  // 按码点截，不按 UTF-16 单元：slice 会把一个 emoji 的代理对劈成两半
  const safe = Array.from(cleaned).slice(0, 80).join('').trim()
  if (!safe) return fallback
  return WINDOWS_RESERVED.test(safe) ? `${safe}_` : safe
}

/** 扩展名 */
export const FIGURE_EXTENSION: Record<FigureFormat, string> = {
  svg: 'svg',
  png: 'png',
  jpg: 'jpg'
}

/**
 * 位图一共最多这么多像素。Chromium 的画布单边上限 32767、面积上限约 2.68 亿，但远在那之前
 * 编码一张 PNG 就要卡好几秒、内存吃掉上百 MB —— 一张说明图到这个量级只可能是倍率选大了。
 */
export const MAX_RASTER_PIXELS = 40_000_000
/** 位图单边上限（与 Chromium 画布的单边上限留出余量） */
export const MAX_RASTER_SIDE = 16_384

/**
 * 实际用的倍率：要求的倍率放得下就照用，放不下就降到恰好放得下（不取整 —— 1.7x 也是倍率）。
 * 宽高非正时返回 0，调用方据此判「这张图没有尺寸」。
 */
export function effectiveScale(width: number, height: number, requested: number): number {
  if (!(width > 0) || !(height > 0) || !(requested > 0)) return 0
  const byArea = Math.sqrt(MAX_RASTER_PIXELS / (width * height))
  const bySide = MAX_RASTER_SIDE / Math.max(width, height)
  return Math.min(requested, byArea, bySide)
}

/** 位图的像素尺寸（至少 1×1） */
export function rasterSize(
  width: number,
  height: number,
  scale: number
): { width: number; height: number } {
  const round = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
  // 四舍五入可能让恰好卡在上限的倍率越过上限一点点（10000² 的图按 √0.4 倍：6325² > 4000 万）；
  // 越过了就改成向下取整
  if (
    round.width * round.height <= MAX_RASTER_PIXELS &&
    Math.max(round.width, round.height) <= MAX_RASTER_SIDE
  ) {
    return round
  }
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  }
}

/**
 * mermaid 源码里写的标题：frontmatter 的 `title: …`，或图类型自带的 `title …` 行。
 * 拿来当文件名；没有就 null。
 */
export function mermaidTitleOf(code: string): string | null {
  // `title: X`（frontmatter）或 `title X`（gantt / pie 等）；`title --> b` 是流程图里一个叫 title
  // 的节点连出去的边，不是标题 —— 不带冒号时，后面紧跟连线符号的不算
  // 只在**同一行**里找：`\s` 会跨过换行，`title:` 后面空着时就把下一行（frontmatter 的 `---`）
  // 读成了标题
  const m = /^[ \t]*title(?:[ \t]*:[ \t]*|[ \t]+(?![-=.~<]{2}))(.+?)[ \t]*$/im.exec(code)
  if (!m) return null
  const t = m[1].replace(/^(['"])(.*)\1$/, '$2').trim()
  return t || null
}

/** 面板偏好 —— 记住上一次的选择（按查看者，存 localStorage） */
export interface FigureExportPrefs {
  format: FigureFormat
  scheme: FigureScheme
  background: boolean
  scale: 1 | 2 | 3
}

/**
 * 缺省：当前主题 + 填充底色 + PNG 2x —— 导出来的就是卡片里看到的那张。
 * 深色主题下缺省透明的话，浅色文字贴进白底文档就看不见了。
 */
export const DEFAULT_FIGURE_PREFS: FigureExportPrefs = {
  format: 'png',
  scheme: 'current',
  background: true,
  scale: 2
}

/** 从存储里读回来的东西不可信：逐字段校验，坏的字段落回缺省 */
export function normalizeFigurePrefs(raw: unknown): FigureExportPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const format = o.format === 'svg' || o.format === 'png' || o.format === 'jpg' ? o.format : null
  const scheme =
    o.scheme === 'current' || o.scheme === 'light' || o.scheme === 'dark' ? o.scheme : null
  const scale = o.scale === 1 || o.scale === 2 || o.scale === 3 ? o.scale : null
  return {
    format: format ?? DEFAULT_FIGURE_PREFS.format,
    scheme: scheme ?? DEFAULT_FIGURE_PREFS.scheme,
    background: typeof o.background === 'boolean' ? o.background : DEFAULT_FIGURE_PREFS.background,
    scale: scale ?? DEFAULT_FIGURE_PREFS.scale
  }
}

/** JPG 没有透明通道：选了 JPG 就一定带底色 */
export function effectiveBackground(prefs: FigureExportPrefs): boolean {
  return prefs.format === 'jpg' ? true : prefs.background
}
