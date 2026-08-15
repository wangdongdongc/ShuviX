import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { type ToolItem } from '../common/ToolSelectList'
import { ProjectConfigDialog, ProjectInfoForm, type ProjectConfigTab } from '@shuvix/app-shell'
import {
  ProjectFileSystem,
  ExtensionsPanel,
  ProjectSystemPromptGroup,
  ProjectPgLiteSection,
  ProjectEnvVarsSection,
  type EnvVar
} from './ProjectFormSections'

interface ProjectEditDialogProps {
  projectId: string
  onClose: () => void
}

type EditTab = 'extensions' | 'project' | 'advanced'

/** Skills 分组标识 */
const SKILLS_GROUP = '__skills__'

/**
 * 项目编辑弹窗 —— 复用共享 ProjectConfigDialog 外壳 + ProjectInfoForm（项目信息），
 * 桌面专属的文件系统/提示词/扩展能力/高级配置段作为 tab 内容注入。
 */
export function ProjectEditDialog({
  projectId,
  onClose
}: ProjectEditDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()

  const [tab, setTab] = useState<EditTab>('project')

  // 项目字段
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [pglitePersist, setPglitePersist] = useState(false)
  const [envVars, setEnvVars] = useState<EnvVar[]>([])

  // 加载项目数据 + 工具列表
  useEffect(() => {
    Promise.all([window.api.project.getById(projectId), window.api.tools.list()]).then(
      ([project, tools]) => {
        setAllTools(tools)
        const defaultExtensions = (): string[] => {
          const connectedMcp = tools
            .filter((t) => t.group?.startsWith('mcp:') && t.serverStatus === 'connected')
            .map((t) => t.name)
          const enabledSkills = tools.filter((t) => t.group === SKILLS_GROUP).map((t) => t.name)
          return [...new Set([...connectedMcp, ...enabledSkills])]
        }
        if (project) {
          setName(project.name)
          setPath(project.path)
          setSystemPrompt(project.systemPrompt ?? '')
          const settings = project.settings || {}
          if (Array.isArray(settings.enabledTools)) {
            setEnabledTools(settings.enabledTools)
          } else {
            setEnabledTools(defaultExtensions())
          }
          if (settings.tool?.pglitePersist) {
            setPglitePersist(true)
          }
          if (Array.isArray(settings.tool?.envVars)) {
            setEnvVars(settings.tool.envVars)
          }
        } else {
          setEnabledTools(defaultExtensions())
        }
        setLoading(false)
      }
    )
  }, [projectId])

  // MCP / Skills 工具
  const mcpTools = allTools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)

  const handleSelectFolder = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) setPath(result)
  }

  const handleOpenSettings = (): void => {
    window.api.app.openSettings()
  }

  const toggleExtTool = (toolName: string): void => {
    setEnabledTools((prev) =>
      prev.includes(toolName) ? prev.filter((n) => n !== toolName) : [...prev, toolName]
    )
  }

  const handleArchive = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.project.update({ id: projectId, archived: true })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.project.update({
        id: projectId,
        name: name.trim() || undefined,
        path: path || undefined,
        systemPrompt,
        enabledTools,
        tool: {
          pglitePersist,
          envVars: envVars.filter((v) => v.key.trim()).length
            ? envVars.filter((v) => v.key.trim())
            : undefined
        }
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  const tabs: ProjectConfigTab[] = [
    {
      key: 'project',
      label: t('projectForm.wizardStepProject'),
      content: (
        <ProjectInfoForm name={name} onNameChange={setName}>
          <ProjectFileSystem path={path} onSelectFolder={handleSelectFolder} />
          <ProjectSystemPromptGroup value={systemPrompt} onChange={setSystemPrompt} />
        </ProjectInfoForm>
      )
    },
    {
      key: 'extensions',
      label: t('projectForm.wizardStepExtensions'),
      content: (
        <ExtensionsPanel
          mcpTools={mcpTools}
          skillTools={skillTools}
          enabledTools={enabledTools}
          onToggle={toggleExtTool}
          onOpenSettings={handleOpenSettings}
        />
      )
    },
    {
      key: 'advanced',
      label: t('projectForm.wizardStepAdvanced'),
      content: (
        <>
          <ProjectPgLiteSection pglitePersist={pglitePersist} onChange={setPglitePersist} />
          <ProjectEnvVarsSection envVars={envVars} onChange={setEnvVars} />
        </>
      )
    }
  ]

  return (
    <ProjectConfigDialog
      title={t('projectForm.editTitle')}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(k) => setTab(k as EditTab)}
      onClose={onClose}
      onSave={handleSave}
      onArchive={handleArchive}
      saving={saving}
    />
  )
}
