import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
  wikiLinks
} from '@atomic-editor/editor'
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages'
import '@atomic-editor/editor/styles.css'
import '../atomic/atomic-panel.css'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { useChatStore } from '@shuvix/chat-ui'
import { useSettingsStore } from '../../stores/settingsStore'
import { runMarkdownCommand, markdownKeymap } from './markdownCommands'
import { NotebookMinimap } from './NotebookMinimap'
import { parseHeadings, type NotebookHeading } from './notebookHeadings'
import {
  type FileMap,
  buildFileMap,
  isImagePath,
  lookupAbs,
  refreshEmbeds,
  wikiImageEmbeds
} from './wikiEmbed'

const SAVE_DEBOUNCE_MS = 200

/** shuvix-preview:// 图片 URL（主进程协议带沙箱校验） */
function previewUrl(sessionId: string, absPath: string): string {
  return `shuvix-preview://load/?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(absPath)}`
}

/**
 * 按 sessionId 缓存的文件查表（双链解析用）。放模块级而非 React ref/memo：
 * wikiLinks 的 resolve 回调拿不到编辑器 state，必须闭包外部可变量；模块级缓存可同时避开
 * react-hooks 的 refs / immutability / exhaustive-deps 限制，回调只需闭包 sessionId。
 */
const FILE_MAPS = new Map<string, FileMap>()

export type SaveStatus = 'saved' | 'saving'

export interface LivePreviewEditorHandle {
  /** 取当前编辑器内的 markdown 全文（用于重命名前等需要同步落盘的场景） */
  getMarkdown(): string | undefined
  /** 取消待写入的防抖定时（调用方接管落盘，避免「先 rename 后 write 又重建旧文件」竞态） */
  cancelPendingSave(): void
}

export interface LivePreviewEditorProps {
  /** 文档唯一标识（atomic documentId）；切换文档应由父组件用 key 重挂载本组件 */
  documentId: string
  initialContent: string
  /** 持久化最新 markdown（防抖触发 + 卸载时 flush）。父组件用 useCallback 包裹保持稳定 */
  onSave: (content: string) => void
  /** 内容是否已下滑（非顶端）—— 父组件据此给标题栏加柔和阴影 */
  onScrolledChange?: (scrolled: boolean) => void
  /** 保存状态变化（用于标题栏「保存中…」指示） */
  onSaveStatusChange?: (status: SaveStatus) => void
  handleRef?: React.RefObject<LivePreviewEditorHandle | null>
  /**
   * 项目文件上下文（来自 MarkdownFileView）。提供后启用 Obsidian 风格双链：
   * `[[file]]` 可点击跳转、`![[image]]` 行内预览，均按文件名在该会话工作目录内解析。
   * 笔记本式独立文档不传则不启用。
   */
  fileContext?: { sessionId: string }
}

/**
 * LivePreviewEditor —— Atomic Editor（CM6 live preview）编辑区核心，供 MarkdownFileView 使用。
 * 负责编辑器本体、防抖自动保存（+ 卸载 flush）、滚动阴影探测、右键菜单、右侧悬浮 minimap、
 * 笔记本主题预设（data-notebook-theme）。标题栏由父组件渲染，本组件只负责其下方的编辑区。
 */
