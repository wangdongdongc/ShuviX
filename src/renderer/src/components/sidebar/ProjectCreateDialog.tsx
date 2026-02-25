import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, FolderOpen, ShieldCheck, Wrench, FolderSearch, Plus, Trash2 } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'

import type { ReferenceDir } from '../../../../main/types/project'

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
  const { closing, handleClose } = useDialogClose(onClose)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [sandboxEnabled, setSandboxEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [referenceDirs, setReferenceDirs] = useState<ReferenceDir[]>([])

  // 加载工具列表
  useEffect(() => {
    window.api.tools.list().then(tools => {
      setAllTools(tools)
      // 默认使用“通用”模板（bash, read, write, ask）
      setEnabledTools(['bash', 'read', 'write', 'ask'])
    })
  }, [])

  // 按 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

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
        sandboxEnabled,
        enabledTools,
        referenceDirs: referenceDirs.length > 0 ? referenceDirs : undefined
      })
      onCreated?.(project.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}>
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[520px] max-w-[90vw] max-h-[85vh] flex flex-col dialog-panel">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h2 className="text-sm font-semibold text-text-primary">{t('projectForm.createTitle')}</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
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
          <div className="border border-border-secondary rounded-lg p-3">
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
              <FolderOpen size={12} />
              {t('projectForm.path')}
            </label>
            {path && (
              <div className="text-[11px] font-mono text-text-primary truncate mb-2" title={path}>{path}</div>
            )}
            <button
              onClick={handleSelectFolder}
              className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
            >
              <Plus size={12} />
              {t('projectForm.selectFolder')}
            </button>
            <p className="text-[10px] text-text-tertiary mt-2">
              {t('projectForm.pathHint')}
            </p>
          </div>

          {/* 参考目录 */}
          <div className="border border-border-secondary rounded-lg p-3">
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
              <FolderSearch size={12} />
              {t('projectForm.referenceDirs')}
            </label>
            {referenceDirs.map((dir, idx) => (
              <div key={idx} className="flex items-start gap-1.5 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-mono text-text-primary truncate" title={dir.path}>{dir.path}</div>
                  <input
                    value={dir.note || ''}
                    onChange={(e) => {
                      const next = [...referenceDirs]
                      next[idx] = { ...dir, note: e.target.value }
                      setReferenceDirs(next)
                    }}
                    className="w-full bg-bg-secondary border border-border-primary rounded px-2 py-1 text-[10px] text-text-secondary outline-none focus:border-accent transition-colors mt-1"
                    placeholder={t('projectForm.refDirNotePlaceholder')}
                  />
                </div>
                <button
                  onClick={() => setReferenceDirs(referenceDirs.filter((_, i) => i !== idx))}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-red-400 transition-colors flex-shrink-0 mt-0.5"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              onClick={async () => {
                const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
                if (result && !referenceDirs.some(d => d.path === result)) {
                  setReferenceDirs([...referenceDirs, { path: result }])
                }
              }}
              className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
            >
              <Plus size={12} />
              {t('projectForm.addRefDir')}
            </button>
            <p className="text-[10px] text-text-tertiary mt-2">
              {t('projectForm.referenceDirsHint')}
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

        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
          <button
            onClick={handleClose}
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
