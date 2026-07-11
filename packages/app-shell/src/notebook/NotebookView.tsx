import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getSessionChannelApi, getHostApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'
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
}

/**
 * NotebookView —— 笔记本会话的中间区正文：绑定项目内一个 md 文件，做 live-preview 编辑。
 * 复用 LivePreviewEditor：读经 getSessionChannelApi().files，写经 getHostApi().files（渠道端只读）。
 *
 * **不含顶栏** —— 顶栏复用对话框的 ChatHeader（由宿主在本组件之上渲染，显示会话标题/工作目录），
 * 与聊天视图一致。保存状态以右上角浮层提示（仅保存中/失败时出现）。
 * 宿主无关：文件 IO 经 ChatApi、图片内嵌经注入的 mediaUrl seam、主题/外链/右键经 caps。
 */
export function NotebookView({
  path,
  sessionId,
  caps,
  editorHandleRef
}: NotebookViewProps): React.JSX.Element {
  const { t } = useTranslation()
  // 「仅查看」渠道（WebUI 分享端）：笔记本退化为只读预览（与 Files 面板 md 预览一致）
  const viewOnly = useChatStore((s) => s.viewOnly)

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

  const onSave = useCallback(
    (md: string): void => {
      // 写回属宿主能力：渠道端（只读）无 HostApi，保存置为 failed 状态
      const host = getHostApi()
      if (!host) {
        setSaveStatus('failed')
        return
      }
      // 记录我们写入磁盘的内容，使随后的 files.changed 不被当成外部写回而触发重挂载
      lastSyncedContentRef.current = md
      void host.files.write({ sessionId, path, content: md }).then((r) => {
        if (!r.ok) setSaveStatus('failed')
      })
    },
    [sessionId, path]
  )

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
      {/* 保存状态浮层（仅保存中/失败时出现）—— 顶栏已交给 ChatHeader，故这里浮层提示 */}
      {(saveStatus === 'saving' || saveStatus === 'failed') && (
        <div
          className={`absolute top-1.5 right-2 z-10 px-1.5 py-0.5 rounded text-[10px] pointer-events-none ${
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
        readOnly={viewOnly}
        onSave={onSave}
        onSaveStatusChange={setSaveStatus}
        handleRef={editorRef}
        fileContext={fileContext}
        caps={caps}
      />
    </div>
  )
}
