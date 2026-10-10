/**
 * 图导出 e2e 的夹具 —— 落盘、剪贴板、读产物、读像素、取色。
 *
 * 不碰应用的 DOM 选择器（那些在 pages.ts 的 figureCardPane / notebookFigurePane / figureExportPanel）；
 * 这里只有三类东西：
 *
 *  1. **扮演系统的两个出口**：
 *     - `armDownloads` —— CDP `Page.setDownloadBehavior({ behavior: 'allow' })` 把「下载」改成直接写进
 *       一个临时目录。不设的话 Electron 主会话没有 will-download 拦截，`<a download>` 一击就是原生
 *       「另存为」面板，e2e 关不掉、整个文件挂死 —— 所以**每个 spec 先跑 FE-0 那条冒烟**；
 *     - `clipboardCapture` —— 页内顶掉 `navigator.clipboard.write`、记下真的 `ClipboardItem`。真写
 *       系统剪贴板会冲掉跑 e2e 那台机器上用户自己的剪贴板（与 knowledge-sidebar 的「复制路径」同一条理由）。
 *  2. **读产物**（在页面里用浏览器自己的解析器，不经产品代码）：`svgFileFacts` 按 XML 解析导出的 SVG、
 *     沿祖先链算出每个 `data-k` 元素实际生效的颜色 / 不透明度；`rasterFacts` 把位图（或 SVG）画到画布上
 *     读像素；`cssColorIn` 在挂着某套主题的探针里解析一段 CSS 颜色。
 *  3. **node 侧的纯解析**：PNG 的 IHDR、JPEG 的 SOF、计算值里的颜色串、背景色合成 —— 与产品的
 *     parseCssColor 各写各的，免得两边错在一起时互相作证。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, until, type CdpClient } from './cdp'

// ─── 落盘 ─────────────────────────────────────────────────

export interface DownloadDir {
  dir: string
  /** 等某个文件写完（目录里没有 .crdownload、大小连续两次不变）并读回来 */
  waitFile(name: string, timeoutMs?: number): Promise<Buffer>
  /** 目录里此刻的文件名（不含下载中的临时文件） */
  files(): string[]
  /** 清空目录（同名文件再下一次会被浏览器改名成 `x (1).png`） */
  clear(): void
  /** 删掉整个目录 */
  dispose(): void
}

/**
 * 把这个页面的「下载」改成直接落进一个临时目录。连接（`main`）断了覆盖就没了 —— spec 全程用同一个
 * CdpClient，beforeAll 里调一次即可。
 */
export async function armDownloads(main: CdpClient): Promise<DownloadDir> {
  const dir = mkdtempSync('/private/tmp/shuvix-e2e-dl-')
  await main.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir })
  const files = (): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.crdownload')) : []
  return {
    dir,
    files,
    waitFile: async (name, timeoutMs = 20_000) => {
      const path = join(dir, name)
      let lastSize = -1
      await until(
        async () => {
          if (!existsSync(path)) return false
          if (readdirSync(dir).some((f) => f.endsWith('.crdownload'))) return false
          const size = statSync(path).size
          const stable = size > 0 && size === lastSize
          lastSize = size
          if (!stable) await sleep(50)
          return stable
        },
        `download ${JSON.stringify(name)} in ${dir} (have: ${JSON.stringify(files())})`,
        timeoutMs,
        { intervalMs: 100 }
      )
      return readFileSync(path)
    },
    clear: () => {
      for (const f of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, f), { force: true })
    },
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}

// ─── 剪贴板 ───────────────────────────────────────────────

/** 写进（假）剪贴板的那一项 */
export interface ClipboardShot {
  /** ClipboardItem.types */
  types: string[]
  /** image/png 那一项解码后的像素尺寸 */
  width: number
  height: number
  size: number
  mime: string
}

export interface ClipboardCapture {
  /** 顶掉 navigator.clipboard.write（幂等；装一次整个文件有效） */
  install(): Promise<void>
  clear(): Promise<void>
  /** 等下一次写入并解出 PNG 的尺寸 */
  wait(timeoutMs?: number): Promise<ClipboardShot>
  /** 此刻是否已有写入 */
  captured(): Promise<boolean>
}

