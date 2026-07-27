/**
 * 电子书加载器 —— 把各格式归一成同一个 LoadedBook，EbookView 只认这一个形状。
 *
 * 归一化的本钱来自 foliate-js：它的各解析器都收敛到 `sections[].createDocument()` + `toc`，
 * 所以加一个格式基本只是加一个 loader，视图层一行不动。
 *
 * 共同的硬约束是**资源必须落成 data:**：渲染器 CSP 的 img-src / style-src 都不含 blob:，
 * 而 foliate 的原生资源管线走的正是 blob:（实测父文档层面就加载不了，与沙箱无关）。
 * 所幸各解析器的 `createDocument()` 都返回**未做资源替换**的原始 DOM，替换由调用方自己做 ——
 * 这就是下面每个 loader 里那段重写的由来。
 */

import type { TocItem } from 'foliate-js/epub.js'

/** 视图层唯一认识的书本形状 */
export interface LoadedBook {
  title: string
  chapterCount: number
  toc: TocEntry[]
  /** 渲染第 index 章 → 可直接喂给 iframe srcdoc 的完整文档 */
  renderChapter: (index: number) => Promise<string>
}

export interface TocEntry {
  label: string
  index: number
  depth: number
}

/** 章节文档注入的 CSP：只放行我们自己内联进去的东西，掐死一切外部请求 */
const CHAPTER_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:"

/** 章节基础排版。书自己的样式在其后，可覆盖这些默认值 */
const BASE_STYLE =
  'html,body{margin:0;padding:16px 20px;background:#fff;color:#1a1a1a;' +
  'font-size:15px;line-height:1.7;word-wrap:break-word}' +
  'img,svg,video{max-width:100%;height:auto}' +
  'body>img,section>img{display:block;margin:auto}'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

export function extOf(p: string): string {
  const name = p.split('/').pop() ?? ''
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

/** 把相对 href 按 base 文件所在目录解析成包内路径（去掉 query/fragment） */
export function resolveZipPath(basePath: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0]
  if (!clean) return ''
  const baseDir = basePath.slice(0, basePath.lastIndexOf('/') + 1)
  const parts = `${baseDir}${clean}`.split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK)
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

function dataUrl(bytes: Uint8Array, path: string): string {
  return `data:${MIME_BY_EXT[extOf(path)] ?? 'application/octet-stream'};base64,${bytesToBase64(bytes)}`
}

/**
 * 章节里允许出现的 URL。
 *
 * 刻意不复用 chat-protocol 的 isSafeSvgUrl：两者威胁模型不同。那份服务的是**直接注入页面
 * DOM** 的 mermaid SVG，所以连 data:image/svg+xml 都拒（SVG 可载脚本）；章节这边内容跑在
 * 沙箱 iframe 里，且所有 data: URL 都是我们自己按包内资源铸的，`<img src="data:image/svg+xml">`
 * 处在图像上下文（脚本不执行）—— 一并拒掉只会误伤大量以 SVG 作封面的书。
 * 共享一份「策略」而非「机制」正是这类白名单最容易出错的地方，故各自定义。
 */
function isSafeChapterUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase()
  if (v === '' || v.startsWith('#')) return true
  if (v.startsWith('data:image/') || v.startsWith('data:font/')) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v)
  if (!scheme) return true // 相对路径
  return scheme[1] === 'http' || scheme[1] === 'https' || scheme[1] === 'mailto'
}

/**
 * 收尾：摘掉脚本与外链样式表、剥离危险 URL/事件处理器、注入 CSP 与基础排版、序列化。
 * 所有格式共用 —— 沙箱之外的第二层防护统一在这里，不散落到各 loader。
 */
function finalizeDoc(doc: Document): string {
  for (const s of Array.from(doc.querySelectorAll('script'))) s.remove()
  // 外链样式表一律摘除：blob:/http: 在章节 CSP 下都拿不到，留着只会报错
  for (const l of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
    if (!(l.getAttribute('href') ?? '').startsWith('data:')) l.remove()
  }
  // 危险 URL 与事件处理器就地剥离。沙箱与章节 CSP 已经各拦一道（实测 javascript: 锚点
  // 点了不执行），但书里的链接是不可信内容 —— 能摘掉就不该只靠容器兜着。
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i]
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if (
        (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'l:href') &&
        !isSafeChapterUrl(attr.value)
      ) {
        el.removeAttribute(attr.name)
      }
    }
  }
  const head = doc.head ?? doc.documentElement
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', CHAPTER_CSP)
  head.insertBefore(meta, head.firstChild)
  const base = doc.createElement('style')
  base.textContent = BASE_STYLE
  head.insertBefore(base, meta.nextSibling)
  return new XMLSerializer().serializeToString(doc)
}

/** CSS 里的 url(...) 落成 data:，否则内嵌字体与背景图全丢 */
function inlineCssUrls(
  css: string,
  cssPath: string,
  lookup: (p: string) => Uint8Array | undefined
): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _q, ref: string) => {
    if (/^(data|https?):/i.test(ref)) return whole
    const target = resolveZipPath(cssPath, ref)
    const bytes = target ? lookup(target) : undefined
    return bytes ? `url("${dataUrl(bytes, target)}")` : whole
  })
}

