import { Eye, EyeOff, KeyRound, MessageCircleQuestion } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  hasSecretFields,
  type FormField,
  type FormInputRequest
} from '@shuvix/chat-protocol/types/inputRequest'
import { useChatDensity } from '../../../host/chatHostContext'
import type { InputFormProps } from './types'
import { otherResponseOf, type FormDraft } from './drafts'
import { ClampedText } from './ClampedText'
import { OtherAnswerRow } from './OtherAnswerRow'
import { useAnswerSubmit } from './useAnswerSubmit'

/**
 * 表单单项输入：
 * - `type === 'secret'`：默认 password 打码（多行时用 textarea + 等宽样式，支持显隐切换），
 *   值只留在局部状态里，**不写进 chatStore 草稿**；
 * - `type === 'text'`：明文输入，值随 `draft.values` 存草稿，切到收件箱再切回来不丢。
 */
function FormFieldRow({
  field,
  value,
  touch,
  last,
  onChange,
  onEnter,
  inputRef
}: {
  field: FormField
  value: string
  touch: boolean
  last: boolean
  onChange: (value: string) => void
  onEnter: () => void
  inputRef: (el: HTMLInputElement | HTMLTextAreaElement | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const [shown, setShown] = useState(false)
  const isSecret = field.type === 'secret'
  const required = field.required !== false

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.repeat) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (field.multiline && !e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    onEnter()
  }

  return (
    <div data-form-field={field.key} data-form-field-type={field.type}>
      <label
        htmlFor={id}
        className={`flex flex-wrap items-baseline gap-x-1.5 leading-snug ${
          touch ? 'text-[12px]' : 'text-[11px]'
        }`}
      >
        <span className="min-w-0 break-words font-medium text-text-primary">{field.label}</span>
        {isSecret && (
          <span
            data-form-field-secret=""
            className="rounded bg-accent/10 px-1 py-px text-[10px] font-medium text-accent"
          >
            {t('pendingInputs.formSecretBadge')}
          </span>
        )}
        {!required && (
          <span className="text-text-tertiary" data-form-field-optional="">
            {t('toolCall.askFieldOptional')}
          </span>
        )}
      </label>
      {field.description && (
        <p
          className={`mt-0.5 text-text-tertiary leading-snug ${
            touch ? 'text-[12px]' : 'text-[11px]'
          }`}
        >
          {field.description}
        </p>
      )}
      {field.multiline ? (
        <div className="mt-1 relative rounded-md border border-border-secondary bg-bg-primary focus-within:border-accent transition-colors">
          <textarea
            id={id}
            ref={inputRef}
            rows={3}
            value={isSecret ? undefined : value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-required={required}
            placeholder={field.placeholder}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-form-field-input=""
            style={
              isSecret && !shown
                ? ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)
                : undefined
            }
            className={`w-full bg-transparent px-2 py-1.5 font-mono text-text-primary outline-none resize-y thin-scrollbar ${
              isSecret ? 'pr-8' : ''
            } ${touch ? 'text-base' : 'text-[12.5px]'}`}
          />
          {isSecret && (
            <button
              type="button"
              onClick={() => setShown((v) => !v)}
              title={shown ? t('toolCall.askFieldHide') : t('toolCall.askFieldShow')}
              aria-label={shown ? t('toolCall.askFieldHide') : t('toolCall.askFieldShow')}
              className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:text-text-primary transition-colors"
            >
              {shown ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          )}
        </div>
      ) : (
        <div
          className={`mt-1 flex items-center rounded-md border border-border-secondary bg-bg-primary focus-within:border-accent transition-colors ${
            touch ? 'h-11' : 'h-7'
          }`}
        >
          <input
            id={id}
            ref={inputRef}
            type={isSecret && !shown ? 'password' : 'text'}
            value={isSecret ? undefined : value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-required={required}
            placeholder={field.placeholder}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint={last ? 'done' : 'next'}
            data-form-field-input=""
            className={`min-w-0 flex-1 bg-transparent px-2 text-text-primary outline-none ${
              isSecret ? 'font-mono' : ''
            } ${touch ? 'text-base' : 'text-[12.5px]'}`}
          />
          {isSecret && (
            <button
              type="button"
              onClick={() => setShown((v) => !v)}
              title={shown ? t('toolCall.askFieldHide') : t('toolCall.askFieldShow')}
              aria-label={shown ? t('toolCall.askFieldHide') : t('toolCall.askFieldShow')}
              className={`flex flex-shrink-0 items-center justify-center text-text-tertiary hover:text-text-primary transition-colors ${
                touch ? 'h-10 w-10' : 'h-7 w-7'
              }`}
            >
              {shown ? <EyeOff size={touch ? 15 : 13} /> : <Eye size={touch ? 15 : 13} />}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 结构化表单询问卡片（`ask` 工具 `fields` 模式）：
 * - 支持 `text` 与 `secret` 混合字段；
 * - 含敏感字段时顶部显示锁图标与“仅当前会话加密保存”提示，且敏感字段值不进草稿 store；
 * - 底部保留 `OtherAnswerRow`，用户不填表单时可直接回复 AI 换种做法。
 */
export function FormInputForm({
  request,
  draft,
  onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<FormInputRequest, FormDraft>): React.JSX.Element {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const { question, detail, fields } = request
  const hasSecret = hasSecretFields(request)
  const submit = useAnswerSubmit(onSubmit)

  // 敏感字段值只存组件局部状态，绝不进入 chatStore.sessionInputDrafts
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const fieldInputs = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>())

  const valueOf = (field: FormField): string =>
    field.type === 'secret' ? (secretValues[field.key] ?? '') : (draft.values[field.key] ?? '')

  const handleFieldChange = (field: FormField, next: string): void => {
    submit.clearError()
    if (field.type === 'secret') {
      setSecretValues((prev) => ({ ...prev, [field.key]: next }))
    } else {
      onDraftChange({ ...draft, values: { ...draft.values, [field.key]: next } })
    }
  }

  const missingRequired = fields.some((field) => {
    if (field.required === false) return false
    const v = valueOf(field)
    return (field.multiline ? v : v.trim()).length === 0
  })

  const handleSubmitForm = (): void => {
    if (missingRequired || submit.sending) return
    const values: Record<string, string> = {}
    for (const field of fields) {
      const raw = valueOf(field)
      values[field.key] = field.multiline ? raw : raw.trim()
    }
    submit.send({ kind: 'form', values })
  }

  const handleFieldEnter = (index: number): void => {
    const next = fields[index + 1]
    if (next) {
      fieldInputs.current.get(next.key)?.focus()
      return
    }
    if (!missingRequired) handleSubmitForm()
  }

  const otherResponse = otherResponseOf(draft.otherText)
  const HeaderIcon = hasSecret ? KeyRound : MessageCircleQuestion

  return (
    <div className="flex flex-col min-h-0" data-form-card={hasSecret ? 'secret' : 'text'}>
      {/* 标题行 */}
      <div className={`flex-shrink-0 ${touch ? 'px-4 pt-3.5 pb-2.5' : 'px-3.5 pt-3 pb-2'}`}>
        <div className="flex items-start gap-1.5 min-w-0">
          <HeaderIcon
            size={touch ? 16 : 13}
            className={`text-accent/80 flex-shrink-0 ${touch ? 'mt-0.5' : 'mt-px'}`}
          />
          <div className="flex-1 min-w-0">
            <ClampedText
              text={question}
              className={`break-words font-medium text-text-primary leading-snug ${
                touch ? 'text-sm' : 'text-[13px]'
              }`}
              data={{ 'data-form-question': '' }}
            />
          </div>
          {titleAccessory}
        </div>
        {hasSecret && (
          <p
            data-form-secret-hint=""
            className={`mt-0.5 text-text-tertiary ${
              touch ? 'pl-[22px] text-[12px]' : 'pl-[19px] text-[11px]'
            }`}
          >
            {t('pendingInputs.formSecretHint')}
          </p>
        )}
      </div>

      {/* 说明 + 字段列表：只有这一段会滚 */}
      <div className="min-h-0 overflow-y-auto thin-scrollbar">
        {detail && (
          <pre
            className={`text-[12px] text-text-tertiary bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto max-h-24 whitespace-pre-wrap break-all font-mono !mt-0 ${
              touch ? 'mx-4 mb-2.5' : 'mx-3.5 mb-2'
            }`}
          >
            {detail}
          </pre>
        )}
        <div data-form-fields="" className={`space-y-2.5 ${touch ? 'px-4 pb-3' : 'px-3.5 pb-2.5'}`}>
          {fields.map((field, index) => (
            <FormFieldRow
              key={field.key}
              field={field}
              value={valueOf(field)}
              touch={touch}
              last={index === fields.length - 1}
              onChange={(val) => handleFieldChange(field, val)}
              onEnter={() => handleFieldEnter(index)}
              inputRef={(el) => {
                if (el) fieldInputs.current.set(field.key, el)
                else fieldInputs.current.delete(field.key)
              }}
            />
          ))}
          <div className="flex justify-end pt-0.5">
            <button
              type="button"
              onClick={handleSubmitForm}
              disabled={missingRequired || submit.sending}
              data-form-submit=""
              className={`rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${
                !missingRequired
                  ? 'bg-accent text-white hover:bg-accent-hover'
                  : 'bg-bg-secondary text-text-tertiary'
              } ${touch ? 'h-9 px-4 text-sm' : 'h-7 px-3 text-[12px]'}`}
            >
              {t('pendingInputs.formSubmit')}
            </button>
          </div>
        </div>
      </div>

      {/* 底部「或者告诉 AI 换个做法」 */}
      <div className="flex-shrink-0">
        <OtherAnswerRow
          placeholder={t('pendingInputs.otherPlaceholderForm')}
          value={draft.otherText ?? ''}
          onChange={(otherText) => onDraftChange({ ...draft, otherText })}
          response={otherResponse}
          submit={submit}
          sendButton
        />
      </div>
    </div>
  )
}
