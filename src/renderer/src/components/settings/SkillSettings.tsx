import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import {
  Trash2,
  Pencil,
  BookOpen,
  FolderOpen,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Lock,
  X
} from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SkillFormDialog } from './SkillFormDialog'

/** Skill 信息 */
interface SkillInfo {
  name: string
  description: string
  content: string
  basePath: string
  isEnabled: boolean
  source: 'default' | 'project' | 'external' | 'builtin'
  dirName?: string
}

/** 按目录分组的结构 */
interface SkillGroup {
  dirName: string
  dirPath: string
  isDefault: boolean
  skills: SkillInfo[]
}

/** Skill 设置页 — 管理已安装的 Skills（按目录分卡片） */
export function SkillSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<SkillGroup[]>([])
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  // 弹窗状态：null=关闭, { initial: null }=新增, { initial: SkillInfo }=编辑
  const [dialogState, setDialogState] = useState<{
    initial: { name: string; description: string; content: string } | null
  } | null>(null)

  // 添加目录流程
  const [addDirState, setAddDirState] = useState<{
    path: string
    name: string
    error: string | null
  } | null>(null)

  const loadGroups = useCallback(async () => {
    const list = await window.api.skill.listGrouped()
    setGroups(list)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    void loadGroups()
  }, [loadGroups])

  /** 打开目录 */
  const handleOpenDir = (dirPath: string): void => {
    window.api.app.openFolder(dirPath)
  }

  /** 启用/禁用切换 */
  const handleToggle = async (s: SkillInfo): Promise<void> => {
    await window.api.skill.update({ name: s.name, isEnabled: !s.isEnabled })
    await loadGroups()
  }

  /** 保存编辑 */
  const handleSave = async (data: {
    name: string
    description: string
    content: string
  }): Promise<void> => {
    if (!dialogState?.initial) return
    await window.api.skill.update({
      name: dialogState.initial.name,
      description: data.description,
      content: data.content
    })
    await loadGroups()
  }

  /** 待删除的 skill */
  const [deletingSkill, setDeletingSkill] = useState<SkillInfo | null>(null)

  const confirmDelete = async (): Promise<void> => {
    if (!deletingSkill) return
    await window.api.skill.deleteDefault(deletingSkill.name)
    setDeletingSkill(null)
    await loadGroups()
  }

  /** 待移除的目录 */
  const [removingDir, setRemovingDir] = useState<SkillGroup | null>(null)

  const confirmRemoveDir = async (): Promise<void> => {
    if (!removingDir) return
    await window.api.skill.removeExternalDir(removingDir.dirName)
    setRemovingDir(null)
    await loadGroups()
  }

  /** 添加外部目录 — 第1步：选择文件夹 */
  const handleAddDir = async (): Promise<void> => {
    const result = await window.api.skill.pickExternalDir()
    if (!result.success || !result.path) return
    setAddDirState({ path: result.path, name: '', error: null })
  }

  /** 添加外部目录 — 第2步：确认名称 */
  const confirmAddDir = async (): Promise<void> => {
    if (!addDirState || !addDirState.name.trim()) return
    const result = await window.api.skill.addExternalDir({
      name: addDirState.name.trim(),
      path: addDirState.path
    })
    if (result.success) {
      setAddDirState(null)
      await loadGroups()
    } else {
      setAddDirState({ ...addDirState, error: result.reason ?? 'Unknown error' })
    }
  }

  /** 渲染单个 skill 行 */
  const renderSkillItem = (s: SkillInfo): React.JSX.Element => {
    const isExpanded = expandedSkill === s.name
    const isDefault = s.source === 'default'
    // 外部 skill 显示时去掉 dirName: 前缀（卡片头部已有目录名）
    const displayName = s.dirName ? s.name.slice(s.dirName.length + 1) : s.name

    return (
      <motion.div
        key={s.name}
        layout="position"
        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
        className="border border-border-secondary rounded-lg overflow-hidden"
      >
        {/* Skill 头部 */}
        <div
          onClick={() => setExpandedSkill(isExpanded ? null : s.name)}
          className="flex items-center gap-3 px-3 py-2 bg-bg-primary/30 cursor-pointer hover:bg-bg-hover/50 transition-colors"
        >
          <span className="text-text-tertiary">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="flex-1 min-w-0 flex items-center gap-1.5">
            <BookOpen size={14} className="shrink-0 text-text-tertiary" />
            <span className="text-xs font-medium text-text-primary shrink-0">{displayName}</span>
            <span className="text-[10px] text-text-tertiary truncate">{s.description}</span>
          </span>
          {/* 编辑（仅默认目录） */}
          {isDefault && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setDialogState({ initial: s })
              }}
              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
              title={t('common.edit')}
            >
              <Pencil size={13} />
            </button>
          )}
          {/* 删除（仅默认目录） */}
          {isDefault && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setDeletingSkill(s)
              }}
              className="p-1 rounded text-text-tertiary hover:text-error hover:bg-error/10 transition-colors"
              title={t('common.delete')}
            >
              <Trash2 size={13} />
            </button>
          )}
          {/* 启用/禁用开关 */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleToggle(s)
            }}
            className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${
              s.isEnabled ? 'bg-accent' : 'bg-bg-tertiary'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                s.isEnabled ? 'left-[18px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>

        {/* 展开内容 */}
        {isExpanded && (
          <div className="px-4 py-3 border-t border-border-secondary">
            <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-words max-h-60 overflow-y-auto leading-relaxed">
              {s.content}
            </pre>
          </div>
        )}
      </motion.div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-5 py-5 space-y-4 overflow-y-auto">
        {/* 按目录分组卡片 */}
        {groups.map((group) => {
          const isCollapsed = collapsedDirs.has(group.dirName)
          const sortedSkills = [...group.skills].sort((a, b) =>
            a.isEnabled === b.isEnabled ? 0 : a.isEnabled ? -1 : 1
          )

          const toggleCollapse = (): void => {
            setCollapsedDirs((prev) => {
              const next = new Set(prev)
              if (next.has(group.dirName)) next.delete(group.dirName)
              else next.add(group.dirName)
              return next
            })
          }

          return (
            <div
              key={group.dirName}
              className="border border-border-secondary rounded-xl overflow-hidden"
            >
              {/* 卡片头部 */}
              <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-secondary/50 border-b border-border-secondary">
                <span
                  onClick={toggleCollapse}
                  className="cursor-pointer text-text-tertiary shrink-0"
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </span>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={toggleCollapse}>
                  <span className="text-xs font-medium text-text-primary inline-flex items-center gap-1">
                    {group.dirName === 'builtin' && (
                      <Lock size={10} className="text-text-tertiary" />
                    )}
                    {group.isDefault
                      ? t('settings.skillDirDefault')
                      : group.dirName === 'builtin'
                        ? t('settings.skillDirBuiltin')
                        : group.dirName}
                  </span>
                  <span className="text-[10px] text-text-tertiary ml-2 truncate">
                    {group.dirPath}
                  </span>
                </div>

                {/* 目录操作按钮 */}
                <button
                  onClick={() => handleOpenDir(group.dirPath)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary hover:text-text-primary bg-bg-tertiary hover:bg-bg-hover transition-colors"
                >
                  <FolderOpen size={11} />
                  {t('settings.skillOpenDir')}
                </button>
                {!group.isDefault && group.dirName !== 'builtin' && group.dirName !== 'project' && (
                  <button
                    onClick={() => setRemovingDir(group)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary hover:text-error bg-bg-tertiary hover:bg-error/10 transition-colors"
                  >
                    <X size={11} />
                    {t('settings.skillDirRemove')}
                  </button>
                )}
              </div>

              {!isCollapsed && (
                <>
                  {/* Skill 列表 */}
                  <div className="px-3 py-2 space-y-1.5">
                    {sortedSkills.length === 0 ? (
                      <div className="text-center py-4">
                        <p className="text-[11px] text-text-tertiary">{t('settings.skillEmpty')}</p>
                      </div>
                    ) : (
                      sortedSkills.map((s) => renderSkillItem(s))
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}

        {/* 添加目录按钮 */}
        <button
          onClick={handleAddDir}
          className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl border border-dashed border-border-secondary text-xs text-text-tertiary hover:text-text-primary hover:border-text-tertiary transition-colors"
        >
          <FolderPlus size={14} />
          {t('settings.skillDirAdd')}
        </button>
      </div>

      {/* 添加/编辑 Skill 弹窗 */}
      {dialogState && (
        <SkillFormDialog
          initial={dialogState.initial}
          onSave={handleSave}
          onClose={() => setDialogState(null)}
        />
      )}

      {/* 删除 Skill 确认弹窗 */}
      {deletingSkill && (
        <ConfirmDialog
          title={t('settings.skillDeleteConfirm', { name: deletingSkill.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingSkill(null)}
        />
      )}

      {/* 移除目录确认弹窗 */}
      {removingDir && (
        <ConfirmDialog
          title={t('settings.skillDirRemoveConfirm', { name: removingDir.dirName })}
          confirmText={t('settings.skillDirRemove')}
          cancelText={t('common.cancel')}
          onConfirm={confirmRemoveDir}
          onCancel={() => setRemovingDir(null)}
        />
      )}

      {/* 添加目录 — 输入名称弹窗 */}
      {addDirState && (
        <AddDirDialog
          path={addDirState.path}
          name={addDirState.name}
          error={addDirState.error}
          onNameChange={(name) => setAddDirState({ ...addDirState, name, error: null })}
          onConfirm={confirmAddDir}
          onCancel={() => setAddDirState(null)}
        />
      )}
    </div>
  )
}

/** 添加目录 — 名称输入弹窗 */
function AddDirDialog({
  path,
  name,
  error,
  onNameChange,
  onConfirm,
  onCancel
}: {
  path: string
  name: string
  error: string | null
  onNameChange: (name: string) => void
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[400px] max-w-[90vw] p-5 space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.skillDirAdd')}</h3>

        {/* 路径显示 */}
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            {t('settings.skillDirPath')}
          </label>
          <p className="text-xs text-text-secondary font-mono bg-bg-tertiary rounded-lg px-3 py-2 truncate">
            {path}
          </p>
        </div>

        {/* 名称输入 */}
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            {t('settings.skillDirName')}
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onConfirm()
              if (e.key === 'Escape') onCancel()
            }}
            className="zen-input font-mono"
            placeholder={t('settings.skillDirNamePlaceholder')}
          />
          {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={!name.trim()}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
