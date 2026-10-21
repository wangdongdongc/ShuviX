// @vitest-environment jsdom
/**
 * ask 工具卡的「代答」标签（ToolCallBlock 摘要行的 badge 槽 → BgTaskTag 的 AnsweredByParentBadge；jsdom）。
 * 答题方来自工具结果的 `details.answeredBy`（宿主写的，docs/sub-session-design.md §19.5）：
 *
 *   XS-66 answeredBy.kind = 'session'（经会话权限表被授权的别的会话代答）→「Answered by another session」，
 *         data-answered-by="session"
 *   XS-66 [guard] kind = 'parent-session' / 没有 kind（旧记录）→「Answered by parent」，
 *         data-answered-by="parent-session"，悬停说明带父会话标题（没有标题用不带标题的那句）
 *   XS-66 [guard] 没有 answeredBy（用户自己答的）→ 没有标签
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（getHostApi → null）；i18n 走真 en 资源。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AskToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { DrivingSessionRef } from '@shuvix/chat-protocol/types/inputRequest'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore } from '../../../stores/chatStore'
import { ToolCallBlock } from '../ToolCallBlock'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  })
})

beforeEach(() => {
  useChatStore.setState({
    toolPresentations: {},
    activeSessionId: 'sess-child',
    sessionToolExecutions: {},
    sessionPendingInputs: {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** 渲染一张做完了的 ask 工具卡（折叠态：摘要行上就有标签） */
function renderAsk(answeredBy?: DrivingSessionRef): void {
  const details: AskToolDetails = {
    type: 'ask',
    question: 'Which database?',
    selections: ['Postgres'],
    ...(answeredBy ? { answeredBy } : {})
  }
  act(() => {
    root.render(
      createElement(ToolCallBlock, {
        toolName: 'ask',
        toolCallId: 'tc-ask-1',
        args: { question: 'Which database?' },
        result: 'Postgres',
        details,
        status: 'done'
      })
    )
  })
}

const badges = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-answered-by]')
]
const badge = (): HTMLElement => {
  const all = badges()
  expect(all).toHaveLength(1)
  return all[0]
}

describe('ask 卡的代答标签（XS-66）', () => {
  it('XS-66 别的会话代答：「Answered by another session」，data-answered-by="session"', () => {
    renderAsk({ kind: 'session', sessionId: 'sess-other', title: 'Release notes' })
    const tag = badge()
    expect(tag.getAttribute('data-answered-by')).toBe('session')
    expect(tag.textContent).toBe(en.toolCall.answeredBySessionTag)
    expect(tag.textContent).toBe('Answered by another session')
    expect(tag.textContent).not.toBe(en.toolCall.answeredByParentTag)
    // 标签就在 ask 卡的摘要行里
    expect(tag.closest('[data-tool-name]')?.getAttribute('data-tool-name')).toBe('ask')
  })

  it('XS-66 [guard] 父会话代答：「Answered by parent」，data-answered-by="parent-session"，悬停带标题', () => {
    renderAsk({ kind: 'parent-session', sessionId: 'sess-parent', title: 'Planner' })
    const tag = badge()
    expect(tag.getAttribute('data-answered-by')).toBe('parent-session')
    expect(tag.hasAttribute('data-answered-by-parent')).toBe(true)
    expect(tag.textContent).toBe(en.toolCall.answeredByParentTag)
    expect(tag.textContent).toBe('Answered by parent')
    expect(tag.getAttribute('title')).toBe(
      i18n.t('toolCall.answeredByParentHint', { title: 'Planner' })
    )
    expect(tag.getAttribute('title')).toContain('“Planner”')
  })

  it('XS-66 [guard] 没有 kind（旧记录）按父会话读；没有标题用不带标题的悬停说明', () => {
    renderAsk({ sessionId: 'sess-parent' } as DrivingSessionRef)
    const tag = badge()
    expect(tag.getAttribute('data-answered-by')).toBe('parent-session')
    expect(tag.textContent).toBe(en.toolCall.answeredByParentTag)
    expect(tag.getAttribute('title')).toBe(en.toolCall.answeredByParentHintNoTitle)
  })

  it('XS-66 [guard] 用户自己答的（没有 answeredBy）：没有标签', () => {
    renderAsk()
    expect(container.querySelector('[data-tool-name="ask"]')).not.toBeNull()
    expect(badges()).toHaveLength(0)
    expect(container.querySelector('[data-answered-by-parent]')).toBeNull()
    expect(container.textContent).not.toContain(en.toolCall.answeredByParentTag)
    expect(container.textContent).not.toContain(en.toolCall.answeredBySessionTag)
  })
})
