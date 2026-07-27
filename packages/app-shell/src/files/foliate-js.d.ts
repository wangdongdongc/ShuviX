/**
 * foliate-js 的最小类型声明 —— 该包不带 .d.ts，npm 上也没有 @types。
 *
 * 只声明 EbookView 实际用到的那一小块：EPUB 解析器的注入式 loader 契约 + 章节/目录/元数据。
 * 刻意不覆盖 view.js / paginator.js —— 那层用的是 `sandbox="allow-same-origin allow-scripts"`
 * （等于没有沙箱），我们只取解析能力，渲染自己做。
 */
declare module 'foliate-js/epub.js' {
  /** 目录项（EPUB3 nav / EPUB2 NCX 统一后的形态），可嵌套 */
  export interface TocItem {
    label?: string
    href?: string
    subitems?: TocItem[]
  }

  /** spine 中的一节 —— createDocument() 返回**未改写**的原始相对路径 DOM（我们据此自行重写资源） */
  export interface Section {
    id: string
    createDocument: () => Promise<Document>
    /** 把节内相对 href 解析为压缩包内路径 */
    resolveHref: (href: string) => string
    size: number
    linear?: string
  }

  export interface EPUBMetadata {
    title?: string | { [k: string]: string }
    language?: string | string[]
    author?: unknown
  }

  export class EPUB {
    constructor(loader: {
      /** 按包内路径读文本；不存在返回 null */
      loadText: (name: string) => string | null | Promise<string | null>
      /** 按包内路径读二进制 */
      loadBlob: (name: string) => Blob | null | Promise<Blob | null>
      getSize: (name: string) => number
    })
    init(): Promise<EPUB>
    sections: Section[]
    toc?: TocItem[]
    metadata?: EPUBMetadata
  }
}

declare module 'foliate-js/fb2.js' {
  /** FB2 归一后的书本形状 —— 与 EPUB 同构（sections/toc/metadata） */
  export function makeFB2(blob: Blob): Promise<{
    metadata?: { title?: string; language?: string }
    sections: { createDocument: () => Document; size: number; linear?: string }[]
    toc?: { label?: string; href?: string }[]
  }>
}
