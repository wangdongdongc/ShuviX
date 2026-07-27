/**
 * 图表导出 —— ChartView「导出」菜单的能力核心（纯浏览器 API，桌面/扩展/WebUI 通用）。
 *
 * mermaid 产出的 SVG 直接拿去导出有两处硬伤，都在 normalizeChartSvg 里收口：
 *   - 尺寸：mermaid 出的是 `width="100%"` + `style="max-width:…px"` 且**不带 height**，
 *     直接喂 <img> 会按默认尺寸画成一小块（实测 242×665 的图被画成 55×150）；
 *     必须按 viewBox 改写 width/height 并去掉 style 才拿得到真实尺寸。
 *   - 背景：SVG 背景是透明的（预览里的底色来自 ChartView 的卡片 div，不在 SVG 内），
 *     而暗色主题渲染的是浅色文字 —— 不烘一层背景，导出物贴进白底文档等于隐形。
 *
 * 改写一律走 DOM + XMLSerializer，绝不做字符串拼接：<img> 加载 SVG 时按**严格 XML** 解析，
 * 属性重复（例如往已有 width 的 <svg> 上再拼一个 width）会让 img 静默 onerror，
 * 表现就是「导出一片空白」而没有任何报错。
 *
 * 标签是 <foreignObject> 里的 HTML（mermaid 默认 htmlLabels），Chromium 的 <img> → canvas
 * 路径可以正常光栅化；SVG 自包含（内联主题 CSS、无外部资源引用），canvas 也不会被污染。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** PNG 导出倍率（2x：贴进文档/幻灯片放大不糊，体积仍可控） */
export const CHART_PNG_SCALE = 2

export interface NormalizedChartSvg {
  /** 可独立打开 / 可栅格化的 SVG 文本 */
  xml: string
  /** CSS 像素尺寸（取自 viewBox，向上取整） */
  width: number
  height: number
  /** 烘进 SVG 的背景色；栅格化时同样用它先铺满画布（见 rasterizeChartSvg） */
  background: string
}

/** 取长度属性的像素值；百分比（mermaid 的 width="100%"）不可用，返回 0 交给下一级兜底 */
function attrPx(value: string | null): number {
  if (!value || value.trim().endsWith('%')) return 0
  const n = parseFloat(value)
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0
}

/** 规范化 mermaid SVG：写死真实宽高、去掉 max-width、按主题烘背景 */
export function normalizeChartSvg(svg: string, background: string): NormalizedChartSvg {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const parseError = doc.querySelector('parsererror')
  if (parseError) throw new Error(parseError.textContent?.trim() || 'invalid chart svg')
  const root = doc.documentElement

  const vb = (root.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  const hasViewBox = vb.length === 4 && vb.every((n) => Number.isFinite(n))
  const [minX, minY, vbW, vbH] = hasViewBox ? vb : [0, 0, 0, 0]
  const width = Math.ceil(vbW) || attrPx(root.getAttribute('width')) || 800
  const height = Math.ceil(vbH) || attrPx(root.getAttribute('height')) || 600

  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  // max-width 会让 <img> 按更小的尺寸绘制；宽高既已写死，这条样式只会碍事
  root.removeAttribute('style')

  // 背景铺满 viewport（百分比按 viewBox 尺寸解析），故起点取 viewBox 原点而非 0
  const rect = doc.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', String(minX))
  rect.setAttribute('y', String(minY))
  rect.setAttribute('width', '100%')
  rect.setAttribute('height', '100%')
  rect.setAttribute('fill', background)
  root.insertBefore(rect, root.firstChild)

  return { xml: new XMLSerializer().serializeToString(doc), width, height, background }
}

function loadSvgImage(xml: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    // 失败几乎只有一个原因：SVG 不是良构 XML（见文件头说明）
    img.onerror = () => reject(new Error('chart svg failed to load as an image'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
  })
}

/** 栅格化为 PNG Blob（scale 倍超采样） */
export async function rasterizeChartSvg(
  svg: NormalizedChartSvg,
  scale: number = CHART_PNG_SCALE
): Promise<Blob> {
  const img = await loadSvgImage(svg.xml)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(svg.width * scale))
  canvas.height = Math.max(1, Math.round(svg.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.scale(scale, scale)
  // 先铺底再画图：mermaid 的 viewBox 尺寸是小数（如 241.98×664.60），画布必须取整，
  // preserveAspectRatio 等比适配后四周会留下不足 1px 的空隙 —— 只靠 SVG 里的背景矩形，
  // 导出的 PNG 边缘会是半透明的一圈（实测角点 alpha=164）
  ctx.fillStyle = svg.background
  ctx.fillRect(0, 0, svg.width, svg.height)
  ctx.drawImage(img, 0, 0, svg.width, svg.height)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      'image/png'
    )
  })
}

export function svgBlob(xml: string): Blob {
  return new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
}

/** 由图表文件路径推导导出文件名（同名换扩展名）；无路径时退化为 chart.<ext> */
export function chartExportName(path: string | undefined, ext: 'png' | 'svg'): string {
  const base = (path ?? '').split(/[/\\]/).pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '') || 'chart'
  return `${stem}.${ext}`
}

/** 同目录同名的建议保存路径（宿主保存对话框的 defaultPath） */
export function chartExportPath(path: string | undefined, ext: 'png' | 'svg'): string {
  const name = chartExportName(path, ext)
  if (!path) return name
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx < 0 ? name : path.slice(0, idx + 1) + name
}

/** 剪贴板能否写图片：非安全上下文（局域网 http 分享）下 navigator.clipboard 不存在 */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function'
}

export async function copyImageToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

/** 浏览器原生下载 —— 无宿主保存能力时的兜底（扩展 / 纯渠道端 WebUI） */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Blob → base64（走 IPC 落盘用；分片避免 String.fromCharCode 爆栈） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
