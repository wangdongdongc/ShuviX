import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
  tableContextMenu,
  tableWikiLinks,
  type TableMenuItem,
  type WikiLinkStatus,
  wikiLinks
} from '@shuvix/atomic-editor'
import { ATOMIC_CODE_LANGUAGES } from '@shuvix/atomic-editor/code-languages'
import '@shuvix/atomic-editor/styles.css'
import './atomic-panel.css'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { createRoot } from 'react-dom/client'
import { useChatStore, getChatApi, getSessionChannelApi, useAppEvent } from '@shuvix/chat-ui'
import type { ContextMenuRequest, ContextMenuResult } from '@shuvix/chat-protocol/types/contextMenu'
import { isContentOnlyFileChange } from '@shuvix/chat-protocol/utils/fileMap'
import { useResolveMediaUrl, type MediaSource } from '@shuvix/chat-ui'
import { runMarkdownCommand, markdownKeymap } from './markdownCommands'
import { frontmatterCard, type FrontmatterFieldMount } from './frontmatterCard'
import { FrontmatterFieldPicker } from './FrontmatterFieldPicker'
import { NotebookMinimap } from './NotebookMinimap'
import { parseHeadings, type NotebookHeading } from './notebookHeadings'
import {
  type FileMap,
  buildFileMap,
  imageLoadRemeasure,
  isImagePath,
  lookupAbs,
  refreshEmbeds,
  searchFileMap,
  wikiImageEmbeds
} from './wikiEmbed'

const SAVE_DEBOUNCE_MS = 200

/**
 * 宿主能力注入（去除对 window.api / 桌面 store 的直接依赖，供桌面 + 扩展复用）。
 */
export interface NotebookCaps {
  /** 笔记本主题预设（映射到 .atomic-panel 的 data-notebook-theme，由 CSS 上色）；缺省 'default' */
  notebookTheme?: string
  /** 打开外部链接（桌面：window.api.app.openExternal；扩展：window.open） */
  openExternal?: (url: string) => void
  /** 原生右键菜单（桌面注入 window.api.contextMenu.popup）；不提供则用浏览器默认右键 */
  popupContextMenu?: (request: ContextMenuRequest) => Promise<ContextMenuResult>
}

/**
 * 按 sessionId 缓存的文件查表（双链解析用）。放模块级而非 React ref/memo：
 * wikiLinks 的 resolve 回调拿不到编辑器 state，必须闭包外部可变量；模块级缓存可同时避开
 * react-hooks 的 refs / immutability / exhaustive-deps 限制，回调只需闭包 sessionId。
 */
const FILE_MAPS = new Map<string, FileMap>()

/**
 * `[[file]]` 展示时隐藏 .md 后缀（类 Obsidian）。只影响显示 label，
 * 文档原文与解析 target 不变；正文 widget 与表格单元格（displayTarget，
 * 后缀藏进隐藏 mark 保证 textContent 往返）共用。
 */
const stripMdExt = (target: string): string => target.replace(/\.md$/i, '')

/**
 * ![[image]] 内嵌图片 URL 缓存：sessionId → (absPath → MediaSource)。模块级（同 FILE_MAPS）以便
 * wikiImageEmbeds 的同步 resolveSrc 回调读取，避免在 render 期访问 React ref。组件按 sessionId 卸载时 revoke。
 */
const EMBED_SOURCES = new Map<string, Map<string, MediaSource>>()
/** 正在异步解析中的 `${sessionId}::${abs}`，避免重复触发 */
const EMBED_PENDING = new Set<string>()
/** 各 session 触发 CM6 内嵌图片重算的回调（组件挂载时注册）。供 resolveSrc 异步就绪后调用，
 *  让 resolveSrc 只读模块级 map、不在 render 期访问 React ref（react-hooks/refs）。 */
