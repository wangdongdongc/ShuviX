import { useEffect, useRef, useState } from 'react'
import {
  LivePreviewEditor,
  MediaUrlProvider,
  NotebookView,
  shuvixPreviewResolver
} from '@shuvix/app-shell'
import { useAppEvent } from '@shuvix/chat-ui'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * 设置页三个注册表 tab（智能体 / 安全策略 / 工作流）共用的详情区。
 *
 * 用户文件的详情**就是这份文件的笔记本会话**：经 `<kind>.openNote` 打开 / 复用它（隐藏项目，
 * 与侧栏 Bots、知识库条目同一条路），正文嵌笔记本同一个 NotebookView —— live-preview、防抖自动
 * 保存、外部改动（agent 改盘、外部编辑器）自动重载，解析器的判定由属性卡实时显示。与笔记本页面
 * 的差别只有排版（fill：设置页自带边距）和没有底部输入卡片。内置条目没有文件，是等价 md 的只读
 * 查看（BuiltinSourceView）。
 */

export type SettingsRegistryKind = 'agent' | 'policy' | 'workflow'

const OPEN_NOTE: Record<
  SettingsRegistryKind,
  (params: { fileName: string }) => Promise<SessionInfo>
> = {
  agent: (params) => window.api.subAgent.openNote(params),
  policy: (params) => window.api.policy.openNote(params),
  workflow: (params) => window.api.workflow.openNote(params)
}

/** 文件变更 → 父组件重扫列表的合并窗口（自动保存每 200ms 落一次盘，连续打字只重扫一次） */
const CHANGED_DEBOUNCE_MS = 300

export function RegistryNoteView({
  kind,
  fileName,
  onFileChanged
}: {
  kind: SettingsRegistryKind
  /** 注册表目录下的文件名（父组件按它 key 重挂载） */
  fileName: string
  /** 这份文件在磁盘上变了（自动保存或外部写入），合并窗口内至多一次 —— 父组件据此重扫列表 */
  onFileChanged?: () => void
}): React.JSX.Element | null {
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)
  const [note, setNote] = useState<{ sessionId: string; root: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    OPEN_NOTE[kind]({ fileName })
      .then((session) => {
        if (alive) setNote({ sessionId: session.id, root: session.workingDirectory ?? '' })
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [kind, fileName])

  // 笔记本自己监听着这份文件（files.watch），变更经 files.changed 广播 —— 按工作目录认出是它
  const onFileChangedRef = useRef(onFileChanged)
  useEffect(() => {
    onFileChangedRef.current = onFileChanged
  })
  const changedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useAppEvent('files.changed', (e) => {
    if (!note?.root || e.root !== note.root) return
    if (changedTimer.current) clearTimeout(changedTimer.current)
    changedTimer.current = setTimeout(() => {
      changedTimer.current = null
      onFileChangedRef.current?.()
    }, CHANGED_DEBOUNCE_MS)
  })
  useEffect(
    () => () => {
      if (changedTimer.current) clearTimeout(changedTimer.current)
    },
    []
  )

  if (error) {
    return (
      <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
        {error}
      </div>
    )
  }
  if (!note) return null
  return (
    // 不限高：CM6 随文档自然增长、无内部滚动，整页统一滚动（详情列 overflow-y-auto）
    <div className="min-h-[320px] p-2" data-registry-note={fileName}>
      <MediaUrlProvider value={shuvixPreviewResolver}>
        <NotebookView
          key={note.sessionId}
          path={fileName}
          sessionId={note.sessionId}
          layout="fill"
          caps={{
            notebookTheme,
            openExternal: (url) => void window.api.app.openExternal(url),
            popupContextMenu: (request) => window.api.contextMenu.popup(request)
          }}
        />
      </MediaUrlProvider>
    </div>
  )
}

/** 内置条目（随包发布、没有文件）的只读查看：等价 md 的 live-preview，属性卡控件全部禁用 */
export function BuiltinSourceView({
  documentId,
  text
}: {
  documentId: string
  text: string
}): React.JSX.Element {
  return (
    <div className="min-h-[320px] p-2">
      <LivePreviewEditor layout="fill" readOnly documentId={documentId} initialContent={text} />
    </div>
  )
}
