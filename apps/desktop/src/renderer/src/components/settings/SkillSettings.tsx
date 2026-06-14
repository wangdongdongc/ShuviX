import { useState, useEffect, useCallback, useMemo } from 'react'
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
  X,
  AlertCircle
} from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SkillFormDialog } from './SkillFormDialog'
import { useDialogClose } from '@shuvix/chat-ui'
import { Toggle, InlineInput } from './SettingsPrimitives'

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
  isEnabled: boolean
  skills: SkillInfo[]
}

/** Skill 设置页 — 双层结构：左侧分组列表 + 右侧详情 */
export function SkillSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<SkillGroup[]>([])
  const [selectedDirName, setSelectedDirName] = useState<string | null>(null)
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)

  const [dialogState, setDialogState] = useState<{
    initial: { name: string; description: string; content: string } | null
  } | null>(null)

  const [addDirState, setAddDirState] = useState<{
    path: string
    name: string
    error: string | null
  } | null>(null)

  const [deletingSkill, setDeletingSkill] = useState<SkillInfo | null>(null)
  const [removingDir, setRemovingDir] = useState<SkillGroup | null>(null)

  const loadGroups = useCallback(async () => {
    const list = await window.api.skill.listGrouped()
    setGroups(list)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    void loadGroups()
  }, [loadGroups])

  /** 默认选中第一个分组 */
  useEffect(() => {
    if (selectedDirName) {
      const exists = groups.some((g) => g.dirName === selectedDirName)
      if (exists) return
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync selection with newly loaded groups
    setSelectedDirName(groups.length > 0 ? groups[0].dirName : null)
  }, [groups, selectedDirName])

  const selectedGroup = useMemo(
    () => groups.find((g) => g.dirName === selectedDirName) ?? null,
    [groups, selectedDirName]
  )

  const handleOpenDir = (dirPath: string): void => {
    window.api.app.openFolder(dirPath)
  }

  const handleToggleSkill = async (s: SkillInfo): Promise<void> => {
    await window.api.skill.update({ name: s.name, isEnabled: !s.isEnabled })
    await loadGroups()
  }

  const handleToggleGroup = async (group: SkillGroup): Promise<void> => {
    await window.api.skill.setGroupEnabled({
      dirName: group.dirName,
      isEnabled: !group.isEnabled
    })
    await loadGroups()
  }

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

  const confirmDelete = async (): Promise<void> => {
    if (!deletingSkill) return
    await window.api.skill.deleteDefault(deletingSkill.name)
    setDeletingSkill(null)
    await loadGroups()
  }

  const confirmRemoveDir = async (): Promise<void> => {
    if (!removingDir) return
    await window.api.skill.removeExternalDir(removingDir.dirName)
    setRemovingDir(null)
    await loadGroups()
  }

  const handleAddDir = async (): Promise<void> => {
    const result = await window.api.skill.pickExternalDir()
    if (!result.success || !result.path) return
    setAddDirState({ path: result.path, name: '', error: null })
  }

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

  /** 分组标题（用于左侧列表与右侧头部） */
  const groupTitle = useCallback(
    (group: SkillGroup): string => {
      if (group.isDefault) return t('settings.skillDirDefault')
      if (group.dirName === 'builtin') return t('settings.skillDirBuiltin')
      if (group.dirName === 'project') return t('settings.skillGroupProject')
      return group.dirName
    },
    [t]
  )

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：分组列表 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {groups.map((group) => {
            const isSelected = selectedDirName === group.dirName
            const isBuiltin = group.dirName === 'builtin'
            return (
              <button
                key={group.dirName}
                onClick={() => setSelectedDirName(group.dirName)}
                className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                  isSelected
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                } ${!group.isEnabled ? 'opacity-60' : ''}`}
              >
                {isBuiltin ? (
                  <Lock size={12} className="shrink-0 text-text-tertiary" />
                ) : (
                  <BookOpen size={12} className="shrink-0 text-text-tertiary" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{groupTitle(group)}</div>
                </div>
                <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <Toggle on={group.isEnabled} onClick={() => void handleToggleGroup(group)} />
                </span>
              </button>
            )
          })}
        </div>
        {/* 添加外部目录 */}
        <div className="border-t border-border-secondary p-2">
          <button
            onClick={handleAddDir}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <FolderPlus size={12} />
            {t('settings.skillDirAdd')}
          </button>
        </div>
      </div>

      {/* 右侧：详情面板 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedGroup ? (
          <SkillGroupDetail
            group={selectedGroup}
            title={groupTitle(selectedGroup)}
            expandedSkill={expandedSkill}
            onExpand={setExpandedSkill}
            onOpenDir={() => handleOpenDir(selectedGroup.dirPath)}
            onRemoveDir={() => setRemovingDir(selectedGroup)}
            onToggleSkill={(s) => void handleToggleSkill(s)}
            onEditSkill={(s) => setDialogState({ initial: s })}
            onDeleteSkill={(s) => setDeletingSkill(s)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-text-tertiary text-[11px]">
            {t('settings.skillGroupSelect')}
          </div>
        )}
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

// ────────────────────────────────────────────────────────────────
// 右侧详情面板
// ────────────────────────────────────────────────────────────────

interface SkillGroupDetailProps {
  group: SkillGroup
  title: string
  expandedSkill: string | null
  onExpand: (name: string | null) => void
  onOpenDir: () => void
  onRemoveDir: () => void
  onToggleSkill: (s: SkillInfo) => void
  onEditSkill: (s: SkillInfo) => void
  onDeleteSkill: (s: SkillInfo) => void
}

function SkillGroupDetail({
  group,
  title,
  expandedSkill,
  onExpand,
  onOpenDir,
  onRemoveDir,
  onToggleSkill,
  onEditSkill,
  onDeleteSkill
}: SkillGroupDetailProps): React.JSX.Element {
  const { t } = useTranslation()

  const sortedSkills = useMemo(
    () =>
      [...group.skills].sort((a, b) => (a.isEnabled === b.isEnabled ? 0 : a.isEnabled ? -1 : 1)),
    [group.skills]
  )

  const isBuiltin = group.dirName === 'builtin'
  const canRemove = !group.isDefault && !isBuiltin && group.dirName !== 'project'

  return (
    <div className="flex flex-col">
      {/* 头部：分组名称 + 操作 */}
      <div className="px-5 py-3 border-b border-border-secondary flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            {isBuiltin && <Lock size={13} className="text-text-tertiary shrink-0" />}
            <h3 className="text-sm font-semibold text-text-primary truncate">{title}</h3>
          </div>
          {!isBuiltin && (
            <div className="mt-1 text-[11px] font-mono text-text-tertiary break-all">
              {group.dirPath}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!isBuiltin && (
            <button
              onClick={onOpenDir}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <FolderOpen size={11} />
              {t('settings.skillOpenDir')}
            </button>
          )}
          {canRemove && (
            <button
              onClick={onRemoveDir}
              className="p-1.5 rounded-md text-error hover:bg-error/10 transition-colors shrink-0"
              title={t('settings.skillDirRemove')}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 px-5 py-5 space-y-3">
        {/* 总开关关闭提示 */}
        {!group.isEnabled && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <AlertCircle size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-500 leading-relaxed">
              {t('settings.skillGroupDisabledHint')}
            </p>
          </div>
        )}

        {/* skill 列表 */}
        <div className="rounded-xl border border-border-secondary overflow-hidden">
          {sortedSkills.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-[11px] text-text-tertiary">{t('settings.skillEmpty')}</p>
            </div>
          ) : (
            sortedSkills.map((s) => (
              <SkillItem
                key={s.name}
                skill={s}
                groupEnabled={group.isEnabled}
                isExpanded={expandedSkill === s.name}
                onToggleExpand={() => onExpand(expandedSkill === s.name ? null : s.name)}
                onToggle={() => onToggleSkill(s)}
                onEdit={() => onEditSkill(s)}
                onDelete={() => onDeleteSkill(s)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// 单个 skill 行
// ────────────────────────────────────────────────────────────────

interface SkillItemProps {
  skill: SkillInfo
  groupEnabled: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}

function SkillItem({
  skill: s,
  groupEnabled,
  isExpanded,
  onToggleExpand,
  onToggle,
  onEdit,
  onDelete
}: SkillItemProps): React.JSX.Element {
  const { t } = useTranslation()
  const isDefault = s.source === 'default'
  // 外部 skill 显示时去掉 dirName: 前缀
  const displayName = s.dirName ? s.name.slice(s.dirName.length + 1) : s.name

  return (
    <motion.div
      layout="position"
      transition={{ type: 'spring', stiffness: 500, damping: 35 }}
      className="flex flex-col border-b border-border-secondary/60 last:border-b-0"
    >
      <div
        onClick={onToggleExpand}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg-hover/40 transition-colors"
      >
        <span className="text-text-tertiary shrink-0">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <BookOpen size={13} className="shrink-0 text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] text-text-primary truncate">{displayName}</span>
          </div>
          {s.description && (
            <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed truncate">
              {s.description}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {isDefault && (
            <button
              onClick={onEdit}
              className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
              title={t('common.edit')}
            >
              <Pencil size={12} />
            </button>
          )}
          {isDefault && (
            <button
              onClick={onDelete}
              className="p-1 text-text-tertiary hover:text-danger transition-colors"
              title={t('common.delete')}
            >
              <Trash2 size={12} />
            </button>
          )}
          <Toggle on={s.isEnabled} onClick={onToggle} disabled={!groupEnabled} />
        </div>
      </div>

      {isExpanded && (
        <div className="px-4 py-3 bg-bg-tertiary/15">
          <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-words max-h-60 overflow-y-auto leading-relaxed">
            {s.content}
          </pre>
        </div>
      )}
    </motion.div>
  )
}

// ────────────────────────────────────────────────────────────────
// 添加目录弹窗
// ────────────────────────────────────────────────────────────────

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
  const { closing, handleClose } = useDialogClose(onCancel)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[440px] max-w-[92vw] flex flex-col dialog-panel"
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">{t('settings.skillDirAdd')}</h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-5 space-y-4">
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1.5">
              {t('settings.skillDirPath')}
            </label>
            <p className="text-[11px] text-text-secondary font-mono bg-bg-primary border border-border-secondary/50 rounded-md px-2.5 py-1.5 truncate">
              {path}
            </p>
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1.5">
              {t('settings.skillDirName')}
            </label>
            <InlineInput
              value={name}
              onChange={onNameChange}
              placeholder={t('settings.skillDirNamePlaceholder')}
              autoFocus
              monospace
              width={300}
            />
            {error && <p className="text-[11px] text-danger mt-1.5">{error}</p>}
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <button
            onClick={handleClose}
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
