import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, FolderOpen, Container, ShieldCheck } from 'lucide-react'

interface ProjectCreateDialogProps {
  onClose: () => void
  /** 创建成功后回调，传入新项目 ID */
  onCreated?: (projectId: string) => void
}

/**
 * 新建项目弹窗 — 表单内容与编辑项目保持一致
 */
export function ProjectCreateDialog({ onClose, onCreated }: ProjectCreateDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [dockerEnabled, setDockerEnabled] = useState(false)
  const [dockerImage, setDockerImage] = useState('ubuntu:latest')
  const [sandboxEnabled, setSandboxEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null)

  // 检查 Docker 可用性
  useEffect(() => {
    window.api.docker.check().then((result) => {
      setDockerAvailable(result.available)
    })
  }, [])

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
      // 自动用文件夹名作为项目名
      if (!name) {
        const folderName = result.split('/').pop() || result.split('\\').pop() || ''
        setName(folderName)
      }
    }
  }

  /** 创建项目 */
  const handleCreate = async (): Promise<void> => {
    if (!path.trim()) return
    setSaving(true)
    try {
      const project = await window.api.project.create({
        name: name.trim() || undefined,
        path: path.trim(),
        systemPrompt,
        dockerEnabled,
        dockerImage,
        sandboxEnabled
      })
      onCreated?.(project.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[420px] max-w-[90vw]">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h2 className="text-sm font-semibold text-text-primary">{t('projectForm.createTitle')}</h2>
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
            onClick={handleCreate}
            disabled={saving || !path.trim()}
            className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.creating') : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
