/**
 * 扩展端会话面板装配 —— 复用共享 SessionPanel 卡片（app-shell），仅在此注入扩展专属件：
 *   - extMediaResolver：媒体/PDF 经 File System Access 读字节生成 blob: URL（中间区笔记本也复用）
 *   - FilesTab：FSA 权限门控包装（扩展重载后用户文件夹授权会掉到 'prompt'，需用户手势重授权）
 * 胶囊工具栏 / 卡片状态 / 揭示逻辑全在共享层（SessionToolbar / useSessionPanelStore /
 * useSessionPanelReveal），本文件不含面板交互逻辑。
 */
import { useCallback, useEffect, useState } from 'react'
import { FolderLock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@shuvix/chat-ui'
import {
  FilesPanel,
  MediaUrlProvider,
  PreviewPanel,
  SessionPanel,
  useCreateNotebook,
  type ResolveMediaUrl
} from '@shuvix/app-shell'
import {
  resolveMediaObjectUrl,
  workingDirPermission,
  requestWorkingDirPermission
} from '../runtime/filesRuntime'

/** 浏览器媒体/PDF：读字节生成 blob: object URL（用完 revoke）。中间区 NotebookView 也复用 */
export const extMediaResolver: ResolveMediaUrl = ({ sessionId, path }) =>
  resolveMediaObjectUrl(sessionId, path)

/**
 * Files 权限门控 —— FSA 用户文件夹的读写授权在扩展重载后会失效（掉到 'prompt'），
 * 此时 scan 的 entries() 会抛错被吞成空树。这里先 query 权限，未授权则显示授权按钮
 * （onClick 是用户手势，可合法 requestPermission）；OPFS 临时目录恒 granted，直接过。
 */
function FilesTab(): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const [gate, setGate] = useState<{ status: PermissionState | 'none' | 'loading'; name: string }>({
    status: 'loading',
    name: ''
  })

  const check = useCallback(async () => {
    if (!sessionId) {
      setGate({ status: 'none', name: '' })
      return
    }
    setGate(await workingDirPermission(sessionId).then((r) => ({ ...r })))
  }, [sessionId])

  useEffect(() => {
    void check()
  }, [check])

  // 权限查询中：先不挂 FilesPanel，避免未授权时触发一次注定空的 scan
  if (gate.status === 'loading') {
    return <div className="h-full" />
  }
  // 已授权 / 无工作目录（临时会话恒 granted）→ 交给共享 FilesPanel
  // （文件点击发预览请求，由 ExtMainLayout 的 PreviewOverlay 承接展示）
  if (gate.status !== 'prompt' && gate.status !== 'denied') {
    return <FilesPanel />
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <FolderLock size={28} className="text-text-tertiary/60" />
      <div className="text-xs text-text-secondary">
        {t('panel.filesPermissionNeeded', { name: gate.name })}
      </div>
      <button
        onClick={async () => {
          if (await requestWorkingDirPermission(sessionId!)) void check()
        }}
        className="px-3 py-1.5 text-xs rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
      >
        {t('panel.filesGrantAccess')}
      </button>
    </div>
  )
}

/** 会话面板（扩展装配）：共享卡片 + 扩展媒体解析 + 权限门控 Files 内容 + Preview 工具页 */
export function ExtSessionPanel({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  // Side Panel 无 app 级右侧栏，独立预览（preview 工具事件 / Files 点击 / wiki-link）在此工具页展示；
  // .md 预览顶栏「创建笔记本」绑定该文件（扩展中间区已支持 NotebookView）
  const createNotebook = useCreateNotebook()
  return (
    <MediaUrlProvider value={extMediaResolver}>
      <SessionPanel
        sessionId={sessionId}
        filesContent={<FilesTab />}
        previewContent={<PreviewPanel onCreateNotebook={createNotebook} />}
      />
    </MediaUrlProvider>
  )
}
