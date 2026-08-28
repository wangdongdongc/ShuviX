/**
 * EbookView —— 电子书预览（桌面 / 扩展两端共用，纯浏览器端解析，无后端转换）
 *
 * 本文件只管**视图**：取字节、章节导航、目录、沙箱渲染。各格式的解析与资源内联
 * 全在 ebookLoaders.ts，归一成同一个 LoadedBook —— 加格式不用动这里。
 *
 * 取字节走 useMediaUrl（桌面 shuvix-preview:// 带 Range，扩展 blob:）再 fetch，
 * 刻意不走 Office 那套 base64 过 IPC：图文书几十 MB，传过去还白涨 33%。
 *
 * 安全边界：章节喂给 `sandbox="allow-same-origin"` 的 iframe，**不给 allow-scripts** ——
 * 实测 <script> / onerror / onload 全部不执行。给 allow-same-origin 是为了让内联 <style>
 * 与 data: 资源按同源规则正常生效。loader 侧再叠一条章节级 CSP 掐掉外链回传
 * （父级 CSP 允许 img-src https:，不叠这层书里可以发信标）。
 *
 * 刻意不用 foliate 自带的 view/paginator：它们用 `sandbox="allow-same-origin allow-scripts"`，
 * 两个一起等于没有沙箱 —— 在暴露 window.api 的渲染进程里不可接受。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronLeft, ChevronRight, List, Loader2 } from 'lucide-react'
import { useMediaUrl } from '@shuvix/chat-ui'
import { loadBook, type LoadedBook } from './ebookLoaders'

interface EbookViewProps {
  path: string
  sessionId: string
  /** 解析器路由（内核按扩展名判定） */
  ebookKind: 'epub' | 'fb2' | 'cbz'
}

interface Chapter {
  html: string
  index: number
}

export function EbookView({ path, sessionId, ebookKind }: EbookViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const url = useMediaUrl(sessionId, path)
  const [book, setBook] = useState<LoadedBook | null>(null)
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  // —— 取字节 + 解析（路径/格式变化时重来）——
  useEffect(() => {
    if (!url) return
    let cancelled = false
    // 路径/格式切换时立即回到 loading 态；不引发额外副作用
    setBook(null) // eslint-disable-line react-hooks/set-state-in-effect
    setChapter(null)
    setError(null)
    ;(async () => {
      const buf = await (await fetch(url)).arrayBuffer()
      if (cancelled) return
      const loaded = await loadBook(ebookKind, new Uint8Array(buf))
      if (cancelled) return
      if (loaded.chapterCount === 0) throw new Error('Book has no readable sections')
      // 首章与书本一并落地 —— 不留「书就绪但无章节」的中间态，省一轮渲染
      const html = await loaded.renderChapter(0)
      if (cancelled) return
      setBook(loaded)
      setChapter({ html, index: 0 })
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      cancelled = true
    }
  }, [url, ebookKind])

  const openChapter = useCallback(async (index: number, loaded: LoadedBook) => {
    if (index < 0 || index >= loaded.chapterCount) return
    const html = await loaded.renderChapter(index)
    setChapter({ html, index })
    frameRef.current?.contentWindow?.scrollTo(0, 0)
  }, [])

  const chapterLabel = useMemo(() => {
    if (!book || !chapter) return ''
    const hit = book.toc.find((it) => it.index === chapter.index)
    return hit?.label ?? `${chapter.index + 1} / ${book.chapterCount}`
  }, [book, chapter])

  if (error != null) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-xs text-text-tertiary">
        <AlertCircle size={20} className="text-text-tertiary/70" />
        <span>{t('panel.preview.error')}</span>
        <span className="text-text-tertiary/70 max-w-[80%] text-center break-all">{error}</span>
      </div>
    )
  }
  if (!book || !chapter) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary/50">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }

  const canPrev = chapter.index > 0
  const canNext = chapter.index < book.chapterCount - 1

  return (
    <div className="flex flex-col h-full">
      {/* 章节工具条：目录开关 + 当前章节 + 上/下一章 */}
      <div className="flex-shrink-0 flex items-center gap-1 px-2 h-7 border-b border-border-secondary/30">
        {book.toc.length > 0 && (
          <button
            onClick={() => setTocOpen((v) => !v)}
            className={[
              'p-1 rounded hover:bg-bg-hover/40 transition-colors flex-shrink-0',
              tocOpen
                ? 'text-accent bg-bg-hover/30'
                : 'text-text-tertiary hover:text-text-secondary'
            ].join(' ')}
            title={t('panel.preview.ebookToc')}
          >
            <List size={11} />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] text-text-tertiary" title={book.title}>
          {chapterLabel}
        </span>
        <button
          onClick={() => void openChapter(chapter.index - 1, book)}
          disabled={!canPrev}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 disabled:opacity-30 disabled:hover:bg-transparent transition-colors flex-shrink-0"
          title={t('panel.preview.ebookPrev')}
        >
          <ChevronLeft size={11} />
        </button>
        <button
          onClick={() => void openChapter(chapter.index + 1, book)}
          disabled={!canNext}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 disabled:opacity-30 disabled:hover:bg-transparent transition-colors flex-shrink-0"
          title={t('panel.preview.ebookNext')}
        >
          <ChevronRight size={11} />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {tocOpen && book.toc.length > 0 && (
          <div className="flex-shrink-0 w-44 overflow-auto border-r border-border-secondary/30 py-1">
            {book.toc.map((item, i) => (
              <button
                key={i}
                onClick={() => {
                  void openChapter(item.index, book)
                  setTocOpen(false)
                }}
                style={{ paddingLeft: `${8 + item.depth * 10}px` }}
                className={[
                  'block w-full text-left pr-2 py-1 text-[10px] truncate transition-colors',
                  item.index === chapter.index
                    ? 'text-accent bg-bg-hover/30'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40'
                ].join(' ')}
                title={item.label}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        <iframe
          ref={frameRef}
          key={chapter.index}
          sandbox="allow-same-origin"
          srcDoc={chapter.html}
          className="flex-1 min-w-0 border-0 bg-white"
          title={chapterLabel || book.title}
        />
      </div>
    </div>
  )
}