const EMBED_REFRESH = new Map<string, () => void>()

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
  /** 持久化最新 markdown（防抖触发 + 卸载时 flush）。父组件用 useCallback 包裹保持稳定。
   *  readOnly 模式下不会触发（无文档改动），可省略。 */
  onSave?: (content: string) => void
  /**
   * 只读 live-preview：仅渲染、不可编辑（供 Files 面板 md 预览复用笔记本渲染）。
   * 编辑器不可聚焦 → inline-preview 全量渲染（无光标行揭示源码）；同时关闭自动保存、
   * 编辑右键菜单与 minimap 跳转聚焦。双链 [[file]] / 内嵌 ![[image]] 仍生效。
   */
  readOnly?: boolean
  /**
   * 排版模式。`notebook`（缺省）= 写作页：侧边距 + 700px 限宽居中 + 标题角标 + minimap；
   * `fill` = 嵌入模式：铺满容器、去角标与 minimap，供设置页这类**自带边距**的宿主使用
   * （两套边距叠加会把正文挤成窄条，且 minimap 会浮在铺满的正文上）。
   */
  layout?: 'notebook' | 'fill'
  /** 内容是否已下滑（非顶端）—— 父组件据此给标题栏加柔和阴影 */
  onScrolledChange?: (scrolled: boolean) => void
  /** 保存状态变化（用于标题栏「保存中…」指示） */
  onSaveStatusChange?: (status: SaveStatus) => void
  handleRef?: React.RefObject<LivePreviewEditorHandle | null>
  /**
   * 项目文件上下文（来自 NotebookView）。提供后启用 Obsidian 风格双链：
   * `[[file]]` 可点击跳转（在右侧 Files 面板打开预览）、`![[image]]` 行内预览，
   * 均按文件名在该会话工作目录内解析。笔记本式独立文档不传则不启用。
   */
  fileContext?: { sessionId: string }
  /** 宿主能力注入（主题 / 外链 / 原生右键菜单） */
  caps?: NotebookCaps
}

/**
 * LivePreviewEditor —— Atomic Editor（CM6 live preview）编辑区核心，供 NotebookView 使用。
 * 负责编辑器本体、防抖自动保存（+ 卸载 flush）、滚动阴影探测、右键菜单、右侧悬浮 minimap、
 * 笔记本主题预设（data-notebook-theme）。标题栏由父组件渲染，本组件只负责其下方的编辑区。
 * 宿主无关：文件读写/扫描经 getSessionChannelApi().files、图片内嵌经注入的 mediaUrl seam、
 * 主题/外链/右键菜单经 caps 注入。
 */
