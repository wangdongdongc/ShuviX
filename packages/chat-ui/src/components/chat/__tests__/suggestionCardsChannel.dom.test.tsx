// @vitest-environment jsdom
/**
 * 提议卡片在**渠道端**（Chrome 侧边栏：只注入了 `setSessionChannelApi`，没有完整宿主）。单独一个文件：注入的完整宿主
 * 在同一个模块实例里撤不掉，而这里要的正是「从来没有注入过」。
 *
 *   C-7c 只有会话通道：卡片照画、没有采纳按钮，渲染不抛（`getChatApi` 在这里会抛；卡片取的是宿主面 `getHostApi`）
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import { suggestionGroupKey } from '@shuvix/chat-protocol/suggestions'
import { setSessionChannelApi } from '../../../api/chatApi'
import { SuggestionCards, SuggestionContext } from '../SuggestionCards'

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
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  setSessionChannelApi({} as unknown as SessionChannelApi)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('C-7c 渠道端只读', () => {
  it('C-7c 只有会话通道：卡片照画、没有按钮、不抛', () => {
    const block = {
      type: 'tool' as const,
      toolCallId: 'call_0',
      toolName: 'suggest',
      args: { suggestions: [{ title: 'Add tests', message: 'Yes, add tests' }] },
      result: 'Shown 1 suggestion'
    }
    const value = {
      sessionId: 's1',
      states: new Map([[suggestionGroupKey('a1', 'call_0'), { status: 'open' as const }]])
    }
    expect(() =>
      act(() => {
        root.render(
          createElement(
            SuggestionContext.Provider,
            { value },
            createElement(SuggestionCards, { messageId: 'a1', block })
          )
        )
      })
    ).not.toThrow()
    expect(container.querySelectorAll('[data-suggestion-index]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-suggestion-accept]')).toHaveLength(0)
    expect(container.querySelector('[data-suggestion-message]')?.textContent).toBe('Yes, add tests')
  })
})
