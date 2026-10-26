// @vitest-environment jsdom
/**
 * 自动脱敏的占位符怎么显示（RedactedText / RedactedMark / 浮层 / 缓存 / markdown，docs/auto-redaction-design.md §2.3，jsdom）：
 * 界面显示模型收到的样子。
 *
 *   RD-1 模型收到占位符的：显示占位符原文；指到浮出真值（类别、说明、复制）；离开收起；点一下钉住，再点收起
 *   RD-2 模型收到真值的（disclosed）：原样显示真值，没有占位符、不浮出
 *   RD-3 查到但解不开 / 表里没有：显示占位符，浮层说明读不出；刚问过的不重复问；几处攒成一次查询
 *   RD-4 归属：缺省按当前会话问；RedactionSessionProvider 指明的会话按它问
 *   RD-5 markdown：正文与代码块按模型看到的样子；复制用的文本换回真值；行内代码里只有模型收到真值的才换，换完是路径
 *        才认成路径
 *   RD-6 浮出期间真值查到了：浮层就地换成真值
 *   RD-7 策略变了（policy.changed）：记下的重问一遍，模型收到的样子跟着变
 *   RD-8 没有占位符的文本原样，不发查询
 *
 * 后端是注入的 SessionChannelApi（redaction.resolve 与 events）；i18n 走真 en 资源；不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { RedactionMarkInfo } from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { setSessionChannelApi } from '../../../api/chatApi'
import { useChatStore } from '../../../stores/chatStore'
import { resetRedactionCacheForTests, restoreForCopy } from '../../../stores/redactionCache'
import { RedactionSessionProvider } from '../../../hooks/useRedaction'
import { hideRedaction } from '../redactionPopover'
import { RedactedText } from '../RedactedText'
import { MarkdownText } from '../markdownComponents'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const KEY = '{{REDACTED_API_KEY_k3v7x2mq}}'
const MAIL = '{{REDACTED_EMAIL_b5puzbfv}}'
const SEALED = '{{REDACTED_SECRET_aaaaaaaa}}'
// v0.2.30 / v0.2.31 存下的旧写法照样认
const GONE = '{{TOKEN_bbbbbbbb}}'
const USER = '{{USERNAME_cccccccc}}'

/** 每条会话的对照表；disclosed = 模型收到的是真值 */
const tables: Record<string, Record<string, RedactionMarkInfo>> = {}
function resetTables(): void {
  tables.s1 = {
    [KEY]: { category: 'API_KEY', value: 'sk-real-0123456789', disclosed: false },
    [MAIL]: { category: 'EMAIL', value: 'alice@acme-corp.cn', disclosed: false },
    [SEALED]: { category: 'SECRET' },
    [USER]: { category: 'USERNAME', value: 'alice', disclosed: true }
  }
  tables.other = { [KEY]: { category: 'API_KEY', value: 'sk-other-session', disclosed: true } }
}
const calls: Array<{ sessionId: string; placeholders: string[] }> = []
const eventListeners = new Set<(event: AppEvent) => void>()
/** 第一次查询先挂着，放行前浮层里是「正在查」 */
let gate: Promise<void> | null = null

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  setSessionChannelApi({
    redaction: {
      resolve: async ({ sessionId, placeholders }) => {
        calls.push({ sessionId, placeholders: [...placeholders] })
        if (gate) await gate
        const table = tables[sessionId] ?? {}
        return Object.fromEntries(placeholders.filter((p) => table[p]).map((p) => [p, table[p]!]))
      }
    },
    events: {
      subscribe: (listener: (event: AppEvent) => void) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      }
    }
  } as unknown as SessionChannelApi)
})

beforeEach(() => {
  resetRedactionCacheForTests()
  resetTables()
  calls.length = 0
  gate = null
  useChatStore.setState({ activeSessionId: 's1' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  hideRedaction()
  act(() => root.unmount())
  container.remove()
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function show(element: React.ReactElement): Promise<void> {
  await act(async () => root.render(element))
  // 攒批（微任务）→ 查询 → 通知重渲染
  await settle()
}

const marks = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-redaction]')]
const popover = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-redaction-popover]')
const hover = (el: HTMLElement): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
const leave = async (el: HTMLElement): Promise<void> => {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250))
  })
}