export function LivePreviewEditor({
  documentId,
  initialContent,
  onSave,
  onScrolledChange,
  onSaveStatusChange,
  handleRef,
  fileContext,
  caps,
  readOnly = false,
  layout = 'notebook'
}: LivePreviewEditorProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  // 笔记本主题预设（如 Things）—— 映射到 .atomic-panel 的 data-notebook-theme，由 CSS 上色
  const notebookTheme = caps?.notebookTheme ?? 'default'
  const resolveMedia = useResolveMediaUrl()

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
    onSaveRef.current?.(pending)
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
      // 无原生右键菜单注入（如扩展端）→ 不拦截，交浏览器默认右键
      const popup = caps?.popupContextMenu
      if (!popup) return
      e.preventDefault()
      const m = (k: string, opts?: Record<string, unknown>): string =>
        t(`notebook.menu.${k}`, opts ?? {})
      const headingItems = Array.from({ length: 6 }, (_, i) => ({
        id: `para.h${i + 1}`,
        label: m('heading', { level: i + 1 })
      }))
      const result = await popup({
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
    [t, caps]
  )

  // 表格单元格右键菜单：交给 @shuvix/atomic-editor 的 renderMenu 钩子，用注入的原生菜单
  // （caps.popupContextMenu）呈现，文案按 item.id 取多语言——与编辑器主右键菜单风格统一，
  // 且不再依赖匹配包内英文文案。无注入（扩展端）则不渲染自定义菜单。
  const renderTableMenu = useCallback(
    (items: TableMenuItem[], _pos: { x: number; y: number }): void => {
      const popup = caps?.popupContextMenu
      if (!popup) return
      const rows = items.filter((i) => i.group === 'row')
      const cols = items.filter((i) => i.group === 'column')
      // 用 i18n.t（而非 hook 的 t）：extensions 在 mount 时被一次性捕获，i18n 实例稳定
      // 且 t 始终按当前语言解析，避免切换语言后菜单文案不更新。
      const toEntry = (i: TableMenuItem): { id: string; label: string } => ({
        id: i.id,
        label: i18n.t(`notebook.menu.tableMenu.${i.id}`)
      })
      const menuItems = [
        ...rows.map(toEntry),
        ...(rows.length && cols.length ? [{ type: 'separator' as const }] : []),
        ...cols.map(toEntry)
      ]
      void popup({ items: menuItems }).then((result) => {
        if (!result.actionId) return
        items.find((i) => i.id === result.actionId)?.run()
      })
    },
    [i18n, caps]
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
  const onJump = useCallback(
    (line: number): void => {
      const dom = panelRef.current?.querySelector<HTMLElement>('.cm-editor')
      const view = dom ? EditorView.findFromDOM(dom) : null
      if (!view) return
      const lineNo = Math.max(1, Math.min(line, view.state.doc.lines))
      const info = view.state.doc.line(lineNo)
      // 只读：仅滚动、不移光标/聚焦（聚焦会让 inline-preview 揭示该行源码）
      if (readOnly) {
        view.dispatch({
          effects: EditorView.scrollIntoView(info.from, { y: 'start', yMargin: 24 })
        })
        return
      }
      view.dispatch({
        selection: { anchor: info.from },
        effects: EditorView.scrollIntoView(info.from, { y: 'start', yMargin: 24 })
      })
      view.focus()
    },
    [readOnly]
  )

  // 双链文件表：扫描会话工作目录建表。建表后 dispatch refreshEmbeds 触发内嵌图片重算
  // （首扫返回前 ![[...]] 暂以原文显示）。
  const rescanFileMap = useCallback(async (): Promise<void> => {
    if (!sessionId) return
    try {
      const r = await getSessionChannelApi().files.scan({ sessionId })
      if (!r.root) return
      FILE_MAPS.set(sessionId, buildFileMap(r.root, r.paths))
      const dom = panelRef.current?.querySelector<HTMLElement>('.cm-editor')
      const view = dom ? EditorView.findFromDOM(dom) : null
      view?.dispatch({ effects: refreshEmbeds.of(null) })
    } catch {
      /* 扫描失败：双链暂不可解析，保持原文 */
    }
  }, [sessionId])

  useEffect(() => {
    void rescanFileMap()
  }, [rescanFileMap])

  // 文件变更 → 重扫双链文件表（通用 AppEvent 'files.changed'，替代旧 files.onChanged）。
  // 按 root 过滤 + 纯内容变更（edit/write 且路径均已在表中）跳过 —— 尤其是本编辑器自己
  // 的自动保存经 watcher 发回的事件，不该触发整目录重扫；其余防抖 200ms（对齐 FilesPanel）
  const fileMapRescanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useAppEvent('files.changed', (e) => {
    const map = sessionId ? FILE_MAPS.get(sessionId) : null
    if (map) {
      if (e.root !== map.root) return
      if (isContentOnlyFileChange(e, (rel) => map.byRel.has(rel))) return
    }
    if (fileMapRescanTimer.current) clearTimeout(fileMapRescanTimer.current)
    fileMapRescanTimer.current = setTimeout(() => {
      fileMapRescanTimer.current = null
      void rescanFileMap()
    }, 200)
  })
  useEffect(
    () => () => {
      if (fileMapRescanTimer.current) clearTimeout(fileMapRescanTimer.current)
    },
    []
  )

  // 确保该会话的文件表已就绪（首次解析/补全时若尚未扫描则补扫一次），返回最新表
  const ensureFileMap = useCallback(async (): Promise<FileMap | null> => {
    if (!sessionId) return null
    if (!FILE_MAPS.has(sessionId)) {
      try {
        const r = await getSessionChannelApi().files.scan({ sessionId })
        if (r.root) FILE_MAPS.set(sessionId, buildFileMap(r.root, r.paths))
      } catch {
        /* 忽略 */
      }
    }
    return FILE_MAPS.get(sessionId) ?? null
  }, [sessionId])

  // 双链解析回调（闭包只依赖 sessionId，查表读模块级 FILE_MAPS，避开 react-hooks 限制）
  const resolveWikiLink = useCallback(
    async (
      target: string
    ): Promise<{ target: string; label: string; status: 'resolved' | 'missing' }> => {
      if (!sessionId) return { target, label: stripMdExt(target), status: 'missing' }
      const abs = lookupAbs(await ensureFileMap(), target)
      return { target, label: stripMdExt(target), status: abs ? 'resolved' : 'missing' }
    },
    [sessionId, ensureFileMap]
  )

  // [[ 自动补全：按输入在会话工作目录文件表内搜索（内存内过滤，不每次击键回后端扫盘）。
  // 命中项按 boost 递减保持本地排序；serializeSuggestion 只写最短 token、不强制别名。
  const suggestWikiTargets = useCallback(
    async (query: string) => {
      if (!sessionId) return []
      const results = searchFileMap(await ensureFileMap(), query)
      return results.map((r, i) => ({
        target: r.token,
        label: r.label,
        detail: r.detail,
        boost: results.length - i
      }))
    },
    [sessionId, ensureFileMap]
  )
  const openWikiLink = useCallback(
    (target: string): void => {
      if (!sessionId) return
      const abs = lookupAbs(FILE_MAPS.get(sessionId) ?? null, target)
      if (!abs) return
      // 点击 [[file]] → 一律在右侧 Files 面板打开该文件预览（代码/文本/媒体/二进制都可预览），
      // 不再按扩展名分流到外部打开——保持外层编辑器与表格单元格内的 wikiLink 行为一致。
      useChatStore.getState().requestFilePreview(abs)
    },
    [sessionId]
  )
  // 表格单元格内 [[file]] 的同步着色（resolved/missing）。文件表未就绪时返回 undefined
  // 用默认样式，避免建表时全部误显示为缺失（表格 widget 仅在文档变更时重建，不会随扫描回填）。
  const resolveWikiStatus = useCallback(
    (target: string): WikiLinkStatus | undefined => {
      if (!sessionId) return undefined
      const map = FILE_MAPS.get(sessionId)
      if (!map) return undefined
      return lookupAbs(map, target) ? 'resolved' : 'missing'
    },
    [sessionId]
  )
  // ![[image]] 内嵌图片 URL 经注入的 mediaUrl seam 解析（桌面 shuvix-preview:// 同步；
  // 扩展 blob: 异步）。resolveSrc 须同步返回，故走模块级 EMBED_SOURCES 缓存：异步来源就绪后
  // 写缓存并 dispatch refreshEmbeds 触发重算，此时同步命中缓存。卸载时按 sessionId revoke（释放 blob）。
  useEffect(() => {
    if (!sessionId) return undefined
    // 注册重算回调（闭包读 panelRef 在 effect 内，合法）；卸载时 revoke 全部 blob 并注销
    EMBED_REFRESH.set(sessionId, () => {
      const dom = panelRef.current?.querySelector<HTMLElement>('.cm-editor')
      const view = dom ? EditorView.findFromDOM(dom) : null
      view?.dispatch({ effects: refreshEmbeds.of(null) })
    })
    return () => {
      EMBED_REFRESH.delete(sessionId)
      const m = EMBED_SOURCES.get(sessionId)
      if (m) {
        for (const s of m.values()) s.revoke?.()
        EMBED_SOURCES.delete(sessionId)
      }
    }
  }, [sessionId])
  const resolveEmbedSrc = useCallback(
    (name: string): string | null => {
      if (!sessionId) return null
      const abs = lookupAbs(FILE_MAPS.get(sessionId) ?? null, name)
      if (!abs || !isImagePath(abs)) return null
      const cached = EMBED_SOURCES.get(sessionId)?.get(abs)
      if (cached) return cached.url
      if (!resolveMedia) return null
      const store = (s: MediaSource): void => {
        let m = EMBED_SOURCES.get(sessionId)
        if (!m) {
          m = new Map()
          EMBED_SOURCES.set(sessionId, m)
        }
        m.set(abs, s)
      }
      const src = resolveMedia({ sessionId, path: abs })
      if (src instanceof Promise) {
        const key = `${sessionId}::${abs}`
        if (!EMBED_PENDING.has(key)) {
          EMBED_PENDING.add(key)
          void src
            .then((s) => {
              store(s)
              EMBED_PENDING.delete(key)
              EMBED_REFRESH.get(sessionId)?.()
            })
            .catch(() => EMBED_PENDING.delete(key))
        }
        return null
      }
      // 同步来源（桌面）：直接缓存并返回
      store(src)
      return src.url
    },
    [sessionId, resolveMedia]
  )

  // 属性卡的字段槽位：把仓库既有的成熟选择器（ToolSelectList / ModelSelect）挂进去。
  // 卡片是纯 DOM 的 CM6 widget，故用独立 React root 挂载，widget.destroy 时卸载
  // （unmount 推到微任务：React 不允许在渲染/提交过程中同步卸载另一棵树）。
  const mountField = useCallback((slot: HTMLElement, ctx: FrontmatterFieldMount): (() => void) => {
    const root = createRoot(slot)
    root.render(
      <FrontmatterFieldPicker
        fieldKey={ctx.key}
        kind={ctx.kind === 'csv' ? 'csv' : 'select'}
        value={ctx.value}
        onChange={ctx.onChange}
        readOnly={ctx.readOnly}
      />
    )
    return () => queueMicrotask(() => root.unmount())
  }, [])

  // 双链扩展（仅在有项目上下文时启用）：[[file]] 链接 + ![[image]] 内嵌。
  // atomic 在 mount 时一次性捕获 extensions（按 documentId），父组件按文件 key 重挂载，故稳定即可。
  const editorExtensions = useMemo<readonly Extension[]>(() => {
    const tableMenu = tableContextMenu(renderTableMenu)
    // shuvix 契约 md（agent/policy/chart/wiki）的 frontmatter 属性卡：自检测标记，
    // 无标记的普通 md 零影响。文案走 i18n.t —— 同 renderTableMenu 的取舍：extensions
    // 在 mount 时一次性捕获，i18n 实例稳定且 t 按当前语言解析。
    const fmCard: Extension = frontmatterCard({
      t: (key) => i18n.t(key),
      // 解析器级校验经 ChatApi（桌面走 IPC、扩展进程内直调）
      validate: (params) => getChatApi().shuvixMd.validate(params),
      // 诊断文案的 who + 校验缓存 key 的一部分（卡片内拼接）
      name: documentId.split(/[\\/]/).pop(),
      mountField
    })
    if (!sessionId) return [markdownKeymap, tableMenu, imageLoadRemeasure, fmCard]
    return [
      markdownKeymap,
      tableMenu,
      imageLoadRemeasure,
      fmCard,
      wikiLinks({
        openOnClick: true,
        resolve: resolveWikiLink,
        onOpen: openWikiLink,
        suggest: suggestWikiTargets,
        // 只插入最短 token（[[token]]），不强制生成 |别名（默认序列化会带上）
        serializeSuggestion: (s) => `${s.target}]]`
      }),
      // 表格是整块替换 widget，外层 wikiLinks 装饰进不去单元格；这里单独让单元格内
      // [[file]] 可点击（打开走 openWikiLink，与外层一致）+ 按文件表同步着色解析/缺失态。
      tableWikiLinks({
        onOpen: openWikiLink,
        resolveStatus: resolveWikiStatus,
        displayTarget: stripMdExt
      }),
      wikiImageEmbeds({ resolveSrc: resolveEmbedSrc })
    ]
  }, [
    sessionId,
    renderTableMenu,
    resolveWikiLink,
    openWikiLink,
    resolveWikiStatus,
    suggestWikiTargets,
    resolveEmbedSrc,
    i18n,
    documentId,
    mountField
  ])

  return (
    // notebook-scroller：与对话列的 conversation-scroller 同义 —— 供外壳按需微调本列滚动条
    // （会话面板展开时内缩内部 .cm-scroller 的轨道，见 base.css）
    <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden thin-scrollbar notebook-scroller">
      <div
        className="atomic-panel"
        data-notebook-theme={notebookTheme}
        data-layout={layout}
        ref={panelRef}
        // 只读预览不提供编辑右键菜单 —— 交浏览器默认右键（复制/检查）
        onContextMenu={readOnly ? undefined : onEditorContextMenu}
      >
        <AtomicCodeMirrorEditor
          documentId={documentId}
          markdownSource={initialContent}
          // 只读模式不接收文档变更回调，自动保存机制保持休眠
          onMarkdownChange={readOnly ? undefined : onMarkdownChange}
          editorHandleRef={atomicRef}
          codeLanguages={ATOMIC_CODE_LANGUAGES}
          extensions={editorExtensions}
          onLinkClick={(url) => caps?.openExternal?.(url)}
          readOnly={readOnly}
        />
      </div>
      {layout === 'notebook' && headings.length > 0 && (
        <NotebookMinimap headings={headings} onJump={onJump} />
      )}
    </div>
  )
}