/** EPUB —— zip + foliate 解析；资源按包内路径查表重写 */
async function loadEpub(bytes: Uint8Array): Promise<LoadedBook> {
  const [{ unzipSync, strFromU8 }, { EPUB }] = await Promise.all([
    import('fflate'),
    import('foliate-js/epub.js')
  ])
  const files = unzipSync(bytes)
  const get = (name: string): Uint8Array | undefined => files[name.replace(/^\//, '')]

  const epub = new EPUB({
    loadText: (name) => {
      const b = get(name)
      return b ? strFromU8(b) : null
    },
    loadBlob: (name) => {
      const b = get(name)
      return b ? new Blob([b as unknown as BlobPart]) : null
    },
    getSize: (name) => get(name)?.length ?? 0
  })
  await epub.init()

  const toc: TocEntry[] = []
  const walk = (items: TocItem[], depth: number): void => {
    for (const it of items) {
      const target = (it.href ?? '').split('#')[0]
      const idx = epub.sections.findIndex((s) => s.id === target)
      if (idx >= 0 && it.label) toc.push({ label: it.label.trim(), index: idx, depth })
      if (it.subitems?.length) walk(it.subitems, depth + 1)
    }
  }
  if (epub.toc) walk(epub.toc, 0)

  const rawTitle = epub.metadata?.title
  return {
    title: typeof rawTitle === 'string' ? rawTitle : (Object.values(rawTitle ?? {})[0] ?? ''),
    chapterCount: epub.sections.length,
    toc,
    renderChapter: async (index) => {
      const section = epub.sections[index]
      const doc = await section.createDocument()
      const base = section.id

      for (const el of Array.from(doc.querySelectorAll('img[src]'))) {
        const src = el.getAttribute('src') ?? ''
        if (/^(data|https?):/i.test(src)) continue
        const target = resolveZipPath(base, src)
        const b = target ? get(target) : undefined
        if (b) el.setAttribute('src', dataUrl(b, target))
        else el.removeAttribute('src')
      }
      for (const el of Array.from(doc.querySelectorAll('image'))) {
        const attr = el.hasAttribute('href') ? 'href' : 'xlink:href'
        const src = el.getAttribute(attr) ?? ''
        if (!src || /^(data|https?):/i.test(src)) continue
        const target = resolveZipPath(base, src)
        const b = target ? get(target) : undefined
        if (b) el.setAttribute(attr, dataUrl(b, target))
      }
      // 外链 CSS → 内联 <style>（style-src 不放行 data: 样式表，必须内联）
      for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
        const cssPath = resolveZipPath(base, link.getAttribute('href') ?? '')
        const b = get(cssPath)
        if (!b) continue
        const style = doc.createElement('style')
        style.textContent = inlineCssUrls(new TextDecoder().decode(b), cssPath, get)
        link.replaceWith(style)
      }
      for (const style of Array.from(doc.querySelectorAll('style'))) {
        if (style.textContent) style.textContent = inlineCssUrls(style.textContent, base, get)
      }
      return finalizeDoc(doc)
    }
  }
}

/**
 * FB2 —— 单个 XML，内嵌资源本就是 base64（<binary> 元素），createDocument() 出来的图片
 * 已经是 data:，无需重写。唯一要处理的是模板里那条指向 blob: 的样式表链接（finalizeDoc 摘掉）。
 */
async function loadFb2(bytes: Uint8Array): Promise<LoadedBook> {
  const { makeFB2 } = await import('foliate-js/fb2.js')
  const book = await makeFB2(new Blob([bytes as unknown as BlobPart]))
  const rawTitle = book.metadata?.title
  const toc: TocEntry[] = (book.toc ?? [])
    .map((it, i) => ({ label: (it.label ?? '').trim(), index: i, depth: 0 }))
    .filter((it) => it.label)
  return {
    title: typeof rawTitle === 'string' ? rawTitle : '',
    chapterCount: book.sections.length,
    toc,
    renderChapter: async (index) => finalizeDoc(await book.sections[index].createDocument())
  }
}

/**
 * CBZ —— 就是一包按文件名排序的图片，没必要动用 foliate 的 comic-book.js
 * （它把每页封装成 blob: 页面，在我们的 CSP 下加载不了）。一页一节，图片直出 data:。
 */
async function loadCbz(bytes: Uint8Array): Promise<LoadedBook> {
  const { unzipSync } = await import('fflate')
  const files = unzipSync(bytes)
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'])
  // 自然序：page2 要排在 page10 前面，纯字典序会错
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const pages = Object.keys(files)
    .filter((n) => IMAGE_EXTS.has(extOf(n)) && !n.split('/').pop()?.startsWith('.'))
    .sort(collator.compare)
  if (!pages.length) throw new Error('No image pages in archive')

  return {
    title: '',
    chapterCount: pages.length,
    toc: [],
    renderChapter: async (index) => {
      const name = pages[index]
      const doc = document.implementation.createHTMLDocument('')
      const img = doc.createElement('img')
      img.setAttribute('src', dataUrl(files[name], name))
      img.setAttribute('alt', name)
      // 单页漫画：整页居中铺满，不留白边
      const pageStyle = doc.createElement('style')
      pageStyle.textContent =
        'html,body{margin:0;padding:0;background:#111;height:100%}' +
        'img{display:block;margin:auto;max-width:100%;max-height:100vh;object-fit:contain}'
      doc.head.appendChild(pageStyle)
      doc.body.appendChild(img)
      return finalizeDoc(doc)
    }
  }
}

/** 按 kind 分发。新增格式只需在此加一行 + 一个 loader。 */
export function loadBook(kind: 'epub' | 'fb2' | 'cbz', bytes: Uint8Array): Promise<LoadedBook> {
  if (kind === 'epub') return loadEpub(bytes)
  if (kind === 'fb2') return loadFb2(bytes)
  return loadCbz(bytes)
}
