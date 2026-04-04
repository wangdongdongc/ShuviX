import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogClose } from '../../hooks/useDialogClose'

interface SkillFormDialogProps {
  /** 编辑时传入已有 skill，新增时为 null */
  initial: { name: string; description: string; content: string } | null
  onSave: (data: { name: string; description: string; content: string }) => Promise<void>
  onClose: () => void
}

export function SkillFormDialog({
  initial,
  onSave,
  onClose
}: SkillFormDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)
  const isEdit = !!initial

  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [content, setContent] = useState(initial?.content || '')
  const [saving, setSaving] = useState(false)

  // 粘贴模式
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)

  const canSubmit = name.trim() && content.trim() && !saving && !pasteMode

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) handleClose()
  }

  const handleParse = async (): Promise<void> => {
    if (!pasteText.trim()) return
    setParseError(null)
    const result = await window.api.skill.parseMarkdown(pasteText)
    if (!result) {
      setParseError(t('settings.skillParseFailed'))
      return
    }
    setName(result.name)
    setDescription(result.description)
    setContent(result.content)
    setPasteMode(false)
  }

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setSaving(true)
    try {
      await onSave({ name: name.trim(), description: description.trim(), content })
      handleClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[480px] max-w-[90vw] max-h-[85vh] flex flex-col dialog-panel">
        {/* 标题 */}
        <div className="px-5 py-4 border-b border-border-secondary shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">{t('settings.skillEdit')}</h3>
        </div>

        {/* 表单 */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
          {/* 粘贴模式切换（仅新增） */}
          {!isEdit && (
            <div className="flex gap-2">
              <button
                onClick={() => setPasteMode(false)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  !pasteMode
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t('settings.skillManual')}
              </button>
              <button
                onClick={() => setPasteMode(true)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  pasteMode
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t('settings.skillPaste')}
              </button>
            </div>
          )}

          {pasteMode ? (
            <div className="space-y-2">
              <label className="block text-[11px] text-text-tertiary">
                {t('settings.skillPasteHint')}
              </label>
              <textarea
                autoFocus
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={12}
                className="zen-textarea font-mono text-[11px]"
                placeholder="---\nname: my-skill\ndescription: ...\n---\n# Instructions..."
              />
              {parseError && <p className="text-[10px] text-red-400">{parseError}</p>}
              <button
                onClick={handleParse}
                disabled={!pasteText.trim()}
                className="px-3 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {t('settings.skillParseBtn')}
              </button>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  {t('settings.skillName')}
                </label>
                <input
                  autoFocus={!isEdit}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isEdit}
                  className="zen-input font-mono"
                  placeholder="my-skill"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  {t('settings.skillDescription')}
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className="zen-textarea text-[11px]"
                  placeholder={t('settings.skillDescriptionPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  {t('settings.skillContent')}
                </label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={10}
                  className="zen-textarea font-mono text-[11px]"
                  placeholder="# My Skill&#10;Instructions for Claude..."
                />
              </div>
            </>
          )}
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
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