export function LivePreviewEditor({
  documentId,
  initialContent,
  onSave,
  onScrolledChange,
  onSaveStatusChange,
  handleRef,
  fileContext
}: LivePreviewEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  // 笔记本主题预设（如 Things）—— 映射到 .atomic-panel 的 data-notebook-theme，由 CSS 上色
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)

  const sessionId = fileContext?.sessionId

  // minimap 标题列表（解析自 markdown 文本）
  const [headings, setHeadings] = useState<NotebookHeading[]>(() => parseHeadings(initialContent))

  const panelRef = useRef<HTMLDivElement>(null)
  const atomicRef = useRef<AtomicCodeMirrorEditorHandle | null>(null)
  // 待保存内容；onSave 闭包已绑定写入目标，这里只存内容
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 最新 onSave，避免其 identity 变化触发 flush effect 误重跑
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  /** 立即落盘待保存内容 */
  const flushSave = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    if (pending === null) return
    pendingRef.current = null
    onSaveRef.current(pending)
    onSaveStatusChange?.('saved')
  }, [onSaveStatusChange])

  // 卸载时（切换文档/会话）flush 待保存内容，避免丢失。documentId 变化由父组件用 key 重挂载。
  useEffect(() => {
    return () => {
      flushSave()
    }
  }, [flushSave])

  // 记录内容是否已下滑（顶端时无阴影）。scroll 事件不冒泡但会经过捕获阶段，
  // 故在 .atomic-panel 祖先上以 capture 监听，可捕获内部 .cm-scroller 的滚动，不依赖具体元素。
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || !onScrolledChange) return undefined
    const onScroll = (e: Event): void => {
      const target = e.target as HTMLElement | null
      if (target) onScrolledChange(target.scrollTop > 0)
    }
    panel.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => panel.removeEventListener('scroll', onScroll, { capture: true })
  }, [onScrolledChange])

  useImperativeHandle(
    handleRef,
    () => ({
      getMarkdown: () => atomicRef.current?.getMarkdown(),
      cancelPendingSave: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        pendingRef.current = null
      }
    }),
    []
  )

  // 编辑器右键：文本格式 / 段落设置 / 插入 三个子菜单（执行 markdown 命令）
  // + 原生编辑动作（剪切/复制/粘贴/全选用 role，OS 提供本地化文案 + macOS 服务）
  const onEditorContextMenu = useCallback(
    async (e: React.MouseEvent): Promise<void> => {
      e.preventDefault()
      const m = (k: string, opts?: Record<string, unknown>): string =>
        t(`notebook.menu.${k}`, opts ?? {})
      const headingItems = Array.from({ length: 6 }, (_, i) => ({
        id: `para.h${i + 1}`,
        label: m('heading', { level: i + 1 })
      }))
      const result = await window.api.contextMenu.popup({
        items: [
          {
            id: 'fmt',
            label: m('textFormat'),
            submenu: [
              { id: 'fmt.bold', label: m('bold') },
              { id: 'fmt.italic', label: m('italic') },
              { id: 'fmt.strike', label: m('strikethrough') },
              { id: 'fmt.highlight', label: m('highlight') },
              { id: 'fmt.code', label: m('code') },
              { type: 'separator' },
              { id: 'fmt.clear', label: m('clearFormat') }
            ]
          },
          {
            id: 'para',
            label: m('paragraph'),
            submenu: [
              { id: 'para.ul', label: m('bulletList') },
              { id: 'para.ol', label: m('orderedList') },
              { id: 'para.task', label: m('taskList') },
              { type: 'separator' },
              ...headingItems,
              { id: 'para.body', label: m('body') },
              { type: 'separator' },
              { id: 'para.quote', label: m('quote') }
            ]
          },
          {
            id: 'insert',
            label: m('insert'),
            submenu: [
              { id: 'insert.table', label: m('table') },
              { id: 'insert.hr', label: m('divider') },
              { id: 'insert.code', label: m('codeBlock') }
            ]
          },
          { type: 'separator' },
          { role: 'cut', label: m('cut') },
          { role: 'copy', label: m('copy') },
          { role: 'paste', label: m('paste') },
          { role: 'pasteAndMatchStyle', label: m('pasteMatchStyle') },
          { type: 'separator' },
          { role: 'selectAll', label: m('selectAll') }
        ]
      })
      if (!result.actionId) return
      const dom = panelRef.current?.querySelector<HTMLElement>('.cm-editor')
      const view = dom ? EditorView.findFromDOM(dom) : null
      if (view) runMarkdownCommand(view, result.actionId)
    },
    [t]
  )

  const onMarkdownChange = useCallback(
    (md: string): void => {
      pendingRef.current = md
      onSaveStatusChange?.('saving')
      setHeadings(parseHeadings(md))
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
    },
    [flushSave, onSaveStatusChange]
  )

  /** minimap 点击：滚动到对应标题行并聚焦（复用 findFromDOM 取 view） */
  const onJump = useCallback((line: number): void => {
    const dom = panelRef.current?.querySelector<HTMLElement>('.cm-editor')
    const view = dom ? EditorView.findFromDOM(dom) : null
    if (!view) return
    const lineNo = Math.max(1, Math.min(line, view.state.doc.lines))
    const info = view.state.doc.line(lineNo)
    view.dispatch({
      selection: { anchor: info.from },
      effects: EditorView.scrollIntoView(info.from, { y: 'start', yMargin: 24 })
    })
    view.focus()
  }, [])

  // 双链文件表：扫描会话工作目录建表；磁盘变更时重扫。建表后 dispatch refreshEmbeds
  // 触发内嵌图片重算（首扫返回前 ![[...]] 暂以原文显示）。
  useEffect(() => {
    if (!sessionId) return undefined
    let cancelled = false
    const doScan = async (): Promise<void> => {
      try {
        const r = await window.api.files.scan({ sessionId })
        if (cancelled || !r.root) return
        FILE_MAPS.set(sessionId, buildFileMap(r.root, r.paths))
        const dom = panelRef.current?.querySelector<HTMLElement>('.cm-editor')
        const view = dom ? EditorView.findFromDOM(dom) : null
        view?.dispatch({ effects: refreshEmbeds.of(null) })
      } catch {
        /* 扫描失败：双链暂不可解析，保持原文 */
      }
    }
    void doScan()
    const unsub = window.api.files.onChanged(() => void doScan())
    return () => {
      cancelled = true
      unsub()
    }
  }, [sessionId])

  // 双链解析回调（闭包只依赖 sessionId，查表读模块级 FILE_MAPS，避开 react-hooks 限制）
  const resolveWikiLink = useCallback(
    async (
      target: string
    ): Promise<{ target: string; label: string; status: 'resolved' | 'missing' }> => {
      if (!sessionId) return { target, label: target, status: 'missing' }
      // 首次解析时若尚未扫描，补一次（atomic 期间显示 loading 态）
      if (!FILE_MAPS.has(sessionId)) {
        try {
          const r = await window.api.files.scan({ sessionId })
          if (r.root) FILE_MAPS.set(sessionId, buildFileMap(r.root, r.paths))
        } catch {
          /* 忽略 */
        }
      }
      const abs = lookupAbs(FILE_MAPS.get(sessionId) ?? null, target)
      return { target, label: target, status: abs ? 'resolved' : 'missing' }
    },
    [sessionId]
  )
  const openWikiLink = useCallback(
    (target: string): void => {
      if (!sessionId) return
      const abs = lookupAbs(FILE_MAPS.get(sessionId) ?? null, target)
      if (!abs) return
      if (/\.(md|mdx|markdown)$/i.test(abs)) {
        useChatStore.getState().setActiveFile({ path: abs, sessionId })
      } else {
        void window.api.app.openExternal(`file://${abs}`)
      }
    },
    [sessionId]
  )
  const resolveEmbedSrc = useCallback(
    (name: string): string | null => {
      if (!sessionId) return null
      const abs = lookupAbs(FILE_MAPS.get(sessionId) ?? null, name)
      return abs && isImagePath(abs) ? previewUrl(sessionId, abs) : null
    },
    [sessionId]
  )

  // 双链扩展（仅在有项目上下文时启用）：[[file]] 链接 + ![[image]] 内嵌。
  // atomic 在 mount 时一次性捕获 extensions（按 documentId），父组件按文件 key 重挂载，故稳定即可。
  const editorExtensions = useMemo<readonly Extension[]>(() => {
    if (!sessionId) return [markdownKeymap]
    return [
      markdownKeymap,
      wikiLinks({ openOnClick: true, resolve: resolveWikiLink, onOpen: openWikiLink }),
      wikiImageEmbeds({ resolveSrc: resolveEmbedSrc })
    ]
  }, [sessionId, resolveWikiLink, openWikiLink, resolveEmbedSrc])

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden">
      <div
        className="atomic-panel"
        data-notebook-theme={notebookTheme}
        ref={panelRef}
        onContextMenu={onEditorContextMenu}
      >
        <AtomicCodeMirrorEditor
          documentId={documentId}
          markdownSource={initialContent}
          onMarkdownChange={onMarkdownChange}
          editorHandleRef={atomicRef}
          codeLanguages={ATOMIC_CODE_LANGUAGES}
          extensions={editorExtensions}
          onLinkClick={(url) => void window.api.app.openExternal(url)}
        />
      </div>
      {headings.length > 0 && <NotebookMinimap headings={headings} onJump={onJump} />}
    </div>
  )
}
