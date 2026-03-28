import { useTranslation } from 'react-i18next'
import { Type, FolderOpen, Plus, Trash2, Puzzle, BookOpen, Settings } from 'lucide-react'
import type { ReferenceDir } from '../../../../main/types/project'
import type { ToolItem } from '../common/ToolSelectList'

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
            <span
              className="text-[11px] font-mono text-text-primary truncate flex-1"
              title={dir.path}
            >
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

// ─── 扩展能力：MCP + Skills 选择面板 ────────────────────

interface ExtensionsPanelProps {
  mcpTools: ToolItem[]
  skillTools: ToolItem[]
  enabledTools: string[]
  onToggle: (toolName: string) => void
  onOpenSettings: () => void
}

export function ExtensionsPanel({
  mcpTools,
  skillTools,
  enabledTools,
  onToggle,
  onOpenSettings
}: ExtensionsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const hasMcpOrSkills = mcpTools.length > 0 || skillTools.length > 0

  if (!hasMcpOrSkills) {
    return (
      <div className="space-y-3">
        <p className="text-[11px] text-text-tertiary leading-relaxed">
          {t('projectForm.extEmptyDesc')}
        </p>
        <div className="zen-card">
          <div className="zen-card-header">
            <Puzzle size={12} className="text-purple-400" />
            MCP Server
          </div>
          <p className="text-[10px] text-text-tertiary leading-relaxed mb-3">
            {t('projectForm.extMcpDesc')}
          </p>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 text-[11px] text-accent hover:text-accent/80 transition-colors"
          >
            <Settings size={12} />
            {t('projectForm.extGoSettings')}
          </button>
        </div>
        <div className="zen-card">
          <div className="zen-card-header">
            <BookOpen size={12} className="text-emerald-400" />
            Skills
          </div>
          <p className="text-[10px] text-text-tertiary leading-relaxed mb-3">
            {t('projectForm.extSkillDesc')}
          </p>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 text-[11px] text-accent hover:text-accent/80 transition-colors"
          >
            <Settings size={12} />
            {t('projectForm.extGoSettings')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-tertiary leading-relaxed">
        {t('projectForm.extAvailableDesc')}
      </p>

      {mcpTools.length > 0 && (
        <div className="zen-card !p-0 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-secondary">
            <Puzzle size={11} className="text-purple-400" />
            <span className="text-[11px] font-medium text-purple-400">MCP</span>
          </div>
          <div className="divide-y divide-border-secondary">
            {mcpTools.map((tool) => {
              const isOnline = tool.serverStatus === 'connected'
              const serverName = tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name
              return (
                <label
                  key={tool.name}
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-bg-hover/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.name)}
                    onChange={() => onToggle(tool.name)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span
                    className={`text-[11px] font-mono ${isOnline ? 'text-text-secondary' : 'text-red-400'}`}
                  >
                    {serverName}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {skillTools.length > 0 && (
        <div className="zen-card !p-0 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-secondary">
            <BookOpen size={11} className="text-emerald-400" />
            <span className="text-[11px] font-medium text-emerald-400">Skills</span>
          </div>
          <div className="divide-y divide-border-secondary">
            {skillTools.map((tool) => {
              const shortName = tool.name.startsWith('skill:') ? tool.name.slice(6) : tool.name
              return (
                <label
                  key={tool.name}
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-bg-hover/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.name)}
                    onChange={() => onToggle(tool.name)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span className="text-[11px] font-mono text-text-secondary">{shortName}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      <button
        onClick={onOpenSettings}
        className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-accent transition-colors"
      >
        <Settings size={12} />
        {t('projectForm.extGoSettings')}
      </button>
    </div>
  )
}
