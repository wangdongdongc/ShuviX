import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { useSidebarStore } from '../../stores/sidebarStore'
import {
  LivePreviewEditor,
  type LivePreviewEditorHandle,
  type SaveStatus
} from './LivePreviewEditor'

/** failed = files.write 越权/IO 失败；其余同笔记本 */
type FileSaveStatus = SaveStatus | 'failed'

/** 拆分绝对路径为 (filename, parentDir)，兼容 POSIX 与 Windows 分隔符 */
function splitPath(absolute: string): { fileName: string; parentDir: string } {
  const s = absolute.replace(/[/\\]+$/, '')
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (idx < 0) return { fileName: s, parentDir: '' }
  return { fileName: s.slice(idx + 1), parentDir: s.slice(0, idx) }
}

/**
 * MarkdownFileView —— 从右侧文件面板点击 .md 打开的项目文件，在中间区做 live-preview 编辑。
 * 复用 LivePreviewEditor：经 files API 读写真实项目文件、标题栏显示文件名 + 父目录（不可重命名）、
 * 提供「关闭」回到原会话。
 */
export function MarkdownFileView({
  path,
  sessionId
}: {
  path: string
  sessionId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { isOpen: isSidebarOpen, toggle: toggleSidebar } = useSidebarStore()
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)

  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<FileSaveStatus>('saved')
  const [scrolled, setScrolled] = useState(false)

  const editorRef = useRef<LivePreviewEditorHandle | null>(null)
  const { fileName, parentDir } = splitPath(path)
  // 双链解析上下文（[[file]] / ![[image]] 按文件名在该会话工作目录内解析）
  const fileContext = useMemo(() => ({ sessionId }), [sessionId])

  // 加载文件内容。App 处用 key={path} 让本组件按文件重挂载，故无需在此重置 state；
  // 待保存 flush 由 LivePreviewEditor 卸载时负责。
  useEffect(() => {
    let cancelled = false
    window.api.files
      .read({ sessionId, path })
      .then((r) => {
        if (cancelled) return
        if (r.kind === 'text') setContent(r.content)
        else if (r.kind === 'error') setError(r.message)
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
      void window.api.files.write({ sessionId, path, content: md }).then((r) => {
        if (!r.ok) setSaveStatus('failed')
      })
    },
    [sessionId, path]
  )

  return (
    <div className="flex flex-col h-full">
      {/* 标题栏：左侧文件名 + 灰显父目录；右侧保存状态 + 关闭 + 侧栏开关 */}
      <div
        className={`notebook-titlebar titlebar-drag flex-shrink-0 flex items-center px-2 ${
          scrolled ? 'is-scrolled' : ''
        } ${window.api.app.platform === 'darwin' ? 'h-10' : 'h-8'}`}
      >
        <div className="flex items-baseline gap-1.5 min-w-0 flex-1 px-2">
          <span className="text-xs font-medium text-text-secondary truncate" title={fileName}>
            {fileName}
          </span>
          {parentDir && (
            <span className="text-[10px] text-text-tertiary/70 truncate" title={parentDir}>
              {parentDir}
            </span>
          )}
        </div>

        <div className="titlebar-no-drag flex items-center gap-0.5 flex-shrink-0">
          {saveStatus === 'saving' && (
            <span className="text-[11px] text-text-tertiary px-1">{t('notebook.saving')}</span>
          )}
          {saveStatus === 'failed' && (
            <span className="text-[11px] text-red-500/80 px-1">{t('notebook.saveFailed')}</span>
          )}
          <button
            onClick={() => setActiveSessionId(sessionId)}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title={t('notebook.closeFile')}
          >
            <X size={14} />
          </button>
          {window.api?.app?.platform !== 'web' && (
            <button
              onClick={toggleSidebar}
              className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
                {isSidebarOpen && (
                  <rect
                    x="3"
                    y="3"
                    width="6"
                    height="18"
                    rx="2"
                    fill="currentColor"
                    stroke="none"
                  />
                )}
              </svg>
            </button>
          )}
        </div>
      </div>

      {error !== null ? (
        <div className="flex-1 flex items-center justify-center text-xs text-text-tertiary px-6 text-center break-all">
          {error}
        </div>
      ) : (
        content !== null && (
          <LivePreviewEditor
            documentId={path}
            initialContent={content}
            onSave={onSave}
            onScrolledChange={setScrolled}
            onSaveStatusChange={setSaveStatus}
            handleRef={editorRef}
            fileContext={fileContext}
          />
        )
      )}
    </div>
  )
}
