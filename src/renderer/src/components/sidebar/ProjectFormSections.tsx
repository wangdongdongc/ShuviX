import { useTranslation } from 'react-i18next'
import { Type, FolderOpen, Plus, Trash2 } from 'lucide-react'
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
    <div className="zen-card space-y-3">
      <div className="zen-card-header">
        <Type size={12} />
        {t('projectForm.basicInfoTitle')}
      </div>
      <div>
        <label className="block text-[10px] text-text-tertiary mb-1.5">
          {t('projectForm.name')}
        </label>
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="zen-input"
          placeholder={t('projectForm.namePlaceholder')}
        />
      </div>
      <div>
        <label className="block text-[10px] text-text-tertiary mb-1.5">
          {t('projectForm.prompt')}
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          rows={3}
          className="zen-textarea"
          placeholder={t('projectForm.promptPlaceholder')}
        />
      </div>
    </div>
  )
}

// ─── 文件系统：路径 + 参考目录 + 权限 ──────────────────

interface ProjectFileSystemProps {
  path: string
  onSelectFolder: () => void
  referenceDirs: ReferenceDir[]
  onReferenceDirsChange: (dirs: ReferenceDir[]) => void
}

export function ProjectFileSystem({
  path,
  onSelectFolder,
  referenceDirs,
  onReferenceDirsChange
}: ProjectFileSystemProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="zen-card">
      <div className="zen-card-header !mb-2">
        <FolderOpen size={12} />
        {t('projectForm.folders')}
      </div>
      <div className="space-y-1">
        {/* 项目文件夹（固定读写） */}
        {path ? (
          <div className="group/row flex items-center gap-1.5 rounded-md px-2 py-1.5 -mx-1 hover:bg-bg-hover/40 transition-colors">
            <span className="flex-shrink-0 w-7 text-center rounded text-[10px] font-medium border bg-amber-500/10 text-amber-500 border-amber-500/30">
              {t('projectForm.refDirAccessRW')}
            </span>
            <span className="text-[11px] font-mono text-text-primary truncate flex-1" title={path}>
              {path.split('/').pop() || path}
            </span>
            <button
              onClick={onSelectFolder}
              className="text-[10px] text-text-tertiary/0 group-hover/row:text-text-tertiary hover:!text-accent transition-colors flex-shrink-0"
            >
              {t('projectForm.changeFolder')}
            </button>
          </div>
        ) : (
          <button
            onClick={onSelectFolder}
            className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors px-2 py-1"
          >
            <Plus size={12} />
            {t('projectForm.selectFolder')}
          </button>
        )}

        {/* 引用文件夹 */}
        {referenceDirs.map((dir, idx) => (
          <div
            key={idx}
            className="group/row flex items-center gap-1.5 rounded-md px-2 py-1.5 -mx-1 hover:bg-bg-hover/40 transition-colors"
          >
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
              className={`flex-shrink-0 w-7 text-center rounded text-[10px] font-medium border transition-colors ${
                (dir.access ?? 'readonly') === 'readwrite'
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 hover:bg-amber-500/20'
                  : 'bg-bg-secondary text-text-tertiary border-border-primary hover:bg-bg-hover'
              }`}
              title={
                (dir.access ?? 'readonly') === 'readwrite'
                  ? t('projectForm.refDirAccessReadwrite')
                  : t('projectForm.refDirAccessReadonly')
              }
            >
              {(dir.access ?? 'readonly') === 'readwrite'
                ? t('projectForm.refDirAccessRW')
                : t('projectForm.refDirAccessRO')}
            </button>
            <span className="text-[11px] font-mono text-text-primary truncate flex-1" title={dir.path}>
              {dir.path.split('/').pop() || dir.path}
            </span>
            <button
              onClick={() => onReferenceDirsChange(referenceDirs.filter((_, i) => i !== idx))}
              className="p-0.5 rounded text-text-tertiary/0 group-hover/row:text-text-tertiary hover:!text-red-400 transition-colors flex-shrink-0"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={async () => {
          const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
          if (result && !referenceDirs.some((d) => d.path === result)) {
            onReferenceDirsChange([...referenceDirs, { path: result }])
          }
        }}
        className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors mt-2 px-2"
      >
        <Plus size={12} />
        {t('projectForm.addRefDir')}
      </button>
    </div>
  )
}
