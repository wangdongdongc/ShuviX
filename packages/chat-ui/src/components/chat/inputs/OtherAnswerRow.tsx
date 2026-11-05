/**
 * 询问卡片上写一句话的那一行。审批卡：不选上面的行，告诉 AI 换个做法，这一行有自己的发送键。选项题：自己的回答或给
 * 勾选补一句，和勾选共用卡片底部的发送键（`sendButton` 不传），回车发的是同一份答复（`response`）。
 *
 * 输入框只管发消息，这里才是回答卡片的地方 —— 所以只是一行纯文本：没有 @ 文件、粘贴芯片和要藏的值。
 * 带这句话的答复里 `secrets: []` 不能省（见 drafts）：宿主据此走输入框那条路（agentSession.respondFromComposer），
 * 记下默认照发的几类。
 *
 * 话存在这条询问的草稿里（步进到别的询问再回来还在），成功后询问从视图消失、草稿随之清掉，所以这里从不手动清空：
 * 投递失败时话还在，错误显示在这一行下面。
 *
 * 不自动抢焦点：用户可能正在输入框里打字，而且焦点在这里时数字键是打字，不再选行。
 */
import { Pencil, Send } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { useChatDensity } from '../../../host/chatHostContext'
import type { AnswerSubmit } from './useAnswerSubmit'

/** 约六行之后这一行自己滚，不再撑高卡片 */
const MAX_HEIGHT_PX = 120
/** 与 PendingInputsCard 的 pb-3 对齐 */
const GAP_ABOVE_COMPOSER_PX = 12

/**
 * 这一行被悬浮输入卡片盖住时把列表往上挪，刚好露出来，并留出卡片与输入卡片之间那 12px。直接量位置：scroll-margin 配
 * scrollIntoView 在这个列表里挪不动（真页面上量过，0px）。不在对话列表里（笔记本的抽屉）时什么都不做
 */
function keepAboveComposer(el: HTMLElement): void {
  const scroller = el.closest<HTMLElement>('[data-virtuoso-scroller]')
  const row = el.closest<HTMLElement>('[data-other-row]')
  if (!scroller || !row) return
  const covered = parseFloat(getComputedStyle(el).getPropertyValue('--chat-input-h')) || 0
  const limit = scroller.getBoundingClientRect().bottom - covered - GAP_ABOVE_COMPOSER_PX
  const hidden = row.getBoundingClientRect().bottom - limit
  if (hidden > 0) scroller.scrollTop += hidden
}

export function OtherAnswerRow({
  placeholder,
  value,
  onChange,
  response,
  submit,
  sendButton = false
}: {
  placeholder: string
  value: string
  onChange: (next: string) => void
  /** 此刻发送会发什么；null = 还没有可发的 */
  response: InputResponse | null
  submit: AnswerSubmit
  /** 这一行自己带发送键（有内容时才出现） */
  sendButton?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const ref = useRef<HTMLTextAreaElement>(null)

  // 随内容长高；卡片在对话流末尾、列表不跟随，长高时把这一行留在悬浮输入卡片上方
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
    if (document.activeElement === el) keepAboveComposer(el)
  }, [value])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 229：Safari 上确认输入法候选的那个回车 isComposing 已是 false。长按连发不算第二次
    if (e.key !== 'Enter' || e.shiftKey || e.repeat) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    // 与输入框同一条规矩 —— 触屏：回车就是换行，发送走按钮；接了实体键盘的用 ⌘ / Ctrl + 回车
    if (touch && !e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    if (response) submit.send(response)
  }

  return (
    <div className="border-t border-border-secondary/40" data-other-row="">
      <div
        className={`flex items-start ${touch ? 'min-h-11 gap-3 px-4 py-2' : 'min-h-8 gap-2.5 px-3.5 py-1.5'}`}
      >
        <span
          aria-hidden="true"
          className={`flex-shrink-0 flex items-center justify-center text-text-tertiary ${
            touch ? 'w-5 h-7' : 'w-4 h-5'
          }`}
        >
          <Pencil size={touch ? 13 : 11} />
        </span>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => {
            submit.clearError()
            onChange(e.target.value)
          }}
          onKeyDown={handleKeyDown}
          onFocus={(e) => keepAboveComposer(e.currentTarget)}
          placeholder={placeholder}
          aria-label={placeholder}
          data-other-input=""
          // 手机上小于 16px 时 iOS 一聚焦就放大页面
          className={`flex-1 min-w-0 bg-transparent resize-none outline-none overflow-y-auto thin-scrollbar leading-snug text-text-primary placeholder:text-text-tertiary ${
            touch ? 'py-[3px] text-base' : 'py-px text-[13px]'
          }`}
        />
        {sendButton && response && (
          <button
            type="button"
            onClick={() => submit.send(response)}
            disabled={submit.sending}
            title={t('input.send')}
            aria-label={t('input.send')}
            data-other-submit=""
            className={`flex-shrink-0 flex items-center justify-center bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors ${
              touch ? 'h-7 w-7 rounded-full' : 'h-5 w-5 rounded-md'
            }`}
          >
            <Send size={touch ? 14 : 11} />
          </button>
        )}
      </div>
      {submit.error && (
        <div
          data-other-error=""
          className={`text-error break-words ${touch ? 'px-4 pb-2 text-xs' : 'px-3.5 pb-1.5 text-[11px]'}`}
        >
          {t('input.sendFailed', { error: submit.error })}
        </div>
      )}
    </div>
  )
}
