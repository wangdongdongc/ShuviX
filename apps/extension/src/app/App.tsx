import { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  ArrowLeft,
  PlugZap,
  Info,
  FolderPlus,
  FolderClosed,
  RotateCcw,
  Trash2,
  Archive,
  ChevronUp
} from 'lucide-react'
import {
  ChatHostProvider,
  Conversation,
  useChatStore,
  useChatHost,
  selectAllPendingCounts,
  getChatApi,
  useSessionInit,
  useAgentEvents,
  type Session
} from '@shuvix/chat-ui'
import type { Project } from '@shuvix/chat-protocol/chatApi'
import {
  SettingsContainer,
  AppearanceTab,
  AboutTab,
  ProviderTab,
  ModelDefaultsSettings,
  McpClientPanel,
  ProjectConfigDialog,
  ProjectInfoForm,
  SessionItem,
  SessionGroup,
  useSessionDelete,
  useFocusDim,
  type SettingsTab,
  type ProviderTabApi
} from '@shuvix/app-shell'
import type { ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import i18n from './i18n'
import { useExtensionChatHost } from './chatHost'
import { useAppearance, setAppearance } from './appearanceStore'
import { settingsStore } from '../storage/settingsStore'
import { projectStore } from '../storage/projectStore'

/** 会话级运行时 hook 宿主（须在 ChatHostProvider 之下） */
function SessionRuntime({ sessionId }: { sessionId: string | null }): null {
  useSessionInit(sessionId)
  useAgentEvents()
  return null
}

/** 简易 hash 路由：#settings 显示设置，否则主界面 */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

/** 刷新会话列表到 chatStore（供共享侧栏 SessionGroup 渲染） */
async function refreshSessions(): Promise<void> {
  const sessions = await getChatApi().session.list()
  useChatStore.getState().setSessions(sessions)
}

const extProviderApi: ProviderTabApi = {
  listModels: (id) => getChatApi().provider.listModels(id),
  toggleEnabled: (p) => getChatApi().provider.toggleEnabled(p),
  toggleModelEnabled: (p) => getChatApi().provider.toggleModelEnabled(p),
  updateConfig: (p) => getChatApi().provider.updateConfig(p),
  add: (p) => getChatApi().provider.add(p),
  addModel: (p) => getChatApi().provider.addModel(p),
  deleteModel: (id) => getChatApi().provider.deleteModel(id),
  syncModels: (p) => getChatApi().provider.syncModels(p),
  updateModelCapabilities: (p) =>
    getChatApi().provider.updateModelCapabilities(
      p as Parameters<ReturnType<typeof getChatApi>['provider']['updateModelCapabilities']>[0]
    )
}

/** 扩展提供商 tab 绑定层 —— 复用共享 ProviderTab（全功能），数据走 chrome.storage provider 存储 */
function ExtProviderTab(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const load = useCallback(() => {
    setProviders(settingsStore.listProviders())
  }, [])
  useEffect(() => {
    load()
  }, [load])
  return (
    <ProviderTab
      providers={providers}
      api={extProviderApi}
      onChanged={load}
      caps={{ providerCrud: true }}
      onRequestDeleteProvider={async (p) => {
        if (!window.confirm(`删除提供商 ${p.displayName || p.name}？`)) return
        await getChatApi().provider.delete({ id: p.id })
        load()
      }}
    />
  )
}

/** 扩展外观 tab 绑定层（appearanceStore + chrome.storage；隐藏笔记本主题/缩放）。
 *  默认模型一节复用共享 ModelDefaultsSettings：可用模型现读 settingsStore（保证启用后即刷新），
 *  选中值/持久化走 ChatHost.models（即 session.create 用的默认模型）。标题模型扩展用启发式，关闭。 */
function ExtAppearanceTab(): React.JSX.Element {
  const a = useAppearance()
  const { models } = useChatHost()
  const [availableModels, setAvailableModels] = useState(() => settingsStore.listAvailableModels())
  useEffect(() => {
    setAvailableModels(settingsStore.listAvailableModels())
  }, [])
  return (
    <>
      <AppearanceTab
        theme={a.theme}
        darkTheme={a.darkTheme}
        lightTheme={a.lightTheme}
        fontSize={a.fontSize}
        focusMode={a.focusMode}
        language={i18n.language}
        caps={{ showLanguage: true, showNotebookTheme: false, showUiZoom: false }}
        onThemeChange={(theme) => setAppearance({ theme })}
        onDarkThemeChange={(darkTheme) => setAppearance({ darkTheme })}
        onLightThemeChange={(lightTheme) => setAppearance({ lightTheme })}
        onFontSizeChange={(fontSize) => setAppearance({ fontSize })}
        onFocusModeToggle={() => setAppearance({ focusMode: !a.focusMode })}
        onLanguageChange={(lng) => {
          void i18n.changeLanguage(lng)
          void settingsStore.set('language', lng)
        }}
      />
      <ModelDefaultsSettings
        availableModels={availableModels}
        defaultProvider={models.activeProvider}
        defaultModel={models.activeModel}
        setDefaultProvider={models.setActiveProvider}
        setDefaultModel={models.setActiveModel}
        caps={{ showTitleModel: false }}
      />
    </>
  )
}

const TEMP_GROUP_KEY = '__temp__'

/** 扩展侧栏 —— 与桌面同构：标题行(+打开文件夹) + 项目分组 + 临时对话组（复用共享 SessionGroup/SessionItem）+ 底部设置 */
function ExtSidebar({
  onNew,
  onDelete,
  onOpenSettings
}: {
  onNew: (projectId?: string | null) => void | Promise<void>
  onDelete: (id: string) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const setSessions = useChatStore((s) => s.setSessions)
  const sessionStreams = useChatStore((s) => s.sessionStreams)
  const pendingCounts = useChatStore(selectAllPendingCounts)
  const { dim } = useFocusDim()

  const [projects, setProjects] = useState<Project[]>([])
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [archivedCollapsed, setArchivedCollapsed] = useState(true)

  const reloadProjects = useCallback(() => {
    void getChatApi().project.list().then(setProjects)
    void getChatApi().project.listArchived().then(setArchivedProjects)
  }, [])
  useEffect(() => {
    reloadProjects()
    return getChatApi().project.onChanged(reloadProjects)
  }, [reloadProjects])

  // 按项目分组：每个项目一组（含空组）+ 临时对话组（projectId 为空的会话）
  const groups = useMemo(() => {
    type Grp = { key: string; label: string; variant: 'project' | 'temp'; sessions: Session[] }
    const byProject = new Map<string, Session[]>()
    for (const p of projects) byProject.set(p.id, [])
    const temp: Session[] = []
    for (const s of sessions) {
      if (s.projectId && byProject.has(s.projectId)) byProject.get(s.projectId)!.push(s)
      else if (!s.projectId) temp.push(s) // 已归档项目的会话不在此显示（其项目不在活动列表）
    }
    const out: Grp[] = projects.map((p) => ({
      key: p.id,
      label: p.name,
      variant: 'project',
      sessions: byProject.get(p.id)!
    }))
    out.push({
      key: TEMP_GROUP_KEY,
      label: t('sidebar.tempChats'),
      variant: 'temp',
      sessions: temp
    })
    return out
  }, [projects, sessions, t])

  const activeGroupKey = useMemo(() => {
    if (!activeSessionId) return null
    const s = sessions.find((x) => x.id === activeSessionId)
    return s?.projectId || TEMP_GROUP_KEY
  }, [activeSessionId, sessions])

  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  /** 打开文件夹 → 建项目 → 在该项目下新建会话 */
  const openFolder = async (): Promise<void> => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      const proj = await projectStore.createFromHandle(handle)
      reloadProjects()
      await onNew(proj.id)
    } catch {
      /* 用户取消选择 */
    }
  }

  /** 恢复归档项目 */
  const restoreProject = async (id: string): Promise<void> => {
    await getChatApi().project.update({ id, archived: false })
    reloadProjects()
  }

  /** 删除项目（级联其会话，需确认）—— 仅从「已归档」区触发 */
  const deleteProject = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(t('sidebar.confirmDeleteProject') + `\n${name}`)) return
    await getChatApi().project.delete({ id })
    setSessions(await getChatApi().session.list())
    reloadProjects()
  }

  const empty = sessions.length === 0 && projects.length === 0 && archivedProjects.length === 0

  return (
    <div className="flex flex-col h-full bg-bg-secondary/50">
      {/* 标题行 + 打开文件夹（与桌面同构） */}
      <div
        className={`flex items-center pl-3 pr-2 pt-3 pb-2 transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
      >
        <h1 className="text-[13px] font-medium text-text-tertiary tracking-wide uppercase">
          ShuviX
        </h1>
        <button
          onClick={() => void openFolder()}
          title={t('sidebar.newProject')}
          className="ml-auto p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <FolderPlus size={14} />
        </button>
      </div>
      {/* 分组列表（项目组 + 临时对话组） */}
      <div className="flex-1 overflow-y-auto pl-2 pr-1 py-1 no-scrollbar">
        {empty ? (
          <div className="px-3 py-8 text-center text-text-tertiary text-xs">
            {t('sidebar.emptyHint')}
          </div>
        ) : (
          groups.map((g, idx) => {
            const isTemp = g.variant === 'temp'
            return (
              <SessionGroup
                key={g.key}
                label={g.label}
                variant={g.variant}
                collapsed={collapsed.has(g.key)}
                onToggle={() => toggle(g.key)}
                onNewChat={() => void onNew(isTemp ? null : g.key)}
                active={activeGroupKey === g.key}
                dim={dim && activeGroupKey !== g.key}
                showDividerAbove={isTemp && idx > 0}
                onEdit={isTemp ? undefined : () => setEditingProjectId(g.key)}
              >
                {g.sessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={activeSessionId === s.id}
                    isStreaming={sessionStreams[s.id]?.isStreaming}
                    pendingCount={pendingCounts[s.id]}
                    dim={dim && activeGroupKey === g.key}
                    onSelect={setActiveSessionId}
                    onDelete={onDelete}
                  />
                ))}
              </SessionGroup>
            )
          })
        )}
      </div>
      {/* 已归档项目（恢复 / 删除），对齐桌面 */}
      {archivedProjects.length > 0 && (
        <div className="flex-shrink-0 border-t border-border-secondary/30 px-2 pt-1">
          {!archivedCollapsed && (
            <div className="ml-1.5 pl-0.5 max-h-48 overflow-y-auto no-scrollbar">
              {archivedProjects.map((p) => (
                <div
                  key={p.id}
                  className="group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 text-text-secondary"
                >
                  <FolderClosed size={11} className="flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[13px] group-hover:pr-12">
                    {p.name}
                  </span>
                  <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => void restoreProject(p.id)}
                      className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/60 hover:text-text-secondary"
                      title={t('sidebar.restoreProject')}
                    >
                      <RotateCcw size={11} className="text-green-400/70" />
                    </button>
                    <button
                      onClick={() => void deleteProject(p.id, p.name)}
                      className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/60 hover:text-error"
                      title={t('sidebar.deleteProject')}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => setArchivedCollapsed((c) => !c)}
            className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-[12px] text-text-secondary hover:text-text-primary transition-colors"
          >
            <Archive size={11} className="flex-shrink-0" />
            <span className="truncate font-medium uppercase tracking-wider">
              {t('sidebar.archivedProjects')}
            </span>
            <ChevronUp
              size={11}
              className={`ml-auto flex-shrink-0 text-text-tertiary/60 transition-transform ${archivedCollapsed ? '' : 'rotate-180'}`}
            />
          </button>
        </div>
      )}
      {/* 底部设置栏（对齐桌面） */}
      <div
        className={`flex items-center gap-1 px-2 py-1 border-t border-border-secondary/30 transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
      >
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 flex-1 pl-3 pr-2 py-1.5 rounded-md text-[13px] text-text-tertiary hover:bg-bg-hover/60 hover:text-text-secondary transition-colors"
        >
          <Settings size={14} className="text-text-tertiary/70" />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>

      {editingProjectId && (
        <ExtProjectDialog projectId={editingProjectId} onClose={() => setEditingProjectId(null)} />
      )}
    </div>
  )
}

