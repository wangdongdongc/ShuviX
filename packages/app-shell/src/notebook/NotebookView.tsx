import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { getSessionChannelApi, getHostApi, useAppEvent } from '@shuvix/chat-ui'
import {
  LivePreviewEditor,
  type LivePreviewEditorHandle,
  type NotebookCaps,
  type SaveStatus
} from './LivePreviewEditor'

/** failed = files.write 越权/IO 失败；其余同笔记本 */
type FileSaveStatus = SaveStatus | 'failed'

export interface NotebookViewProps {
  /** 绑定的 md 文件绝对路径 */
  path: string
  /** 归属会话（笔记本会话）ID —— 双链/图片在该会话工作目录内解析 */
  sessionId: string
  /** 宿主能力注入（主题 / 外链 / 原生右键菜单） */
  caps?: NotebookCaps
  /** 外部编辑器句柄（父组件持有，供下方输入条 getMarkdown 取实时内容）；不传则内部自建 */
  editorHandleRef?: React.RefObject<LivePreviewEditorHandle | null>
  /** 排版模式（见 LivePreviewEditor.layout）：缺省笔记本写作页；设置页这类自带边距的宿主传 fill */
  layout?: 'notebook' | 'fill'
  /** 无 `shuvix:` 自述行的文件按哪个契约渲染属性卡（知识库笔记本传 `okf`） */
  frontmatterFallbackType?: string
  /** 只读：只渲染不编辑、不自动保存（随应用发布的内置知识库 —— 文件在应用包里，改了会随更新消失） */
  readOnly?: boolean
  /** 宿主追加的 CM6 扩展（见 LivePreviewEditor.extraExtensions；挂载时捕获一次，传稳定数组） */
  extraExtensions?: readonly Extension[]
  /**
   * 别的程序改了这个文件时，交给宿主**并入**编辑器（派发事务），而不是整篇重挂载。
   *
   * 给了它，编辑器缓冲就是事实源：这次变化不会因为「有未保存的输入」被丢掉（宿主拿 base / 磁盘 /
   * 当前缓冲自己做三方合并），自身的保存也不会被误当成外部变化（等在途写完再读、认得自己写过的内容）。
   * 返回 false = 宿主没处理，回落到重挂载。缺省时行为与从前一致。
   */
  onExternalChange?: (change: {
    /** 磁盘上的新内容 */
    disk: string
    /** 上一次与磁盘同步的内容（三方合并的共同祖先） */
    base: string
    view: EditorView
  }) => boolean
}

/**
 * NotebookView —— 笔记本会话的中间区正文：绑定项目内一个 md 文件，做 live-preview 编辑。
 * 复用 LivePreviewEditor：读经 getSessionChannelApi().files，写经 getHostApi().files（渠道端只读）。
 *
 * **不含顶栏** —— 顶栏复用对话框的 ChatHeader（由宿主在本组件之上渲染，显示会话标题/工作目录），
 * 与聊天视图一致。保存状态以右上角浮层提示（仅保存中/失败时出现）。设置页编辑 agent / 策略 /
 * hook md 时直接嵌本组件（绑定该文件的笔记本会话，不带输入卡片）—— 与笔记本同一条读写路径。
 * 宿主无关：文件 IO 经 ChatApi、图片内嵌经注入的 mediaUrl seam、主题/外链/右键经 caps。
 */
