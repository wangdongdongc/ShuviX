// @vitest-environment jsdom
/**
 * 自动脱敏的占位符怎么显示（RedactedText / RedactedMark / 浮层 / 缓存 / markdown，docs/auto-redaction-design.md §16，jsdom）：
 * 记录里有占位符的地方，界面就显示占位符（模型收到的就是它），指到才浮出真值。
 *
 *   RD-1 显示占位符原文；指到浮出真值（类别、说明、复制）；离开收起；点一下钉住，再点收起
 *   RD-2 USERNAME 这类默认照发的，有真值时也显示占位符、可浮出；没有 data-redaction-sent 这回事
 *   RD-3 查到但解不开 / 表里没有：显示占位符，浮层说明读不出；刚问过的不重复问；几处攒成一次查询
 *   RD-4 归属：缺省按当前会话问；RedactionSessionProvider 指明的会话按它问，浮出的是那条会话的真值
 *   RD-5 markdown：正文与代码块是占位符；行内代码含占位符（真值已查到且是文件路径）显示占位符、不成链接；普通路径照成
 *        链接；复制用的文本换回真值
 *   RD-6 浮出期间真值查到了：浮层就地换成真值
 *   RD-7 policy.changed：不重问，显示不变
 *   RD-8 没有占位符的文本原样，不发查询
 *   RD-10 查询入参严格是 {sessionId, placeholders}，没有 readers
 *   RD-11 服务端多带 disclosed：不理它，仍显示占位符
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
import {
  redactionInfo,
  resetRedactionCacheForTests,
  restoreForCopy
} from '../../../stores/redactionCache'
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

/** 每条会话的对照表 */
const tables: Record<string, Record<string, RedactionMarkInfo>> = {}
function resetTables(): void {
  tables.s1 = {
    [KEY]: { category: 'API_KEY', value: 'sk-real-0123456789' },
    [MAIL]: { category: 'EMAIL', value: 'alice@acme-corp.cn' },
    [SEALED]: { category: 'SECRET' },
    [USER]: { category: 'USERNAME', value: 'alice' }
  }
  tables.other = { [KEY]: { category: 'API_KEY', value: 'sk-other-session' } }
}
/** 每次查询的入参，原样 */
const calls: Array<Record<string, unknown>> = []
const eventListeners = new Set<(event: AppEvent) => void>()
/** 第一次查询先挂着，放行前浮层里是「正在查」 */
let gate: Promise<void> | null = null

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  setSessionChannelApi({
    redaction: {
      resolve: async (input: { sessionId: string; placeholders: string[] }) => {
        calls.push(structuredClone(input))
        if (gate) await gate
        const table = tables[input.sessionId] ?? {}
        return Object.fromEntries(
          input.placeholders.filter((p) => table[p]).map((p) => [p, table[p]!])
        )
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
  it('RD-1 显示占位符，指到浮出真值，离开收起，点一下钉住', async () => {
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

  it('RD-2 默认照发的 USERNAME：有真值也显示占位符，可浮出；没有 data-redaction-sent', async () => {
    await show(createElement(RedactedText, { text: `home /Users/${USER}/proj` }))
    expect(container.textContent).toBe(`home /Users/${USER}/proj`)
    expect(container.textContent).not.toContain('alice')
    const [user] = marks()
    expect(user!.hasAttribute('data-redaction-placeholder')).toBe(true)
    hover(user!)
    expect(popover()?.querySelector('[data-redaction-value]')?.textContent).toBe('alice')
    expect(document.querySelector('[data-redaction-sent]')).toBeNull()
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
    expect(calls).toStrictEqual([{ sessionId: 's1', placeholders: [SEALED, GONE] }])
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
    // 两处都显示占位符；各问各的会话，浮出的是各自对照表里的真值
    expect(container.textContent).toBe(`${KEY} / ${KEY}`)
    expect(calls).toStrictEqual([
      { sessionId: 's1', placeholders: [KEY] },
      { sessionId: 'other', placeholders: [KEY] }
    ])
    const [mine, theirs] = marks()
    hover(mine!)
    expect(popover()?.querySelector('[data-redaction-value]')?.textContent).toBe(
      'sk-real-0123456789'
    )
    hover(theirs!)
    expect(popover()?.querySelector('[data-redaction-value]')?.textContent).toBe('sk-other-session')
  })

  it('RD-5 markdown：占位符照样显示；带占位符的路径不成链接，普通路径照成链接；复制换回真值', async () => {
    const md = `Use ${KEY} here.\n\n\`\`\`bash\nexport OPENAI_API_KEY="${KEY}"\n\`\`\`\n\nOpen \`/Users/${USER}/proj/app.ts\` then \`/srv/${KEY}/x\` and \`/srv/plain/app.ts\``
    await show(createElement(MarkdownText, { text: md }))
    await settle()
    const text = container.textContent ?? ''
    expect(text).toContain(`Use ${KEY} here.`)
    expect(text).toContain(`export OPENAI_API_KEY="${KEY}"`)
    expect(text).not.toContain('sk-real')
    // 用户名的真值已经查到（换完是个文件路径），也还是占位符、不成链接
    expect(redactionInfo('s1', USER)).toMatchObject({ value: 'alice' })
    expect(text).toContain(`/Users/${USER}/proj/app.ts`)
    expect(text).not.toContain('/Users/alice')
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.some((b) => b.title.includes('/Users/'))).toBe(false)
    expect(buttons.some((b) => b.title.includes('/srv/{{'))).toBe(false)
    expect(text).toContain(`/srv/${KEY}/x`)
    // 没有占位符的路径照旧认成轻量链接（可见文本只有 basename，悬停是完整路径）
    const chip = buttons.find((b) => b.title.startsWith('/srv/plain/app.ts'))
    expect(chip?.textContent).toBe('app.ts')
    expect(chip?.className).toContain('text-accent')
    expect(chip?.className).not.toContain('rounded-full')
    expect(chip?.className).not.toContain('border')
    expect(chip?.className).not.toContain('bg-bg-secondary/70')
    // 复制得真值
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

  it('RD-7 policy.changed：不重问，显示不变', async () => {
    await show(createElement(RedactedText, { text: KEY }))
    expect(container.textContent).toBe(KEY)
    expect(calls).toHaveLength(1)
    tables.s1![KEY] = { category: 'API_KEY', value: 'sk-rotated' }
    act(() => {
      for (const listener of eventListeners) listener({ type: 'policy.changed' })
    })
    await settle()
    expect(container.textContent).toBe(KEY)
    expect(calls).toHaveLength(1)
    expect(redactionInfo('s1', KEY)).toMatchObject({ value: 'sk-real-0123456789' })
  })

  it('RD-8 没有占位符：原样，不发查询', async () => {
    await show(createElement(RedactedText, { text: 'plain {{x}} text' }))
    expect(container.textContent).toBe('plain {{x}} text')
    expect(calls).toEqual([])
  })

  it('RD-10 查询入参严格是 {sessionId, placeholders}，没有 readers', async () => {
    await show(createElement(RedactedText, { text: `${KEY} ${USER}` }))
    expect(calls).toStrictEqual([{ sessionId: 's1', placeholders: [KEY, USER] }])
    expect(calls[0]).not.toHaveProperty('readers')
  })

  it('RD-11 服务端多带 disclosed：不理它，仍显示占位符', async () => {
    tables.s1![USER] = {
      category: 'USERNAME',
      value: 'alice',
      disclosed: true,
      disclosedTo: { 'faux\u0000m': true }
    } as RedactionMarkInfo
    await show(createElement(RedactedText, { text: `home /Users/${USER}/proj` }))
    expect(container.textContent).toBe(`home /Users/${USER}/proj`)
    expect(marks()[0]!.hasAttribute('data-redaction-placeholder')).toBe(true)
    expect(container.querySelector('[data-redaction-sent]')).toBeNull()
    expect(redactionInfo('s1', USER)).toStrictEqual({ category: 'USERNAME', value: 'alice' })
  })
})
