import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, FolderOpen, Container, ShieldCheck, Wrench } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'

interface ProjectEditDialogProps {
  projectId: string
  onClose: () => void
}

/**
 * 项目编辑弹窗 — 编辑项目名称、路径、system prompt、Docker 配置
 */
export function ProjectEditDialog({ projectId, onClose }: ProjectEditDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [dockerEnabled, setDockerEnabled] = useState(false)
  const [dockerImage, setDockerImage] = useState('ubuntu:latest')
  const [sandboxEnabled, setSandboxEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null)
  const [dockerError, setDockerError] = useState<string | null>(null)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])

  // 加载项目数据 + 工具列表 + Docker 可用性
  useEffect(() => {
    Promise.all([
      window.api.project.getById(projectId),
      window.api.docker.validate(),
      window.api.tools.list()
    ]).then(([project, dockerResult, tools]) => {
      setAllTools(tools)
      if (project) {
        setName(project.name)
        setPath(project.path)
        setSystemPrompt(project.systemPrompt)
        setDockerEnabled(project.dockerEnabled === 1)
        setDockerImage(project.dockerImage)
        setSandboxEnabled(project.sandboxEnabled === 1)
        // 从 settings JSON 恢复 enabledTools
        try {
          const settings = JSON.parse(project.settings || '{}')
          if (Array.isArray(settings.enabledTools)) {
            setEnabledTools(settings.enabledTools)
          } else {
            setEnabledTools(tools.map((t) => t.name))
          }
        } catch {
          setEnabledTools(tools.map((t) => t.name))
        }
      } else {
        setEnabledTools(tools.map((t) => t.name))
      }
      setDockerAvailable(dockerResult.ok)
      setLoading(false)
    })
  }, [projectId])

  // 按 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  /** 选择文件夹 */
  const handleSelectFolder = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) {
      setPath(result)
    }
  }

  /** 保存所有变更 */
  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setDockerError(null)
    try {
      // Docker 开启时先校验环境
      if (dockerEnabled) {
        const result = await window.api.docker.validate({ image: dockerImage })
        if (!result.ok) {
          setDockerError(t(`projectForm.${result.error}`))
          return
        }
      }
      await window.api.project.update({
        id: projectId,
        name: name.trim() || undefined,
        path: path || undefined,
        systemPrompt,
        dockerEnabled,
        dockerImage,
        sandboxEnabled,
        enabledTools
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay">
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[420px] max-w-[90vw] dialog-panel">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h2 className="text-sm font-semibold text-text-primary">{t('projectForm.editTitle')}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="px-5 py-4 space-y-4">
          {/* 项目名称 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('projectForm.name')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors"
              placeholder={t('projectForm.namePlaceholder')}
            />
          </div>

          {/* 项目路径 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              <FolderOpen size={12} className="inline mr-1 -mt-0.5" />
              {t('projectForm.path')}
            </label>
            <div className="flex gap-2">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="flex-1 bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
                placeholder={t('projectForm.pathPlaceholder')}
              />
              <button
                onClick={handleSelectFolder}
                className="px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors whitespace-nowrap"
              >
                {t('projectForm.selectFolder')}
              </button>
            </div>
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('projectForm.pathHint')}
            </p>
          </div>

          {/* 项目级 System Prompt */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('projectForm.prompt')}</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none"
              placeholder={t('projectForm.promptPlaceholder')}
            />
          </div>

          {/* 沙箱模式 */}
          <div className="border border-border-secondary rounded-lg p-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                <ShieldCheck size={12} />
                {t('projectForm.sandbox')}
              </label>
              <button
                onClick={() => setSandboxEnabled(!sandboxEnabled)}
                className={`relative w-8 h-[18px] rounded-full transition-colors ${
                  sandboxEnabled ? 'bg-accent' : 'bg-bg-hover'
                }`}
              >
                <span
                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                    sandboxEnabled ? 'left-[16px]' : 'left-[2px]'
                  }`}
                />
              </button>
            </div>
            <p className="text-[10px] text-text-tertiary mt-2">
              {t('projectForm.sandboxHint')}
            </p>
          </div>

          {/* 工具配置 */}
          <div className="border border-border-secondary rounded-lg p-3">
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
              <Wrench size={12} />
              {t('projectForm.tools')}
            </label>
            <ToolSelectList tools={allTools} enabledTools={enabledTools} onChange={setEnabledTools} />
            <p className="text-[10px] text-text-tertiary mt-2">
              {t('projectForm.toolsHint')}
            </p>
          </div>

          {/* Docker 隔离 */}
          <div className="border border-border-secondary rounded-lg p-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                <Container size={12} />
                {t('projectForm.docker')}
              </label>
              <button
                onClick={() => dockerAvailable && setDockerEnabled(!dockerEnabled)}
                disabled={!dockerAvailable}
                className={`relative w-8 h-[18px] rounded-full transition-colors ${
                  dockerEnabled && dockerAvailable ? 'bg-accent' : 'bg-bg-hover'
                } ${!dockerAvailable ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span
                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                    dockerEnabled ? 'left-[16px]' : 'left-[2px]'
                  }`}
                />
              </button>
            </div>
            {dockerEnabled && (
              <div className="mt-3">
                <label className="block text-[10px] text-text-tertiary mb-1">{t('projectForm.dockerImage')}</label>
                <input
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
                  placeholder="ubuntu:latest"
                />
              </div>
            )}
            <p className="text-[10px] text-text-tertiary mt-2">
              {dockerAvailable === false
                ? t('projectForm.dockerNotFound')
                : t('projectForm.dockerHint')}
            </p>
            {dockerError && (
              <p className="text-[10px] text-error mt-1.5">{dockerError}</p>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
