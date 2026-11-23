/**
 * 答完之后留在对话里的记录 —— 只读，不能再操作。
 *
 *  - `ToolAnswerLines`：审批卡片的决定，工具行下面一行（命令、diff 本来就在工具行展开后）；
 *  - `AskRecord`：选择题，一行 `问题 → 回答`，点开看完整问题与全部选项。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, MessageCircleQuestion, X } from 'lucide-react'
import type { AskToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolAnswerNote } from '@shuvix/chat-protocol/types/toolAnswer'
import { useChatDensity } from '../../host/chatHostContext'
import { AnsweredByParentBadge } from './BgTaskTag'
import { RedactedText } from './RedactedText'
import { ICON_SLOT } from './StepRow'

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

/**
 * 答完的选择题：一行，与上下的步骤行同一个形状（2026-11-22，用户选的方案 A）——
 * `? 问题（截断） → 你的回答`，没有边框。点这一行展开：完整的问题、全部选项（对勾在选中的上）、写的那段话全文。
 *
 * 宽度先让给回答（不收缩，最多占这一行的 65%），问题截断：回答是这一行要读到的东西。行内的 data-* 锚点与旧记录相同，页面对象照读。
 */
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
  const sep = <span className="text-text-tertiary"> · </span>

  return (
    <div data-ask-record="" className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-ask-record-toggle=""
        className={`group w-full flex items-center gap-1.5 px-1 rounded-md text-left text-text-tertiary hover:bg-bg-tertiary/60 transition-colors ${
          touch ? 'min-h-8 py-1 text-sm' : 'py-1 text-[12px]'
        }`}
      >
        <span className={ICON_SLOT}>
          <MessageCircleQuestion size={touch ? 14 : 12} />
        </span>
        <span className="min-w-[3em] truncate" data-ask-record-question="">
          <RedactedText text={details.question} />
        </span>
        <span aria-hidden="true" className="flex-shrink-0">
          →
        </span>
        <span className="flex-shrink-0 max-w-[65%] truncate font-medium text-text-primary">
          {selections.map((selection, i) => (
            <span key={`${i}-${selection}`}>
              {i > 0 && sep}
              <span data-ask-record-selection="">
                <RedactedText text={selection} />
              </span>
            </span>
          ))}
          {other && (
            <>
              {selections.length > 0 && sep}
              {/* 一行里只放那句话本身；全文与「你的回答」字样在展开处 */}
              <span data-ask-record-other="" className="font-normal">
                <RedactedText text={other} />
              </span>
            </>
          )}
          {noSelection && (
            <span data-ask-record-none="" className="font-normal text-text-secondary">
              {t('pendingInputs.recordNoSelection')}
            </span>
          )}
          {legacyOther !== undefined && (
            <span data-ask-record-legacy="" className="font-normal text-text-secondary">
              <RedactedText text={legacyOther} />
            </span>
          )}
        </span>
        {/* 别的会话代答（§19.5）：一眼看得出这不是用户自己选的 */}
        {answeredBy && (
          <span className="flex-shrink-0" data-ask-record-by="">
            <AnsweredByParentBadge title={answeredBy.title} kind={answeredBy.kind} />
          </span>
        )}
        <span className="flex-1" />
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''} ${
            touch || open ? '' : 'opacity-0 group-hover:opacity-100'
          }`}
        />
      </button>
      {open && (
        <div
          data-ask-record-detail=""
          className={`ml-[11px] mt-0.5 mb-1 pl-3 border-l border-border-secondary/50 space-y-1.5 ${
            touch ? 'text-sm' : 'text-[12px]'
          }`}
        >
          <p className="break-words text-text-secondary leading-snug">
            <RedactedText text={details.question} />
          </p>
          {options.length > 0 && (
            <ul className="space-y-1" data-ask-record-options="">
              {options.map((option, i) => (
                <li key={`${i}-${option.label}`} className="flex items-start gap-1.5">
                  <span className="w-[13px] flex-shrink-0">
                    {chosen.has(option.label) && (
                      <Check size={13} className="mt-[2px] text-success" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={`block break-words ${
                        chosen.has(option.label)
                          ? 'font-medium text-text-primary'
                          : 'text-text-tertiary'
                      }`}
                    >
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
          {other && (
            <p
              data-ask-record-note=""
              className="break-words whitespace-pre-wrap text-text-primary"
            >
              {/* 别的会话写的不是「你的回答」：一行里的代答标记已说明是谁 */}
              {!answeredBy && (
                <span className="text-text-tertiary">{t('pendingInputs.recordYourAnswer')}</span>
              )}
              <RedactedText text={other} />
            </p>
          )}
          {legacyOther !== undefined && (
            <p className="whitespace-pre-wrap break-words text-text-secondary">
              <RedactedText text={legacyOther} />
            </p>
          )}
        </div>
      )}
    </div>
  )
}