export function clipboardCapture(main: CdpClient): ClipboardCapture {
  return {
    install: async () => {
      await main.eval(`(() => {
        window.__figClip = null
        Object.defineProperty(navigator.clipboard, 'write', {
          configurable: true,
          value: (items) => {
            window.__figClip = { types: items.map((i) => [...i.types]), item: items[0], count: items.length }
            return Promise.resolve()
          }
        })
        return true
      })()`)
    },
    clear: async () => {
      await main.eval(`(() => { window.__figClip = null; return true })()`)
    },
    captured: () => main.eval<boolean>(`!!window.__figClip`),
    wait: (timeoutMs = 15_000) =>
      until(
        () =>
          main.eval<ClipboardShot | null>(`(async () => {
            const c = window.__figClip
            if (!c) return null
            const blob = await c.item.getType('image/png')
            const bmp = await createImageBitmap(blob)
            return { types: c.types[0], width: bmp.width, height: bmp.height, size: blob.size, mime: blob.type }
          })()`),
        'an image written to the clipboard',
        timeoutMs
      )
  }
}

// ─── 颜色（node 侧，独立于产品的解析） ─────────────────────

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0…1 */
  a: number
}

/**
 * Chromium 计算值里的颜色串 → 0…255 的分量 + alpha。只认计算值实际会出现的三种：
 * `rgb()` / `rgba()`（逗号或空格）、`color(srgb r g b [/ a])`；`transparent` 也认。认不出抛。
 */
export function parseComputedColor(value: string): Rgba {
  const v = value.trim().toLowerCase()
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const num = (s: string, scale: number): number =>
    s.endsWith('%') ? (Number(s.slice(0, -1)) / 100) * scale : Number(s)
  let m = /^rgba?\((.*)\)$/.exec(v)
  if (m) {
    const [ch, al] = m[1].split('/')
    const parts = ch.split(/[\s,]+/).filter(Boolean)
    const alpha = al ?? parts[3]
    const out = {
      r: num(parts[0], 255),
      g: num(parts[1], 255),
      b: num(parts[2], 255),
      a: alpha === undefined ? 1 : num(alpha.trim(), 1)
    }
    if ([out.r, out.g, out.b, out.a].every(Number.isFinite)) return out
  }
  m = /^color\(srgb\s+(.*)\)$/.exec(v)
  if (m) {
    const [ch, al] = m[1].split('/')
    const parts = ch.trim().split(/\s+/)
    const out = {
      r: num(parts[0], 1) * 255,
      g: num(parts[1], 1) * 255,
      b: num(parts[2], 1) * 255,
      a: al === undefined ? 1 : num(al.trim(), 1)
    }
    if ([out.r, out.g, out.b, out.a].every(Number.isFinite)) return out
  }
  throw new Error(`unparseable computed color: ${value}`)
}

/** `#rrggbb` → 分量 */
export function hexRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`not #rrggbb: ${hex}`)
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

