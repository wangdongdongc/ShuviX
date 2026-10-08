// @vitest-environment jsdom
/**
 * 折叠掉的重试在卡片上的样子（jsdom，P3-12，Q-P3-06 / PIN-21）：
 *
 *   P3-12-18 重试成功恢复后卡上不留重试记录（用户 2026-10-07 改判，原先是「重试 ×N」提示）：落定的卡、
 *            覆盖多条消息的卡、流式卡及其落盘前后都没有提示
 *   P3-12-19 最终失败：带 `metadata.retried {count:10}` 的 error_event 是一行错误 + 「after 10 retries」；
 *            `metadata:null` 与原来一模一样
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AssistantMessage, ErrorEventMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { LiveCard } from '@shuvix/chat-protocol/types/sessionView'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))
vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { applySessionView } from '../../../stores/chatStore'
import { AssistantBubble } from '../AssistantBubble'
import { MessageRenderer } from '../MessageRenderer'
import { streamingPlaceholder } from '../conversationItems'
import { V, assistant, errorRow, resetStore, text, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'

let container: HTMLDivElement
let root: Root

const retried = (count: number, lastError: string): AssistantMessage['metadata'] => ({
  retried: { count, lastError }
})

function renderBubble(msgs: AssistantMessage[], isStreaming = false): void {
  act(() => root.render(createElement(AssistantBubble, { msgs, isStreaming })))
}

const hint = (): HTMLElement | null => container.querySelector('[data-retried-hint]')

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

describe('P3-12-18 recovered retries leave no trace on the card', () => {
  // 用户 2026-10-07：重试成功恢复之后不再保留中间的重试记录 —— 卡上没有「重试 ×N」；
  // 重试进行中的倒计时（RunStatusRows）与最终失败那一行的次数（P3-12-19）不受影响
  it('P3-12-18 a settled card with retried {count:2} shows no retry hint', () => {
    renderBubble([assistant('a1', [text('ok')], SID, retried(2, '503'))])
    expect(hint()).toBeNull()
    expect(container.textContent).not.toContain('retried')
  })

  it('P3-12-18 a turn card whose messages carry counts 1 and 2 shows no retry hint', () => {
    renderBubble([
      assistant('a1', [{ type: 'tool', toolCallId: 't1', toolName: 'read', args: {} }], SID, {
        retried: { count: 1, lastError: '500' }
      }),
      assistant('a2', [text('done')], SID, retried(2, '503'))
    ])
    expect(hint()).toBeNull()
  })

  it('P3-12-18 a live card with retried {count:2} shows no retry hint, before and after it is committed', () => {
    const base = assistant('live:7', [text('after retry')], SID, retried(2, '503'))
    const live: LiveCard = { id: 'live:7', message: base }
    act(() =>
      applySessionView(SID, V(SID, { messages: [user('u1', 'hi')], live, run: { state: 'busy' } }))
    )
    const placeholder = [streamingPlaceholder(SID)]
    renderBubble(placeholder, true)
    expect(hint()).toBeNull()
    const committed = assistant('9', [text('after retry')], SID, retried(2, '503'))
    act(() =>
      applySessionView(
        SID,
        V(SID, { messages: [user('u1', 'hi'), committed], live: null, run: { state: 'idle' } })
      )
    )
    renderBubble([committed], false)
    expect(hint()).toBeNull()
  })
})

describe('P3-12-19 final-failure row', () => {
  const renderRow = (msg: ErrorEventMessage): void => {
    act(() =>
      root.render(
        createElement(MessageRenderer, { item: { key: msg.id, msg }, lastAssistantId: null })
      )
    )
  }

  it('P3-12-19 an error_event with retried {count:10}: one error row with the message plus "after 10 retries"', () => {
    renderRow({ ...errorRow('e1', '503 Service Unavailable'), metadata: retried(10, '503') })
    expect(container.querySelectorAll('[data-msg-type="error_event"]')).toHaveLength(1)
    const row = container.querySelector('[data-msg-type="error_event"]')!
    expect(row.textContent).toContain('503 Service Unavailable')
    expect(row.querySelector('[data-error-retries]')!.textContent).toBe('after 10 retries')
  })

  it('P3-12-19 metadata:null renders exactly as before (no count)', () => {
    renderRow(errorRow('e1', 'boom'))
    const row = container.querySelector('[data-msg-type="error_event"]')!
    expect(row.querySelector('[data-error-retries]')).toBeNull()
    expect(row.textContent).toBe('boom')
  })
})
