/**
 * 答完之后留在对话里的记录 —— 只读，不能再操作。
 *
 *  - `ToolAnswerLines`：审批卡片的决定，工具行下面一行（命令、diff 本来就在工具行展开后）；
 *  - `AskRecord`：选择题，问题 + 答案，其余选项可以展开看。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { AskToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolAnswerNote } from '@shuvix/chat-protocol/types/toolAnswer'
import { useChatDensity } from '../../host/chatHostContext'
import { AnsweredByParentBadge } from './BgTaskTag'
import { RedactedText } from './RedactedText'

/** 工具行上人的决定（一次调用过几道门就有几行） */
export function ToolAnswerLines({
  notes
}: {
  notes: readonly ToolAnswerNote[]
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (notes.length === 0) return null
  return (
    <div className="ml-[18px] mt-px mb-0.5 space-y-px">
      {notes.map((note, i) => {
        const positive = note.outcome === 'allowed' || note.outcome === 'remembered'
        return (
          <div
            key={i}
            data-tool-answer={note.outcome}
            className="flex items-start gap-1.5 text-[11.5px] leading-[18px] text-text-tertiary"
          >
            {positive ? (
              <Check size={11} className="mt-[3.5px] flex-shrink-0 text-success" />
            ) : (
              <X size={11} className="mt-[3.5px] flex-shrink-0 text-error" />
            )}
            <span className="min-w-0 break-words">
              {note.outcome === 'allowed' && t('pendingInputs.answerAllowed')}
              {note.outcome === 'denied' && t('pendingInputs.answerDenied')}
              {note.outcome === 'remembered' && (
                <>
                  {t('pendingInputs.answerRemembered')}
                  {note.target && (
                    <span className="ml-1 font-mono">
                      <RedactedText text={note.target} />
                    </span>
                  )}
                </>
              )}
              {note.outcome === 'feedback' && (
                <>
                  {t('pendingInputs.answerFeedback')}
                  <span className="whitespace-pre-wrap text-text-secondary">
                    <RedactedText text={note.text ?? ''} />
                  </span>
                </>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 工具参数里的选项（形状不对的项跳过） */
function optionsOf(args: unknown): Array<{ label: string; description: string }> {
  const raw = (args as { options?: unknown } | null | undefined)?.options
  if (!Array.isArray(raw)) return []
  const out: Array<{ label: string; description: string }> = []
  for (const option of raw) {
    const { label, description } = (option ?? {}) as Record<string, unknown>
    if (typeof label === 'string') {
      out.push({ label, description: typeof description === 'string' ? description : '' })
    }
  }
  return out
}

/** 答完的选择题 */
export function AskRecord({
  details,
  args,
  result
}: {
  details: AskToolDetails
  args: unknown
  /** 工具结果的文字：旧会话的「其它」回答只在这里 */
  result?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const [open, setOpen] = useState(false)
  const options = optionsOf(args)
  const { other, answeredBy } = details
  // 落盘的数据形状不保证：一条坏记录不能让整张对话卡崩掉
  const selections = Array.isArray(details.selections) ? details.selections : []
  const chosen = new Set(selections)
  // 没选、也没写：要么真的没选（结果文字由 ask 工具写，见 askTool），要么是旧会话的「其它」回答 —— 旧会话没有
  // details.other，那段话只在结果文字里（英文的固定开头一并显示，不去解析它）
  const unanswered = selections.length === 0 && !other
  const noSelection = unanswered && (!result || /made no selection\.?$/.test(result))
  const legacyOther = unanswered && !noSelection ? result : undefined

  return (
    <div
      data-ask-record=""
      className={`my-1 rounded-xl border border-border-secondary/50 ${
        touch ? 'px-3.5 py-2.5 text-sm' : 'px-3 py-2 text-[13px]'
      }`}
    >
      <div className={`text-text-tertiary break-words ${touch ? 'text-[13px]' : 'text-[12px]'}`}>
        <RedactedText text={details.question} />
      </div>
      {selections.length > 0 &&
        selections.map((selection, i) => (
          <div
            key={`${i}-${selection}`}
            data-ask-record-selection=""
            className="mt-0.5 flex items-start gap-1.5 font-medium text-text-primary"
          >
            <Check size={touch ? 15 : 13} className="mt-[3px] flex-shrink-0 text-success" />
            <span className="min-w-0 break-words">
              <RedactedText text={selection} />
            </span>
          </div>
        ))}
      {other && (
        <div data-ask-record-other="" className="mt-0.5 break-words text-text-primary">
          {/* 别的会话写的不是「你的回答」：由下面的代答标记说明是谁 */}
          {!answeredBy && (
            <span className="text-text-tertiary">{t('pendingInputs.recordYourAnswer')}</span>
          )}
          <span className="whitespace-pre-wrap">
            <RedactedText text={other} />
          </span>
        </div>
      )}
      {noSelection && (
        <div data-ask-record-none="" className="mt-0.5 text-text-secondary">
          {t('pendingInputs.recordNoSelection')}
        </div>
      )}
      {legacyOther !== undefined && (
        <div className="mt-0.5 whitespace-pre-wrap break-words text-text-secondary">
          <RedactedText text={legacyOther} />
        </div>
      )}
      {/* 别的会话代答（§19.5）：一眼看得出这不是用户自己选的 */}
      {answeredBy && (
        <div className="mt-1" data-ask-record-by="">
          <AnsweredByParentBadge title={answeredBy.title} kind={answeredBy.kind} />
        </div>
      )}
      {options.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`mt-1 flex items-center gap-0.5 text-text-tertiary hover:text-text-secondary transition-colors ${
            touch ? 'min-h-8 text-[13px]' : 'text-[11.5px]'
          }`}
          data-ask-record-toggle=""
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open
            ? t('pendingInputs.recordHideOptions')
            : t('pendingInputs.recordShowOptions', { count: options.length })}
        </button>
      )}
      {open && (
        <ul className="mt-1 space-y-1" data-ask-record-options="">
          {options.map((option, i) => (
            <li key={`${i}-${option.label}`} className="flex items-start gap-1.5">
              <span className="w-[13px] flex-shrink-0">
                {chosen.has(option.label) && <Check size={13} className="mt-[3px] text-success" />}
              </span>
              <span className="min-w-0">
                <span className="block break-words text-text-secondary">
                  <RedactedText text={option.label} />
                </span>
                {option.description && (
                  <span className="block break-words text-[11.5px] text-text-tertiary">
                    <RedactedText text={option.description} />
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
