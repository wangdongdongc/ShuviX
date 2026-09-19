/**
 * 添加外部技能目录 —— 侧栏「技能」分组组头菜单的「添加目录」拉起。
 *
 * 目录由 OS 选择器选好之后才弹这个框：要填的只有**目录名**，而它不是装饰 —— 这个名字会成为
 * 组内技能标识的前缀（`<dirName>:<skillName>`），改不了、也不能与已有目录重名。缺省填目录
 * 自己的名字，多数情况下直接回车即可。
 *
 * 失败原因（目录不存在 / 与默认目录同路径 / 名字已被占用）由主进程给，原样显示在输入框下面。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'

export interface SkillDirDialogProps {
  /** 已选好的目录绝对路径 */
  path: string
  /** 提交：成功返回 null，失败返回人读原因（显示并停留） */
  onSubmit: (name: string) => Promise<string | null>
  onClose: () => void
}

export function SkillDirDialog({
  path,
  onSubmit,
  onClose
}: SkillDirDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [name, setName] = useState(() => path.split(/[\\/]/).filter(Boolean).pop() ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const reason = await onSubmit(trimmed)
      if (reason === null) onClose()
      else setError(reason)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className="w-[420px] max-w-[90vw] bg-bg-primary border border-border-secondary rounded-xl shadow-xl dialog-panel"
        onClick={(e) => e.stopPropagation()}
        data-skill-dir-dialog
      >
        <div className="flex items-start justify-between px-4 pt-3 pb-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">{t('settings.skillDirAdd')}</h3>
            <p className="font-mono text-[10px] text-text-tertiary mt-0.5 truncate" title={path}>
              {path}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 pb-3 border-t border-border-secondary/50 pt-3">
          <label className="block text-[11px] text-text-secondary mb-1">
            {t('settings.skillDirName')}
          </label>
          <input
            ref={inputRef}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder={t('settings.skillDirNamePlaceholder')}
            className="w-full px-2 py-1.5 rounded-lg bg-bg-secondary border border-border-secondary text-[13px] text-text-primary outline-none focus:border-accent/50"
          />
          {error && (
            <p className="mt-2 text-[11px] text-red-500 whitespace-pre-wrap break-words">{error}</p>
          )}
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={handleClose}
              className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void submit()}
              disabled={!name.trim() || busy}
              className="px-3 py-1.5 rounded-lg text-xs bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
            >
              {t('settings.skillDirAdd')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