describe('脱敏占位符的显示', () => {
  it('RD-1 模型收到占位符的：显示占位符，指到浮出真值，离开收起，点一下钉住', async () => {
    await show(createElement(RedactedText, { text: `key ${KEY}, mail ${MAIL}.` }))
    expect(container.textContent).toBe(`key ${KEY}, mail ${MAIL}.`)
    const [key] = marks()
    expect(key!.hasAttribute('data-redaction-placeholder')).toBe(true)
    expect(popover()).toBeNull()

    hover(key!)
    expect(popover()?.textContent).toContain('API key')
    expect(popover()?.textContent).toContain('The model receives this placeholder')
    expect(popover()?.querySelector('[data-redaction-value]')?.textContent).toBe(
      'sk-real-0123456789'
    )
    await leave(key!)
    expect(popover()).toBeNull()

    act(() => key!.click())
    await leave(key!)
    expect(popover()).not.toBeNull()
    act(() => key!.click())
    expect(popover()).toBeNull()
  })

  it('RD-2 模型收到真值的：原样显示，不浮出', async () => {
    await show(createElement(RedactedText, { text: `home /Users/${USER}/proj` }))
    expect(container.textContent).toBe('home /Users/alice/proj')
    const [user] = marks()
    expect(user!.hasAttribute('data-redaction-sent')).toBe(true)
    hover(user!)
    expect(popover()).toBeNull()
  })

  it('RD-3 解不开 / 表里没有：显示占位符，浮层说明读不出；刚问过的不重复问；攒成一次查询', async () => {
    await show(createElement(RedactedText, { text: `${SEALED} ${GONE}` }))
    expect(container.textContent).toBe(`${SEALED} ${GONE}`)
    hover(marks()[0]!)
    expect(popover()?.textContent).toContain('cannot read its real value')
    expect(popover()?.querySelector('[data-redaction-value]')).toBeNull()
    // 表里没有的：类别从占位符本身读（新旧写法都是类别名，不带 REDACTED_）
    hover(marks()[1]!)
    expect(marks()[1]!.dataset.redaction).toBe('TOKEN')
    expect(marks()[0]!.dataset.redaction).toBe('SECRET')
    await show(createElement(RedactedText, { text: `${GONE} ${SEALED} !` }))
    expect(calls).toEqual([{ sessionId: 's1', placeholders: [SEALED, GONE] }])
  })

  it('RD-4 归属：缺省当前会话，Provider 指明的按它', async () => {
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
    // s1 里这把 key 以占位符发出，other 会话里以真值发出
    expect(container.textContent).toBe(`${KEY} / sk-other-session`)
  })

  it('RD-5 markdown：模型看到的样子；复制换回真值；行内路径只换模型收到真值的', async () => {
    const md = `Use ${KEY} here.\n\n\`\`\`bash\nexport OPENAI_API_KEY="${KEY}"\n\`\`\`\n\nOpen \`/Users/${USER}/proj/app.ts\` and \`/srv/${KEY}/x\``
    await show(createElement(MarkdownText, { text: md }))
    const text = container.textContent ?? ''
    expect(text).toContain(`Use ${KEY} here.`)
    expect(text).toContain(`export OPENAI_API_KEY="${KEY}"`)
    expect(text).not.toContain('sk-real')
    // 用户名模型收到的是真值：换完是路径，认成路径（悬停是完整路径）
    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.title.startsWith('/Users/alice/proj/app.ts')
    )
    expect(chip).toBeDefined()
    // 路径里有模型收到占位符的部分：不当路径，照样显示占位符
    expect(text).toContain(`/srv/${KEY}/x`)
    expect(restoreForCopy('s1', `export K="${KEY}"`)).toBe('export K="sk-real-0123456789"')
  })

  it('RD-6 浮出期间真值查到了：浮层就地换成真值', async () => {
    let release = (): void => {}
    gate = new Promise((r) => (release = r))
    await show(createElement(RedactedText, { text: KEY }))
    hover(marks()[0]!)
    expect(popover()?.textContent).toContain('Looking up the real value')
    gate = null
    await act(async () => release())
    await settle()
    expect(popover()?.querySelector('[data-redaction-value]')?.textContent).toBe(
      'sk-real-0123456789'
    )
  })

  it('RD-7 策略变了：重问一遍，显示跟着变', async () => {
    await show(createElement(RedactedText, { text: KEY }))
    expect(container.textContent).toBe(KEY)
    tables.s1![KEY] = { category: 'API_KEY', value: 'sk-real-0123456789', disclosed: true }
    act(() => {
      for (const listener of eventListeners) listener({ type: 'policy.changed' })
    })
    await settle()
    expect(container.textContent).toBe('sk-real-0123456789')
    expect(calls).toHaveLength(2)
  })

  it('RD-8 没有占位符：原样，不发查询', async () => {
    await show(createElement(RedactedText, { text: 'plain {{x}} text' }))
    expect(container.textContent).toBe('plain {{x}} text')
    expect(calls).toEqual([])
  })
})
