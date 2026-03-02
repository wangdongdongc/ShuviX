import { useTranslation } from 'react-i18next'
import { FolderOpen, ShieldCheck, FolderSearch, Plus, Trash2 } from 'lucide-react'
import type { ReferenceDir } from '../../../../main/types/project'

// ─── 基本信息：名称 + 提示词 ────────────────────────────

interface ProjectBasicInfoProps {
  name: string
  onNameChange: (name: string) => void
  systemPrompt: string
  onSystemPromptChange: (prompt: string) => void
}

export function ProjectBasicInfo({
  name,
  onNameChange,
  systemPrompt,
  onSystemPromptChange
}: ProjectBasicInfoProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          {t('projectForm.name')}
        </label>
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors"
          placeholder={t('projectForm.namePlaceholder')}
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          {t('projectForm.prompt')}
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          rows={3}
          className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none"
          placeholder={t('projectForm.promptPlaceholder')}
        />
      </div>
    </div>
  )
}

// ─── 文件系统：路径 + 参考目录 + 沙箱 ──────────────────

interface ProjectFileSystemProps {
  path: string
  onSelectFolder: () => void
  referenceDirs: ReferenceDir[]
  onReferenceDirsChange: (dirs: ReferenceDir[]) => void
  sandboxEnabled: boolean
  onSandboxEnabledChange: (enabled: boolean) => void
}

export function ProjectFileSystem({
  path,
  onSelectFolder,
  referenceDirs,
  onReferenceDirsChange,
  sandboxEnabled,
  onSandboxEnabledChange
}: ProjectFileSystemProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="border border-border-secondary rounded-lg p-3 space-y-3">
      {/* 项目路径 */}
      <div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
          <FolderOpen size={12} />
          {t('projectForm.path')}
        </label>
        {path && (
          <div className="text-[11px] font-mono text-text-primary truncate mb-2" title={path}>
            {path}
          </div>
        )}
        <button
          onClick={onSelectFolder}
          className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          <Plus size={12} />
          {t('projectForm.selectFolder')}
        </button>
        <p className="text-[10px] text-text-tertiary mt-2">{t('projectForm.pathHint')}</p>
      </div>

      <div className="border-t border-border-secondary" />

      {/* 参考目录 */}
      <div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
          <FolderSearch size={12} />
          {t('projectForm.referenceDirs')}
        </label>
        {referenceDirs.map((dir, idx) => (
          <div key={idx} className="flex items-start gap-1.5 mb-2">
            <div className="flex-1 min-w-0">
              <div
                className="text-[11px] font-mono text-text-primary truncate"
                title={dir.path}
              >
                {dir.path}
              </div>
              <input
                value={dir.note || ''}
                onChange={(e) => {
                  const next = [...referenceDirs]
                  next[idx] = { ...dir, note: e.target.value }
                  onReferenceDirsChange(next)
                }}
                className="w-full bg-bg-secondary border border-border-primary rounded px-2 py-1 text-[10px] text-text-secondary outline-none focus:border-accent transition-colors mt-1"
                placeholder={t('projectForm.refDirNotePlaceholder')}
              />
            </div>
            <button
              onClick={() => onReferenceDirsChange(referenceDirs.filter((_, i) => i !== idx))}
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-red-400 transition-colors flex-shrink-0 mt-0.5"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button
          onClick={async () => {
            const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
            if (result && !referenceDirs.some((d) => d.path === result)) {
              onReferenceDirsChange([...referenceDirs, { path: result }])
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

      <div className="border-t border-border-secondary" />

      {/* 沙箱模式 */}
      <div>
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <ShieldCheck size={12} />
            {t('projectForm.sandbox')}
          </label>
          <button
            onClick={() => onSandboxEnabledChange(!sandboxEnabled)}
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
        <p className="text-[10px] text-text-tertiary mt-2">{t('projectForm.sandboxHint')}</p>
        {sandboxEnabled && (path || referenceDirs.length > 0) && (
          <div className="mt-3 pt-3 border-t border-border-secondary space-y-1.5">
            <div className="text-[10px] text-text-tertiary mb-1">
              {t('projectForm.refDirAccessLabel')}
            </div>
            {/* 项目文件夹：固定读写 */}
            {path && (
              <div className="flex items-center gap-1.5">
                <div
                  className="text-[11px] font-mono text-text-secondary truncate flex-1"
                  title={path}
                >
                  {path.split('/').pop() || path}
                </div>
                <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-amber-500/10 text-amber-500 border-amber-500/30">
                  {t('projectForm.refDirAccessReadwrite')}
                </span>
              </div>
            )}
            {/* 引用文件夹：可切换读写权限 */}
            {referenceDirs.map((dir, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <div
                  className="text-[11px] font-mono text-text-secondary truncate flex-1"
                  title={dir.path}
                >
                  {dir.path.split('/').pop() || dir.path}
                </div>
                <button
                  onClick={() => {
                    const next = [...referenceDirs]
                    const current = dir.access ?? 'readonly'
                    next[idx] = {
                      ...dir,
                      access: current === 'readonly' ? 'readwrite' : 'readonly'
                    }
                    onReferenceDirsChange(next)
                  }}
                  className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                    (dir.access ?? 'readonly') === 'readwrite'
                      ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 hover:bg-amber-500/20'
                      : 'bg-bg-secondary text-text-tertiary border-border-primary hover:bg-bg-hover'
                  }`}
                  title={dir.path}
                >
                  {(dir.access ?? 'readonly') === 'readwrite'
                    ? t('projectForm.refDirAccessReadwrite')
                    : t('projectForm.refDirAccessReadonly')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