export function NotebookView({
  path,
  sessionId,
  caps,
  editorHandleRef,
  layout,
  frontmatterFallbackType,
  readOnly = false,
  extraExtensions,
  onExternalChange
}: NotebookViewProps): React.JSX.Element {
  const { t } = useTranslation()

  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<FileSaveStatus>('saved')
  /** 外部写回（子智能体改盘）触发重挂载编辑器的递增标记 */
  const [reloadNonce, setReloadNonce] = useState(0)

  const internalRef = useRef<LivePreviewEditorHandle | null>(null)
  const editorRef = editorHandleRef ?? internalRef
  // 我们已知的磁盘内容（初次加载 / 每次保存后更新）——用于区分「自身保存」与「外部写回」
  const lastSyncedContentRef = useRef<string | null>(null)
  const saveStatusRef = useRef<FileSaveStatus>('saved')
  useEffect(() => {
    saveStatusRef.current = saveStatus
  }, [saveStatus])
  const onExternalChangeRef = useRef(onExternalChange)
  useEffect(() => {
    onExternalChangeRef.current = onExternalChange
  }, [onExternalChange])
  // onExternalChange 模式的磁盘记账：读盘与写盘串成一条链（彼此不交错，files.changed 也排在自己的
  // 写之后读），lastWritten = 自己最近一次写下的内容 —— 磁盘上既不是它、也不是上次同步的内容，
  // 就是别的程序写过（只认**最近**一次：别的程序把文件退回到我们更早写过的某个版本，那也是它的改动）
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const lastWrittenRef = useRef<string | null>(null)
  const isForeign = (disk: string): boolean =>
    disk !== lastSyncedContentRef.current && disk !== lastWrittenRef.current
  // 双链解析上下文（[[file]] / ![[image]] 按文件名在该会话工作目录内解析）
  const fileContext = useMemo(() => ({ sessionId }), [sessionId])

  // 只监听「本笔记本绑定的这个 md」（父目录 kqueue，非整树）：子智能体 / 外部编辑器改盘时，
  // 后端广播 files.changed → 下方 useAppEvent 重挂载编辑器。打开注册、切换/关闭注销。
  useEffect(() => {
    const api = getSessionChannelApi()
    void api.files.watch({ sessionId, path })
    return () => {
      void api.files.unwatch({ sessionId, path })
    }
  }, [path, sessionId])

  // 加载文件内容。父组件用 key（path / sessionId）让本组件按文件重挂载，故无需在此重置 state；
  // 待保存 flush 由 LivePreviewEditor 卸载时负责。
  useEffect(() => {
    let cancelled = false
    getSessionChannelApi()
      .files.read({ sessionId, path })
      .then((r) => {
        if (cancelled) return
        if (r.kind === 'text') {
          lastSyncedContentRef.current = r.content
          setContent(r.content)
        } else if (r.kind === 'error') setError(r.message)
        else if (r.kind === 'not-allowed') setError(r.reason)
        else setError(t('panel.preview.error'))
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, sessionId, t])

  /** 把别的程序写下的磁盘内容交给宿主并入编辑器；宿主没处理就回落到重挂载 */
  const absorbDisk = (disk: string): void => {
    const base = lastSyncedContentRef.current
    if (base === null) return
    lastSyncedContentRef.current = disk
    const view = editorRef.current?.getView() ?? null
    if (view && onExternalChangeRef.current?.({ disk, base, view })) return
    setContent(disk)
    setReloadNonce((n) => n + 1)
  }

  const onSave = useCallback(
    (md: string): void => {
      // 写回属宿主能力：渠道端（只读）无 HostApi，保存置为 failed 状态
      const host = getHostApi()
      if (!host) {
        setSaveStatus('failed')
        return
      }
      if (onExternalChangeRef.current) {
        // 协作模式：写之前先看一眼磁盘。上次同步之后别的程序写过，就先把那次改动并进来、这一次不写 ——
        // 直接写会把它盖掉；并入本身会触发下一次保存，那一次写的是合并后的全文
        writeChainRef.current = writeChainRef.current.then(async () => {
          const r = await getSessionChannelApi()
            .files.read({ sessionId, path })
            .catch(() => null)
          if (r?.kind === 'text' && isForeign(r.content)) {
            absorbDisk(r.content)
            return
          }
          const w = await host.files
            .write({ sessionId, path, content: md })
            .catch(() => ({ ok: false }))
          if (!w.ok) {
            // 没写成：记账保持原样（磁盘上仍是上次同步的内容）。若先记成「已同步 md」，下次保存会把
            // 盘上的旧内容当成别的程序写的，拿没写下去的 md 当共同祖先去合并 —— 用户的字就被合并吃掉了
            setSaveStatus('failed')
            return
          }
          lastSyncedContentRef.current = md
          lastWrittenRef.current = md
        })
        return
      }
      // 记录我们写入磁盘的内容，使随后的 files.changed 不被当成外部写回而触发重挂载
      lastSyncedContentRef.current = md
      void host.files.write({ sessionId, path, content: md }).then((r) => {
        if (!r.ok) setSaveStatus('failed')
      })
    },
    // absorbDisk / isForeign 只读 ref 与稳定的 setter
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, path]
  )

  /** onExternalChange 模式：排在自己的读写之后 → 读盘 → 是别的程序写的就并入 */
  const mergeExternal = (): void => {
    writeChainRef.current = writeChainRef.current.then(async () => {
      const r = await getSessionChannelApi()
        .files.read({ sessionId, path })
        .catch(() => null)
      if (r?.kind === 'text' && isForeign(r.content)) absorbDisk(r.content)
    })
  }

  // 外部写回（如子智能体编辑了绑定文件）→ 自动刷新 live preview：
  // 仅在无未保存草稿（saved）、且磁盘新内容 ≠ 我们已知内容（去重自身保存）时，重读并重挂载编辑器。
  // 注：本组件的 path 为相对工作目录的路径，而工具发布的 e.paths 为绝对路径（node path.resolve），
  // 故按「绝对路径以本相对路径结尾」做后缀命中（分隔符归一）；缺 paths（仅 root 的 watcher 事件）时放行。
  // 不能用 path.startsWith(e.root)：相对 path 永不以绝对 root 开头，会漏掉全部事件。最终仍以内容比对去重。
  useAppEvent('files.changed', (e) => {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\//, '')
    const target = norm(path)
    const hit = !e.paths || e.paths.length === 0 || e.paths.some((p) => norm(p).endsWith(target))
    if (!hit) return // 本笔记本绑定文件未被改动
    if (onExternalChangeRef.current) {
      mergeExternal()
      return
    }
    if (saveStatusRef.current !== 'saved') return // 正在编辑/保存中，避免打断光标
    void getSessionChannelApi()
      .files.read({ sessionId, path })
      .then((r) => {
        if (r.kind !== 'text') return
        if (r.content === lastSyncedContentRef.current) return // 自身保存触发，忽略
        lastSyncedContentRef.current = r.content
        setContent(r.content)
        setReloadNonce((n) => n + 1)
      })
      .catch(() => {
        /* 读失败保留当前内容 */
      })
  })

  if (error !== null) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-text-tertiary px-6 text-center break-all">
        {error}
      </div>
    )
  }
  if (content === null) {
    // 加载中：留空（loading 极短，避免闪烁）
    return <div className="flex-1 min-h-0" />
  }

  return (
    <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
      {/* 保存状态浮层（仅保存中/失败时出现）—— 顶栏已交给 ChatHeader，故这里浮层提示。
          右上角右侧留给宿主的会话工具栏胶囊（ChatBody sessionToolbar，right-4 宽约 26px），故左移到 right-12 */}
      {(saveStatus === 'saving' || saveStatus === 'failed') && (
        <div
          className={`absolute top-2 right-12 z-10 px-1.5 py-0.5 rounded text-[10px] pointer-events-none ${
            saveStatus === 'failed'
              ? 'text-red-500/80 bg-bg-secondary/80'
              : 'text-text-tertiary bg-bg-secondary/80'
          }`}
        >
          {saveStatus === 'saving' ? t('notebook.saving') : t('notebook.saveFailed')}
        </div>
      )}
      <LivePreviewEditor
        // 外部写回时 reloadNonce 递增 → 重挂载编辑器以载入新内容（CM6 state 不可原地替换）
        key={reloadNonce}
        documentId={path}
        initialContent={content}
        onSave={readOnly ? undefined : onSave}
        readOnly={readOnly}
        onSaveStatusChange={setSaveStatus}
        handleRef={editorRef}
        fileContext={fileContext}
        caps={caps}
        layout={layout}
        frontmatterFallbackType={frontmatterFallbackType}
        extraExtensions={extraExtensions}
      />
    </div>
  )
}