/** 扩展项目配置弹窗 —— 复用共享 ProjectConfigDialog（仅「项目信息」tab）+ 归档 */
function ExtProjectDialog({
  projectId,
  onClose
}: {
  projectId: string
  onClose: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void getChatApi()
      .project.getById(projectId)
      .then((p) => {
        if (p) {
          setName(p.name)
          setPath(p.path)
        }
        setLoaded(true)
      })
  }, [projectId])

  if (!loaded) return null

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await getChatApi().project.update({ id: projectId, name: name.trim() || undefined })
      onClose()
    } finally {
      setSaving(false)
    }
  }
  const archive = async (): Promise<void> => {
    await getChatApi().project.update({ id: projectId, archived: true })
    onClose()
  }

  return (
    <ProjectConfigDialog
      title={t('projectForm.editTitle')}
      tabs={[
        {
          key: 'project',
          label: t('projectForm.wizardStepProject'),
          content: <ProjectInfoForm name={name} onNameChange={setName} path={path} />
        }
      ]}
      activeTab="project"
      onTabChange={() => {}}
      onClose={onClose}
      onSave={save}
      saving={saving}
      onArchive={archive}
    />
  )
}

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const host = useExtensionChatHost()
  const route = useHashRoute()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)

  // 启动即初始化会话（API Key 在「设置 → 提供商」里配置，与桌面一致；无 key 时对话会报错引导）
  useEffect(() => {
    void (async () => {
      await refreshSessions()
      const list = useChatStore.getState().sessions
      const sid = list[0]?.id ?? (await getChatApi().session.create(null)).id
      await refreshSessions()
      setActiveSessionId(sid)
    })()
  }, [setActiveSessionId])

  // 跟随 chatStore 活跃会话（侧栏点击切换）
  useEffect(() => {
    setSessionId(activeSessionId)
  }, [activeSessionId])

  const handleNew = useCallback(
    async (projectId?: string | null) => {
      const s = await getChatApi().session.create(projectId ?? null)
      await refreshSessions()
      setActiveSessionId(s.id)
    },
    [setActiveSessionId]
  )

  // 删除会话全流程走共享 useSessionDelete（含消息时弹共享 ConfirmDialog），与桌面同一套
  const { requestDelete: handleDelete, deleteDialog } = useSessionDelete()

  // 设置路由
  if (route.startsWith('#settings')) {
    const tabs: SettingsTab[] = [
      {
        id: 'appearance',
        label: t('settings.tabGeneral'),
        icon: <Settings size={14} />,
        content: (
          <div className="flex-1 overflow-y-auto">
            <ExtAppearanceTab />
          </div>
        )
      },
      {
        id: 'providers',
        label: t('settings.tabProviders'),
        icon: <Settings size={14} />,
        content: <ExtProviderTab />
      },
      {
        id: 'mcp',
        label: t('settings.tabMcp'),
        icon: <PlugZap size={14} />,
        content: (
          <div className="flex-1 overflow-y-auto">
            {/* 扩展仅 http（浏览器无法跑本地进程）→ allowStdio:false */}
            <McpClientPanel api={getChatApi().mcp} caps={{ allowStdio: false }} />
          </div>
        )
      },
      {
        id: 'about',
        label: t('settings.tabAbout'),
        icon: <Info size={14} />,
        content: (
          <div className="flex-1 overflow-y-auto">
            {/* 复用共享 AboutTab；扩展不注入 update → 屏蔽自动更新，其余与桌面完全一致 */}
            <AboutTab
              appVersion={chrome.runtime.getManifest().version}
              openExternal={(url) => window.open(url, '_blank', 'noopener')}
            />
          </div>
        )
      }
    ]
    const activeTab = route.replace(/^#settings\/?/, '') || 'appearance'
    return (
      <ChatHostProvider value={host}>
        <div className="h-full flex flex-col bg-bg-primary text-text-primary">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-secondary bg-bg-secondary">
            <button
              onClick={() => {
                window.location.hash = ''
              }}
              className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <span className="text-sm font-medium">{t('settings.title')}</span>
          </div>
          <div className="flex-1 min-h-0">
            <SettingsContainer
              tabs={tabs}
              activeTab={tabs.some((x) => x.id === activeTab) ? activeTab : 'appearance'}
              onTabChange={(id) => {
                window.location.hash = `#settings/${id}`
              }}
              title={t('settings.title')}
            />
          </div>
        </div>
      </ChatHostProvider>
    )
  }

  // 主界面：侧栏（会话列表）+ 对话
  return (
    <ChatHostProvider value={host}>
      <SessionRuntime sessionId={sessionId} />
      <div className="h-full flex bg-bg-primary text-text-primary">
        <div className="w-60 flex-shrink-0 border-r border-border-secondary">
          <ExtSidebar
            onNew={handleNew}
            onDelete={handleDelete}
            onOpenSettings={() => {
              window.location.hash = '#settings'
            }}
          />
        </div>
        {/* Conversation 是 Fragment（messages flex-1 + InputArea），需宿主提供 flex 列容器 + 定高 */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {sessionId && <Conversation sessionId={sessionId} />}
        </div>
      </div>
      {deleteDialog}
    </ChatHostProvider>
  )
}
