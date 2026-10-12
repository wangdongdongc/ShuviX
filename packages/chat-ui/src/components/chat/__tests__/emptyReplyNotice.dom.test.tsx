// @vitest-environment jsdom
/**
 * 空回复追问的通知行（jsdom）：工具跑完之后模型回复既没有正文也没有工具调用，agent-runtime 追加的
 * `<empty-reply>` user 消息（投影打 `isSystemNotice` + `noticeKind: 'empty-reply'`）在对话里是一行
 * 系统通知，不是用户气泡，也不是「后台任务已完成」。
 *
 *   ER-UI-1 isSystemNotice + noticeKind empty-reply → `[data-system-notice="empty-reply"]`，标签
 *           `emptyReplyNotice.title`，折叠着；没有后台通知行、没有用户气泡
 *   ER-UI-2 点开：`data-notice-state="expanded"`，写给模型的原文逐字出现在 `pre` 里
 *   ER-UI-3 判据的两半缺一不可：只有 noticeKind（没 isSystemNotice）→ 用户气泡；只有 isSystemNotice
 *           （没 noticeKind）→ 后台通知行
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { UserTextMessage } from '@shuvix/chat-protocol/types/chatMessage'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))
vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { MessageRenderer } from '../MessageRenderer'
import { resetStore, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
/** 与 agent-runtime 的 EMPTY_REPLY_NOTICE_TEXT 同形（chat-ui 不引 agent-runtime） */
const N = [
  '<empty-reply>',
  'Your previous reply had no visible text and no tool call, so nothing happened.',
  'If you meant to call a tool, call it now. If the task is finished, give your answer.',
  '</empty-reply>'
].join('\n')

let container: HTMLDivElement
let root: Root

function render(msg: UserTextMessage): void {
  act(() =>
    root.render(
      createElement(MessageRenderer, {
        item: { key: msg.id, msg },
        lastAssistantId: null,
        onRollback: () => {}
      })
    )
  )
}

const row = (kind: string): HTMLElement | null =>
  container.querySelector(`[data-system-notice="${kind}"]`)
const anyNoticeRow = (): HTMLElement | null => container.querySelector('[data-system-notice]')
const userBubble = (): HTMLElement | null => container.querySelector('.bg-accent\\/10')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the empty-reply notice row', () => {
  const notice = (): UserTextMessage =>
    user('9', N, SID, { isSystemNotice: true, noticeKind: 'empty-reply' })

  it('ER-UI-1 isSystemNotice + noticeKind empty-reply: one empty-reply row with its label, collapsed; no background row, no user bubble', () => {
    render(notice())
    const el = row('empty-reply')
    expect(el).not.toBeNull()
    expect(container.querySelectorAll('[data-system-notice]')).toHaveLength(1)
    expect(el!.textContent).toContain(i18n.t('emptyReplyNotice.title'))
    expect(el!.getAttribute('data-notice-state')).toBe('collapsed')
    expect(el!.querySelector('pre')).toBeNull()
    expect(row('background')).toBeNull()
    expect(userBubble()).toBeNull()
    // 折叠态不把信封原文摊在对话里
    expect(container.textContent).not.toContain('<empty-reply>')
  })

  it('ER-UI-2 clicking the row expands it and shows the text written to the model verbatim in a pre', () => {
    render(notice())
    const el = row('empty-reply')!
    act(() => el.querySelector<HTMLElement>('button')!.click())
    expect(el.getAttribute('data-notice-state')).toBe('expanded')
    const pre = el.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toBe(N)
  })

  it('ER-UI-3 noticeKind empty-reply without isSystemNotice is an ordinary user bubble', () => {
    render(user('9', N, SID, { noticeKind: 'empty-reply' }))
    expect(anyNoticeRow()).toBeNull()
    expect(userBubble()).not.toBeNull()
    expect(userBubble()!.textContent).toContain('<empty-reply>')
  })

  it('ER-UI-3 isSystemNotice without a kind stays the background-completion row', () => {
    render(
      user('9', '<background-task pid="1" status="done">ok</background-task>', SID, {
        isSystemNotice: true
      })
    )
    expect(row('background')).not.toBeNull()
    expect(row('empty-reply')).toBeNull()
    expect(userBubble()).toBeNull()
  })
})
