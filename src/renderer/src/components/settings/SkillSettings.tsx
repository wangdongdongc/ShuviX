import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, BookOpen, Power, PowerOff, FolderInput, FolderOpen } from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'

/** Skill 信息（基于文件系统，name 为唯一标识） */
interface SkillInfo {
  name: string
  description: string
  content: string
  basePath: string
  isEnabled: boolean
}

/** Skill 设置页 — 管理已安装的 Skills（~/.shuvix/skills/） */
export function SkillSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editName, setEditName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // 表单状态
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formContent, setFormContent] = useState('')
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    const list = await window.api.skill.list()
    setSkills(list)
  }, [])

  useEffect(() => { loadSkills() }, [loadSkills])

  /** 重置表单 */
  const resetForm = (): void => {
    setFormName('')
    setFormDescription('')
    setFormContent('')
    setPasteMode(false)
    setPasteText('')
    setParseError(null)
    setEditName(null)
    setShowForm(false)
    setImportError(null)
  }

  /** 打开编辑模式 */
  const startEdit = (s: SkillInfo): void => {
    setEditName(s.name)
    setFormName(s.name)
    setFormDescription(s.description)
    setFormContent(s.content)
    setPasteMode(false)
    setPasteText('')
    setParseError(null)
    setShowForm(true)
  }

  /** 解析粘贴的 SKILL.md */
  const handleParse = async (): Promise<void> => {
    if (!pasteText.trim()) return
    setParseError(null)
    const result = await window.api.skill.parseMarkdown(pasteText)
    if (!result) {
      setParseError(t('settings.skillParseFailed'))
      return
    }
    setFormName(result.name)
    setFormDescription(result.description)
    setFormContent(result.content)
    setPasteMode(false)
  }

  /** 保存 */
  const handleSave = async (): Promise<void> => {
    if (!formName.trim() || !formContent.trim()) return
    setSaving(true)
    try {
      if (editName) {
        await window.api.skill.update({
          name: editName,
          description: formDescription.trim(),
          content: formContent
        })
      } else {
        await window.api.skill.add({
          name: formName.trim(),
          description: formDescription.trim(),
          content: formContent
        })
      }
      resetForm()
      await loadSkills()
    } finally {
      setSaving(false)
    }
  }

  /** 从目录导入 */
  const handleImport = async (): Promise<void> => {
    setImportError(null)
    const result = await window.api.skill.importFromDir()
    if (result.success) {
      await loadSkills()
    } else if (result.reason && result.reason !== 'canceled') {
      setImportError(result.reason)
    }
  }

  /** 打开 skills 目录 */
  const handleOpenDir = async (): Promise<void> => {
    const dir = await window.api.skill.getDir()
    window.api.app.openFolder(dir)
  }

  /** 启用/禁用切换 */
  const handleToggle = async (s: SkillInfo): Promise<void> => {
    await window.api.skill.update({ name: s.name, isEnabled: !s.isEnabled })
    await loadSkills()
  }

  /** 待删除的 skill */
  const [deletingSkill, setDeletingSkill] = useState<SkillInfo | null>(null)

  const confirmDelete = async (): Promise<void> => {
    if (!deletingSkill) return
    await window.api.skill.delete(deletingSkill.name)
    setDeletingSkill(null)
    await loadSkills()
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-4">
      {/* 标题 + 描述 */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.skillTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.skillDesc')}</p>
      </div>

      {/* 操作按钮行 */}
      {!showForm && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            <Plus size={12} />
            {t('settings.skillAdd')}
          </button>
          <button
            onClick={handleImport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <FolderInput size={12} />
            {t('settings.skillImportDir')}
          </button>
          <button
            onClick={handleOpenDir}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <FolderOpen size={12} />
            {t('settings.skillOpenDir')}
          </button>
        </div>
      )}

      {/* 导入错误提示 */}
      {importError && (
        <p className="text-[11px] text-red-400 bg-red-500/5 px-3 py-1.5 rounded-lg">{importError}</p>
      )}

      {/* 添加/编辑表单 */}
      {showForm && (
        <div className="border border-border-secondary rounded-lg p-4 space-y-3 bg-bg-secondary">
          {/* 粘贴模式切换 */}
          {!editName && (
            <div className="flex gap-2">
              <button
                onClick={() => setPasteMode(false)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  !pasteMode ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t('settings.skillManual')}
              </button>
              <button
                onClick={() => setPasteMode(true)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  pasteMode ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t('settings.skillPaste')}
              </button>
            </div>
          )}

          {/* 粘贴 SKILL.md 模式 */}
          {pasteMode && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-text-secondary">{t('settings.skillPasteHint')}</label>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={10}
                className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none font-mono"
                placeholder="---\nname: my-skill\ndescription: ...\n---\n# Instructions..."
              />
              {parseError && <p className="text-[10px] text-red-400">{parseError}</p>}
              <button
                onClick={handleParse}
                className="px-3 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                {t('settings.skillParseBtn')}
              </button>
            </div>
          )}

          {/* 手动填写模式 */}
          {!pasteMode && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t('settings.skillName')}</label>
                <input
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  disabled={!!editName}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono disabled:opacity-50"
                  placeholder="my-skill"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t('settings.skillDescription')}</label>
                <textarea
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  rows={2}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none"
                  placeholder={t('settings.skillDescriptionPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t('settings.skillContent')}</label>
                <textarea
                  value={formContent}
                  onChange={e => setFormContent(e.target.value)}
                  rows={8}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none font-mono"
                  placeholder="# My Skill&#10;Instructions for Claude..."
                />
              </div>
            </>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={resetForm}
              className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || pasteMode || !formName.trim() || !formContent.trim()}
              className="px-3 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {/* Skill 列表 */}
      {skills.length === 0 && !showForm ? (
        <div className="text-center py-8">
          <BookOpen size={32} className="mx-auto text-text-tertiary mb-3 opacity-40" />
          <p className="text-xs text-text-tertiary">{t('settings.skillEmpty')}</p>
          <p className="text-[10px] text-text-tertiary mt-1">{t('settings.skillEmptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map(s => (
            <div key={s.name} className="border border-border-secondary rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2.5 bg-bg-secondary">
                <BookOpen size={14} className={s.isEnabled ? 'text-emerald-400' : 'text-text-tertiary'} />
                <div className="flex-1 min-w-0">
                  <span className={`text-xs font-medium ${s.isEnabled ? 'text-text-primary' : 'text-text-tertiary'}`}>{s.name}</span>
                  <p className="text-[10px] text-text-tertiary truncate">{s.description}</p>
                </div>
                {/* basePath 提示 */}
                <span className="text-[9px] text-text-tertiary font-mono truncate max-w-[200px]" title={s.basePath}>{s.basePath}</span>

                {/* 操作按钮 */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleToggle(s)}
                    className={`p-1 transition-colors ${s.isEnabled ? 'text-emerald-400 hover:text-emerald-300' : 'text-text-tertiary hover:text-text-secondary'}`}
                    title={s.isEnabled ? t('settings.skillDisable') : t('settings.skillEnable')}
                  >
                    {s.isEnabled ? <Power size={12} /> : <PowerOff size={12} />}
                  </button>
                  <button
                    onClick={() => startEdit(s)}
                    className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
                    title={t('common.edit')}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => setDeletingSkill(s)}
                    className="p-1 text-text-tertiary hover:text-red-400 transition-colors"
                    title={t('common.delete')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deletingSkill && (
        <ConfirmDialog
          title={t('settings.skillDeleteConfirm', { name: deletingSkill.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingSkill(null)}
        />
      )}
    </div>
  )
}