/** 分量 → `#rrggbb`（四舍五入） */
export function rgbHex(c: { r: number; g: number; b: number }): string {
  return `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/** 两色每个分量之差的最大值 */
export function channelDelta(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b))
}

/** src 按 alpha 叠在不透明的 dst 上（伽马编码空间里按分量线性 —— 浏览器合成背景的方式） */
export function over(src: Rgba, dst: { r: number; g: number; b: number }): Rgba {
  return {
    r: src.r * src.a + dst.r * (1 - src.a),
    g: src.g * src.a + dst.g * (1 - src.a),
    b: src.b * src.a + dst.b * (1 - src.a),
    a: 1
  }
}

/**
 * 一串背景色（从最里层到最外层，计算值）合成成看到的那个颜色：从最外层往里叠，最外层之下垫白
 * （窗口底色；实际总会先遇到一层不透明的）。
 */
export function compositeStack(innerToOuter: string[]): Rgba {
  let acc: Rgba = { r: 255, g: 255, b: 255, a: 1 }
  for (const css of [...innerToOuter].reverse()) acc = over(parseComputedColor(css), acc)
  return acc
}

/** 在挂着某套主题的探针里解析一段 CSS 颜色（themeId 为空 = 沿用根上的主题） */
export async function cssColorIn(main: CdpClient, themeId: string, css: string): Promise<Rgba> {
  const raw = await main.eval<string>(`(() => {
    const wrap = document.createElement('div')
    ${themeId ? `wrap.setAttribute('data-theme', ${JSON.stringify(themeId)})` : ''}
    wrap.style.cssText = 'position:fixed;left:-10000px;top:0'
    const probe = document.createElement('span')
    probe.style.color = ${JSON.stringify(css)}
    wrap.appendChild(probe)
    document.body.appendChild(wrap)
    const color = getComputedStyle(probe).color
    wrap.remove()
    return color
  })()`)
  return parseComputedColor(raw)
}

/** 卡片底（对话图卡）与页面底（笔记本）的配方 —— 与 themes / 卡片源码里写的同一个式子 */
export const CARD_SURFACE_CSS =
  'color-mix(in srgb, var(--theme-bg-tertiary) 60%, var(--theme-bg-primary))'
export const PAGE_SURFACE_CSS = 'var(--theme-bg-primary)'

// ─── 读导出的 SVG（在页面里按 XML 解析） ────────────────────

/** 一个 data-k 元素在导出文件里**实际生效**的绘制属性（继承项沿祖先链取，非继承项只看自己） */
export interface ExportedPaint {
  fill: string | null
  fillOpacity: string | null
  stroke: string | null
  strokeOpacity: string | null
  stopColor: string | null
  stopOpacity: string | null
  opacity: string | null
  style: string | null
}

export interface SvgFileFacts {
  parseError: boolean
  rootTag: string
  ns: string | null
  width: string | null
  height: string | null
  viewBox: string | null
  id: string | null
  rootStyle: string | null
  perK: Record<string, ExportedPaint>
  /** 文件里所有 fill / stroke / stop-color / flood-color 属性值 */
  paints: string[]
  /** 根的第一个子元素 */
  first: { tag: string; attrs: Record<string, string> } | null
  /** 带 id 的元素 */
  ids: Array<{ id: string; tag: string }>
  /** 有没有 <style> 元素、它的文本 */
  styleText: string
}

export function svgFileFacts(main: CdpClient, text: string): Promise<SvgFileFacts> {
  return main.eval<SvgFileFacts>(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(text)}, 'image/svg+xml')
    const root = doc.documentElement
    const inherited = (el, name) => {
      for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
        if (e.hasAttribute(name)) return e.getAttribute(name)
      }
      return null
    }
    const perK = {}
    for (const el of root.querySelectorAll('[data-k]')) {
      perK[el.getAttribute('data-k')] = {
        fill: inherited(el, 'fill'),
        fillOpacity: inherited(el, 'fill-opacity'),
        stroke: inherited(el, 'stroke'),
        strokeOpacity: inherited(el, 'stroke-opacity'),
        stopColor: el.getAttribute('stop-color'),
        stopOpacity: el.getAttribute('stop-opacity'),
        opacity: el.getAttribute('opacity'),
        style: el.getAttribute('style')
      }
    }
    const paints = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const a of ['fill', 'stroke', 'stop-color', 'flood-color']) {
        if (el.hasAttribute(a)) paints.push(el.getAttribute(a))
      }
    }
    const first = root.firstElementChild
    return {
      parseError: doc.getElementsByTagName('parsererror').length > 0,
      rootTag: root.tagName,
      ns: root.namespaceURI,
      width: root.getAttribute('width'),
      height: root.getAttribute('height'),
      viewBox: root.getAttribute('viewBox'),
      id: root.getAttribute('id'),
      rootStyle: root.getAttribute('style'),
      perK,
      paints,
      first: first
        ? { tag: first.tagName, attrs: Object.fromEntries([...first.attributes].map((a) => [a.name, a.value])) }
        : null,
      ids: [...root.querySelectorAll('[id]')].map((e) => ({ id: e.getAttribute('id'), tag: e.tagName })),
      styleText: [...root.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\\n')
    }
  })()`)
}

/**
 * 导出的 mermaid SVG 挂进一个 shadow root（它自带的 `<style>` 只在那里面生效，不污染页面、
 * 也不吃页面的样式），读第一个节点形状的 fill 与第一个节点在用户坐标里的框。
 */
