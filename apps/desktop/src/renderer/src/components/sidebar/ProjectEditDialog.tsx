import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { type ToolItem } from '../common/ToolSelectList'
import {
  ExtensionsSection,
  KnowledgeBasesSection,
  ProjectConfigDialog,
  ProjectInfoForm,
  type ProjectConfigTab
} from '@shuvix/app-shell'
import { ProjectEnvVarsSection, type EnvVar } from './ProjectFormSections'

interface ProjectEditDialogProps {
  projectId: string
  onClose: () => void
}

/** Skills 分组标识 */
const SKILLS_GROUP = '__skills__'

/**
 * 项目编辑弹窗 —— 复用共享 ProjectConfigDialog 外壳 + ProjectInfoForm（名称 + 文件夹 + 项目提示词），
 * 桌面专属的扩展能力/环境变量作为 children 并进同一个「配置」tab（单 tab，外壳自动隐藏切换条）。
 */
export function ProjectEditDialog({
  projectId,
  onClose
}: ProjectEditDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()

  // 项目字段
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  // 知识库：候选项来自宿主，勾选来自项目设置；没设过就一个都不勾（缺省本身就是空的，
  // 见 sessionBundle.selectedBaseNames），而且不写回 —— 用户动过才存，否则一次
  // 「打开看看就关掉」会把此刻这份冻成快照，这个项目从此不再跟着缺省走
  const [kbOptions, setKbOptions] = useState<{ name: string; label: string }[]>([])
  const [knowledgeBases, setKnowledgeBases] = useState<string[]>([])
  const [kbTouched, setKbTouched] = useState(false)
  const [envVars, setEnvVars] = useState<EnvVar[]>([])

  // 加载项目数据 + 工具列表
  useEffect(() => {
    Promise.all([
      window.api.project.getById(projectId),
      window.api.tools.list(),
      window.api.knowledge.baseOptions()
    ]).then(([project, tools, kb]) => {
      setAllTools(tools)
      setKbOptions(kb.options)
      if (project) {
        setName(project.name)
        setPath(project.path)
        setSystemPrompt(project.systemPrompt ?? '')
        const settings = project.settings || {}
        // 没保存过扩展能力 = 一个都不勾：新会话照此继承，与无项目的聊天会话一致
        setEnabledTools(Array.isArray(settings.enabledTools) ? settings.enabledTools : [])
        setKnowledgeBases(Array.isArray(settings.knowledgeBases) ? settings.knowledgeBases : [])
        if (Array.isArray(settings.tool?.envVars)) {
          setEnvVars(settings.tool.envVars)
        }
      }
      setLoading(false)
    })
  }, [projectId])

  // MCP / Skills 工具
  const mcpTools = allTools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)

  const handleSelectFolder = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) setPath(result)
  }

  const toggleExtTool = (toolName: string): void => {
    setEnabledTools((prev) =>
      prev.includes(toolName) ? prev.filter((n) => n !== toolName) : [...prev, toolName]
    )
  }

  const toggleKnowledgeBase = (name: string): void => {
    setKbTouched(true)
    setKnowledgeBases((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
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
        // 没动过就不写：让这个项目继续跟着缺省走
        ...(kbTouched ? { knowledgeBases } : {}),
        tool: {
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
      key: 'config',
      label: t('projectForm.configTab'),
      content: (
        <ProjectInfoForm
          name={name}
          onNameChange={setName}
          path={path}
          onSelectFolder={handleSelectFolder}
          systemPrompt={systemPrompt}
          onSystemPromptChange={setSystemPrompt}
        >
          <ExtensionsSection
            title={t('projectForm.wizardStepExtensions')}
            footer={t('projectForm.extensionsDesc')}
            mcpTools={mcpTools}
            skillTools={skillTools}
            enabledTools={enabledTools}
            onToggle={toggleExtTool}
          />
          <KnowledgeBasesSection
            title={t('projectForm.knowledgeBases')}
            footer={t('projectForm.knowledgeBasesDesc')}
            options={kbOptions}
            selected={knowledgeBases}
            onToggle={toggleKnowledgeBase}
          />
          <ProjectEnvVarsSection envVars={envVars} onChange={setEnvVars} />
        </ProjectInfoForm>
      )
    }
  ]

  return (
    <ProjectConfigDialog
      title={t('projectForm.editTitle')}
      tabs={tabs}
      activeTab="config"
      onTabChange={() => {}}
      onClose={onClose}
      onSave={handleSave}
      onArchive={handleArchive}
      saving={saving}
    />
  )
}
