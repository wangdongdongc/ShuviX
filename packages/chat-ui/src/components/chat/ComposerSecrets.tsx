/**
 * 输入框里「对模型藏起来」的三件东西（docs/auto-redaction-design.md §14）：
 *  - ComposerPlusMenu：「+」—— 添加图片（模型能看图时）、添加敏感信息；桌面是弹出菜单，手机是底部面板；
 *  - AddSecretForm：添加敏感信息的表单（类别 + 不回显的输入框）；
 *  - RedactionHintBar：提示行 —— 认出来的可能是敏感信息，点了才藏；不理会的照原样发。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, ImageIcon, KeyRound, Lock, Plus, X } from 'lucide-react'
import { USER_SECRET_CATEGORIES } from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { TouchSheet } from '../common/TouchSheet'
import { useClickOutside } from '../../hooks/useClickOutside'
import type { RedactionHintItem } from '../../hooks/useRedactionHints'

/** 提示行里露出的开头几个字符（其余打点）：认得出是哪一处，又不把整个值摆在屏幕上 */
export function previewOf(value: string): string {
  const head = value.slice(0, Math.min(3, Math.max(1, value.length - 2)))
  return `${head}…`
}

/** 添加敏感信息：类别 + 不回显的输入框。initialValue = 打开时输入框里选中的那段 */
export function AddSecretForm({
  initialValue = '',
  touch,
  onAdd,
  onCancel
}: {
  initialValue?: string
  touch: boolean
  onAdd: (value: string, category: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const [category, setCategory] = useState<string>('PASSWORD')
  const [shown, setShown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const submit = (): void => {
    if (value.length > 0) onAdd(value, category)
  }
  const rowH = touch ? 'h-11' : 'h-8'
  return (
    <div data-secret-form="" className={touch ? 'px-4 pb-4 pt-1' : 'p-3 w-[300px]'}>
      {!touch && (
        <div className="mb-2 text-[13px] font-medium text-text-primary">
          {t('input.secretTitle')}
        </div>
      )}
      <div className="mb-2 flex gap-1" role="radiogroup" aria-label={t('input.secretKind')}>
        {USER_SECRET_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={category === c}
            data-secret-category={c}
            onClick={() => setCategory(c)}
            className={`flex-1 rounded-md border ${touch ? 'h-9 text-[14px]' : 'h-7 text-[12px]'} transition-colors ${
              category === c
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border-secondary text-text-secondary hover:bg-bg-hover'
            }`}
          >
            {t(`redaction.category.${c}`, { defaultValue: c })}
          </button>
        ))}
      </div>
      <div
        className={`flex items-center rounded-md border border-border-secondary bg-bg-primary ${rowH}`}
      >
        <input
          ref={inputRef}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
          autoComplete="off"
          spellCheck={false}
          data-secret-input=""
          aria-label={t('input.secretValue')}
          placeholder={t('input.secretValue')}
          // 16px：手机上不触发浏览器的自动放大
          className={`min-w-0 flex-1 bg-transparent px-2 text-text-primary outline-none ${touch ? 'text-[16px]' : 'text-[13px]'}`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? t('input.secretHide') : t('input.secretShow')}
          title={shown ? t('input.secretHide') : t('input.secretShow')}
          className={`flex-shrink-0 ${touch ? 'h-11 w-11' : 'h-8 w-8'} flex items-center justify-center text-text-tertiary hover:text-text-secondary`}
        >
          {shown ? <EyeOff size={touch ? 18 : 14} /> : <Eye size={touch ? 18 : 14} />}
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-text-tertiary">{t('input.secretNote')}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={`rounded-md px-3 ${touch ? 'h-10 text-[15px]' : 'h-7 text-[12px]'} text-text-secondary hover:bg-bg-hover`}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={value.length === 0}
          data-secret-add=""
          className={`rounded-md px-3 ${touch ? 'h-10 text-[15px]' : 'h-7 text-[12px]'} bg-accent text-white disabled:opacity-40`}
        >
          {t('input.secretAdd')}
        </button>
      </div>
    </div>
  )
}

/**
 * 「+」与它的菜单。桌面：按钮上方弹出（菜单 → 选「添加敏感信息」换成表单）；手机：底部面板。
 * 打开表单那一刻输入框里选中的文字（`selection()`）预填进表单，添加时替换掉那段。
 */
export function ComposerPlusMenu({
  touch,
  images,
  onImages,
  onSecret,
  selection
}: {
  touch: boolean
  /** 模型能看图：菜单里有「添加图片」 */
  images: boolean
  onImages: () => void
  onSecret: (value: string, category: string, range: { start: number; end: number } | null) => void
  /** 打开表单时输入框的选区与选中的文字 */
  selection: () => { start: number; end: number; text: string } | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<'closed' | 'menu' | 'form'>('closed')
  const [range, setRange] = useState<{ start: number; end: number; text: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = (): void => setView('closed')
  useClickOutside(ref, close, view !== 'closed' && !touch)

  const openForm = (): void => {
    setRange(selection())
    setView('form')
  }
  const menuRow = touch
    ? 'flex w-full items-center gap-3 px-4 h-12 text-[15px] text-text-primary active:bg-bg-hover'
    : 'flex w-full items-center gap-2 px-3 h-8 text-[13px] text-text-primary hover:bg-bg-hover'
  const menu = (
    <div className={touch ? 'pb-3' : 'py-1 w-[220px]'} role="menu">
      {images && (
        <button
          type="button"
          role="menuitem"
          data-plus-images=""
          className={menuRow}
          onClick={() => {
            close()
            onImages()
          }}
        >
          <ImageIcon size={touch ? 18 : 14} className="text-text-secondary" />
          {t('input.attach')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-plus-secret=""
        className={menuRow}
        onClick={openForm}
      >
        <KeyRound size={touch ? 18 : 14} className="text-text-secondary" />
        {t('input.secretTitle')}
      </button>
    </div>
  )
  const form = (
    <AddSecretForm
      initialValue={range?.text ?? ''}
      touch={touch}
      onCancel={close}
      onAdd={(value, category) => {
        close()
        onSecret(value, category, range && range.text === value ? range : null)
      }}
    />
  )

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        data-attach-button=""
        onClick={() => setView((v) => (v === 'closed' ? 'menu' : 'closed'))}
        title={t('input.plus')}
        aria-label={t('input.plus')}
        aria-expanded={view !== 'closed'}
        className={
          touch
            ? 'h-9 w-9 rounded-full border border-border-secondary/60 flex items-center justify-center text-text-secondary active:bg-bg-hover transition-colors'
            : 'h-6 w-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors'
        }
      >
        <Plus size={touch ? 18 : 15} />
      </button>
      {view !== 'closed' && touch && (
        <TouchSheet
          name={view === 'form' ? 'secret' : 'plus'}
          onClose={close}
          title={view === 'form' ? t('input.secretTitle') : undefined}
        >
          {view === 'form' ? form : menu}
        </TouchSheet>
      )}
      {/* 工具行是 whitespace-nowrap：弹层里的说明要换回能换行 */}
      {view !== 'closed' && !touch && (
        <div
          data-plus-panel=""
          className="picker-panel absolute left-0 bottom-8 z-30 whitespace-normal rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden"
        >
          {view === 'form' ? form : menu}
        </div>
      )}
    </div>
  )
}

/** 提示行：认出来的可能是敏感信息。点一项（或「全部隐藏」）才藏；× = 不用提示了，照原样发 */
export function RedactionHintBar({
  items,
  touch,
  onHide,
  onDismiss
}: {
  items: RedactionHintItem[]
  touch: boolean
  onHide: (items: RedactionHintItem[]) => void
  onDismiss: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (items.length === 0) return null
  const label = (item: RedactionHintItem): string =>
    t(`redaction.category.${item.category}`, { defaultValue: item.category })
  return (
    <div
      data-redaction-hints=""
      className={`flex flex-wrap items-center gap-1.5 border-b border-border-secondary/60 ${
        touch ? 'px-3 py-2 text-[14px]' : 'px-3 py-1.5 text-[12px]'
      } text-text-secondary`}
    >
      <Lock size={touch ? 14 : 12} className="flex-shrink-0 text-warning" />
      <span>
        {items.length === 1
          ? t('input.hintOne', { label: label(items[0]) })
          : t('input.hintMany', { count: items.length })}
      </span>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          data-redaction-hint={item.category}
          onClick={() => onHide([item])}
          title={t('input.hintHideOne')}
          className={`rounded-md bg-warning/15 px-1.5 font-mono text-text-primary ${
            touch ? 'h-8' : 'h-5'
          } hover:bg-warning/25`}
        >
          {label(item)} {previewOf(item.value)}
        </button>
      ))}
      <button
        type="button"
        data-redaction-hide-all=""
        onClick={() => onHide(items)}
        className={`rounded-md px-2 font-medium text-accent hover:bg-accent/10 ${touch ? 'h-8' : 'h-5'}`}
      >
        {items.length === 1 ? t('input.hintHide') : t('input.hintHideAll')}
      </button>
      <button
        type="button"
        data-redaction-hints-dismiss=""
        onClick={onDismiss}
        title={t('input.hintKeep')}
        aria-label={t('input.hintKeep')}
        className={`ml-auto flex items-center justify-center rounded-md text-text-tertiary hover:text-text-secondary ${
          touch ? 'h-8 w-8' : 'h-5 w-5'
        }`}
      >
        <X size={touch ? 16 : 12} />
      </button>
    </div>
  )
}