export function mermaidFileFacts(
  main: CdpClient,
  text: string
): Promise<{ nodeFill: string; nodeBox: { x: number; y: number; width: number; height: number } }> {
  return main.eval(`(async () => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-20000px;top:0'
    document.body.appendChild(host)
    try {
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML = ${JSON.stringify(text.replace(/^<\?xml[^>]*>\s*/, ''))}
      const svg = shadow.querySelector('svg')
      const shape = [...svg.querySelectorAll('.node rect, .node path, .node polygon, .node circle')]
        .find((el) => { const f = getComputedStyle(el).fill; return !!f && f !== 'none' })
      const node = shape.closest('.node')
      const sr = svg.getBoundingClientRect()
      const nr = node.getBoundingClientRect()
      const vb = svg.viewBox.baseVal
      const kx = vb.width / sr.width
      const ky = vb.height / sr.height
      return {
        nodeFill: getComputedStyle(shape).fill,
        nodeBox: {
          x: vb.x + (nr.left - sr.left) * kx,
          y: vb.y + (nr.top - sr.top) * ky,
          width: nr.width * kx,
          height: nr.height * ky
        }
      }
    } finally {
      host.remove()
    }
  })()`)
}

// ─── 读像素 ───────────────────────────────────────────────

export interface RasterFacts {
  width: number
  height: number
  /** 按 points 顺序的像素（0…255，alpha 也是 0…255） */
  pixels: Array<{ r: number; g: number; b: number; a: number }>
  /** region 里的统计（给了 region 才有） */
  region?: { distinct: number; maxDelta: number }
}

/**
 * 把一个图像文件（PNG / JPEG / SVG）按自然尺寸画到画布上读像素。`points` / `region` 是**图像像素**
 * 坐标；region 统计的是与区域内第一个像素相比的最大分量差、以及不同颜色的个数。
 */
export function rasterFacts(
  main: CdpClient,
  file: { mime: string; data: Buffer | string },
  opts: {
    points?: Array<[number, number]>
    region?: { x: number; y: number; width: number; height: number }
  } = {}
): Promise<RasterFacts> {
  const b64 = Buffer.isBuffer(file.data)
    ? file.data.toString('base64')
    : Buffer.from(file.data, 'utf8').toString('base64')
  return main.eval<RasterFacts>(`(async () => {
    const img = new Image()
    img.src = 'data:${file.mime};base64,${b64}'
    await img.decode()
    const w = img.naturalWidth
    const h = img.naturalHeight
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)
    const at = ([x, y]) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
      return { r: d[0], g: d[1], b: d[2], a: d[3] }
    }
    const out = { width: w, height: h, pixels: ${JSON.stringify(opts.points ?? [])}.map(at) }
    const region = ${JSON.stringify(opts.region ?? null)}
    if (region) {
      const x = Math.max(0, Math.floor(region.x))
      const y = Math.max(0, Math.floor(region.y))
      const rw = Math.max(1, Math.min(w - x, Math.floor(region.width)))
      const rh = Math.max(1, Math.min(h - y, Math.floor(region.height)))
      const d = ctx.getImageData(x, y, rw, rh).data
      const seen = new Set()
      let maxDelta = 0
      for (let i = 0; i < d.length; i += 4) {
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
        maxDelta = Math.max(maxDelta, Math.abs(d[i] - d[0]), Math.abs(d[i + 1] - d[1]), Math.abs(d[i + 2] - d[2]))
      }
      out.region = { distinct: seen.size, maxDelta }
    }
    return out
  })()`)
}

// ─── 文件头（node 侧） ─────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 魔数对、IHDR 里的宽高 */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(`not a PNG (head ${buf.subarray(0, 8).toString('hex')})`)
  }
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('PNG without IHDR first')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** JPEG 魔数对（FF D8 FF）、第一个 SOF 段里的宽高 */
export function jpegSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    throw new Error(`not a JPEG (head ${buf.subarray(0, 4).toString('hex')})`)
  }
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`JPEG marker expected at ${i}`)
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    i += 2 + len
  }
  throw new Error('JPEG without SOF')
}
