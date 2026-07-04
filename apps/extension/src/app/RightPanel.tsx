/**
 * 扩展右侧面板 —— 复用共享 FilesPanel / SubAgentPanel（app-shell），仅在此装配 tab 外壳。
 *
 * 与桌面 RightPanel 同构（标签栏 + 始终挂载、visibility 切换避免 pierre 树重建），
 * 但只含 files + subagent 两个 tab。媒体/PDF 经 MediaUrlProvider 注入 blob URL 解析（File System Access）。
 */
import { useCallback, useEffect, useState } from 'react'
import { FolderTree, Bot, FolderLock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore, useSubAgentCount } from '@shuvix/chat-ui'
import {
  FilesPanel,
  SubAgentPanel,
  MediaUrlProvider,
  useCreateNotebook,
  PanelTabBar,
  usePanelStore,
  type ResolveMediaUrl,
  type PanelTabItem
} from '@shuvix/app-shell'
import {
  resolveMediaObjectUrl,
  workingDirPermission,
  requestWorkingDirPermission
} from '../runtime/filesRuntime'
import { type PanelTab } from './panelStore'

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
  const createNotebook = useCreateNotebook()
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
  // .md 预览顶栏「创建笔记本」绑定该文件（扩展中间区也已支持 NotebookView）
  if (gate.status !== 'prompt' && gate.status !== 'denied') {
    return <FilesPanel onCreateNotebook={createNotebook} />
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

const TABS: { key: PanelTab; labelKey: string; Icon: typeof FolderTree }[] = [
  { key: 'files', labelKey: 'panel.files', Icon: FolderTree },
  { key: 'subagent', labelKey: 'panel.subAgent', Icon: Bot }
]

export function RightPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = usePanelStore((s) => s.activeTab)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // Sub-agent tab 仅在当前主会话有子会话时显示（共享 useSubAgentCount，与桌面同口径）
  const subAgentCount = useSubAgentCount(activeSessionId)
  const tabItems: PanelTabItem[] = TABS.filter((tab) =>
    tab.key === 'subagent' ? subAgentCount > 0 : true
  ).map(({ key, labelKey, Icon }) => ({
    key,
    label: t(labelKey),
    Icon,
    badge: key === 'subagent' ? subAgentCount : undefined
  }))

  // 当前 tab 被隐藏（子会话清空后停在 subagent）→ 自动切回 files
  useEffect(() => {
    if (activeTab === 'subagent' && subAgentCount === 0)
      usePanelStore.getState().setActiveTab('files')
  }, [activeTab, subAgentCount])

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* 标签栏（共享 PanelTabBar，与桌面统一外观） */}
      <PanelTabBar
        tabs={tabItems}
        activeKey={activeTab}
        onSelect={(key) => usePanelStore.getState().setActiveTab(key)}
      />

      {/* 内容区 —— 两个面板始终挂载，visibility 切换（避免 pierre 文件树重建） */}
      <div className="flex-1 min-h-0 relative">
        <MediaUrlProvider value={extMediaResolver}>
          <div
            className="absolute inset-0"
            style={
              activeTab === 'files' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
            }
          >
            <FilesTab />
          </div>
          <div
            className="absolute inset-0"
            style={
              activeTab === 'subagent' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
            }
          >
            <SubAgentPanel />
          </div>
        </MediaUrlProvider>
      </div>
    </div>
  )
}
