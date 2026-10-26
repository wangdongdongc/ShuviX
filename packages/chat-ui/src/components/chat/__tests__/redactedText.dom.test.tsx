// @vitest-environment jsdom
/**
 * 自动脱敏的标记（RedactedText / RedactedMark / 缓存 / markdown 里的标记，docs/auto-redaction-design.md §2.3，jsdom）：
 *
 *   RD-1 查到真值：显示真值（带 data-redaction 类别、悬停是类别名）；同一轮里的几处攒成一次查询
 *   RD-2 查到但解不开：一枚带类别名的小签，悬停说明读不出值；表里没有：同样的小签，刚问过的不重复问
 *   RD-3 归属：缺省按当前会话问；RedactionSessionProvider 指明的会话按它问
 *   RD-4 markdown：正文与代码块里的占位符都显示成真值；复制用的文本换回真值；行内代码里的路径按真值认成路径
 *   RD-5 没有占位符的文本原样，不发查询
 *
 * 后端是注入的 SessionChannelApi（只有 redaction.resolve 有用）；i18n 走真 en 资源；不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { RedactionMarkInfo } from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { setSessionChannelApi } from '../../../api/chatApi'
import { useChatStore } from '../../../stores/chatStore'
import { resetRedactionCacheForTests, restoreForCopy } from '../../../stores/redactionCache'
import { RedactionSessionProvider } from '../../../hooks/useRedaction'
import { RedactedText } from '../RedactedText'
import { MarkdownText } from '../markdownComponents'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const KEY = '{{API_KEY_k3v7x2mq}}'
const MAIL = '{{EMAIL_b5puzbfv}}'
const SEALED = '{{SECRET_aaaaaaaa}}'
const GONE = '{{TOKEN_bbbbbbbb}}'
const USER = '{{USERNAME_cccccccc}}'

/** 每条会话的对照表 */
const tables: Record<string, Record<string, RedactionMarkInfo>> = {
  s1: {
    [KEY]: { category: 'API_KEY', value: 'sk-real-0123456789' },
    [MAIL]: { category: 'EMAIL', value: 'alice@acme-corp.cn' },
    [SEALED]: { category: 'SECRET' },
    [USER]: { category: 'USERNAME', value: 'alice' }
  },
  other: { [KEY]: { category: 'API_KEY', value: 'sk-other-session' } }
}
const calls: Array<{ sessionId: string; placeholders: string[] }> = []

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  setSessionChannelApi({
    redaction: {
      resolve: async ({ sessionId, placeholders }) => {
        calls.push({ sessionId, placeholders: [...placeholders] })
        const table = tables[sessionId] ?? {}
        return Object.fromEntries(placeholders.filter((p) => table[p]).map((p) => [p, table[p]!]))
      }
    }
  } as unknown as SessionChannelApi)
})

beforeEach(() => {
  resetRedactionCacheForTests()
  calls.length = 0
  useChatStore.setState({ activeSessionId: 's1' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function show(element: React.ReactElement): Promise<void> {
  await act(async () => root.render(element))
  // 攒批（微任务）→ 查询 → 通知重渲染
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const marks = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-redaction]')]

describe('脱敏标记', () => {
  it('RD-1 查到真值：显示真值；几处攒成一次查询', async () => {
    await show(createElement(RedactedText, { text: `key ${KEY}, mail ${MAIL}, again ${KEY}.` }))
    expect(container.textContent).toBe(
      'key sk-real-0123456789, mail alice@acme-corp.cn, again sk-real-0123456789.'
    )
    expect(marks().map((m) => [m.dataset.redaction, m.title])).toEqual([
      ['API_KEY', 'API key'],
      ['EMAIL', 'Email address'],
      ['API_KEY', 'API key']
    ])
    expect(calls).toEqual([{ sessionId: 's1', placeholders: [KEY, MAIL] }])
  })

  it('RD-2 解不开 / 表里没有：类别小签；刚问过的不重复问', async () => {
    await show(createElement(RedactedText, { text: `${SEALED} ${GONE}` }))
    const [sealed, gone] = marks()
    expect(sealed!.textContent).toBe('Secret')
    expect(sealed!.title).toMatch(/cannot be read/)
    expect(sealed!.hasAttribute('data-redaction-missing')).toBe(true)
    expect(gone!.textContent).toBe('Token')
    expect(gone!.title).toBe('Token')
    await show(createElement(RedactedText, { text: `${GONE} ${SEALED} !` }))
    expect(calls).toEqual([{ sessionId: 's1', placeholders: [SEALED, GONE] }])
  })

  it('RD-3 归属：缺省当前会话，Provider 指明的按它', async () => {
    await show(
      createElement(
        'div',
        null,
        createElement(RedactedText, { text: KEY }),
        createElement(
          RedactionSessionProvider,
          { sessionId: 'other' },
          createElement(RedactedText, { text: ` / ${KEY}` })
        )
      )
    )
    expect(container.textContent).toBe('sk-real-0123456789 / sk-other-session')
  })

  it('RD-4 markdown：正文、代码块、复制、行内路径', async () => {
    const md = `Use ${KEY} here.\n\n\`\`\`bash\nexport OPENAI_API_KEY="${KEY}"\n\`\`\`\n\nOpen \`/Users/${USER}/proj/app.ts\``
    await show(createElement(MarkdownText, { text: md }))
    const text = container.textContent ?? ''
    expect(text).toContain('Use sk-real-0123456789 here.')
    expect(text).toContain('export OPENAI_API_KEY="sk-real-0123456789"')
    expect(text).not.toContain('{{')
    expect(marks().map((m) => m.dataset.redaction)).toEqual(['API_KEY', 'API_KEY'])
    // 行内代码里的路径按真值认成路径（PathChip 的悬停是完整路径）
    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.title.startsWith('/Users/alice/proj/app.ts')
    )
    expect(chip).toBeDefined()
    expect(restoreForCopy('s1', `export K="${KEY}"`)).toBe('export K="sk-real-0123456789"')
  })

  it('RD-5 没有占位符：原样，不发查询', async () => {
    await show(createElement(RedactedText, { text: 'plain {{x}} text' }))
    expect(container.textContent).toBe('plain {{x}} text')
    expect(calls).toEqual([])
  })
})
