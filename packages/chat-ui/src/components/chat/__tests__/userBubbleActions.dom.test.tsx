// @vitest-environment jsdom
/**
 * 用户气泡下方的操作行（UserBubble 的 `[data-user-actions]`：复制 / 回退 + 长消息的展开键；jsdom），两种控件密度
 * （ChatHost `density`：缺省 compact = 桌面，touch = 手机布局的 web 客户端）：
 *
 *   MA-U5  compact（没有宿主 / density compact / 宿主没给 density）：复制与回退一上来就在，悬浮才显形
 *          （opacity-0 + group-hover:opacity-100，p-0.5），aria-label = title，图标 12；点气泡什么都不变
 *   MA-U6  touch：一上来没有；点一下气泡 → 两颗都出（h-8 w-8 方钮、没有 opacity-0 / group-hover，图标 15）；
 *          再点 → 收；第三下 → 又出
 *   MA-U7  两种密度：复制的是原文（paste token 展开成粘贴内容、脱敏占位符换回真值），copyToClipboard 恰一次；
 *          点完复制两颗都还在（复制那颗换成勾）；回退 → onRollback 恰一次，行还在
 *   MA-U8  touch：没给 onRollback → 翻出来只有复制；没有正文只有附图 + onRollback → 只有回退
 *   MA-U9  touch：每条气泡各管各的 —— 点第一条只翻出第一条的
 *   MA-U10 两种密度：20 行的长消息，展开键一上来就在操作行里（touch 也不用先点气泡）；点它 → 「Collapse」，
 *          touch 下复制仍不出；再点气泡 → 复制出在同一个操作行里
 *   MA-U11 touch：点脱敏占位符（RedactedMark 自己 stopPropagation）不翻出操作；点旁边的文字才翻出
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（getHostApi → null）；剪贴板顶成 spy；脱敏查询走注入的 SessionChannelApi
 * （只有 MA-U7 让当前会话非空、真的去问）；i18n 走真 en 资源。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { UserTextMessage } from '@shuvix/chat-protocol/types/chatMessage'

const clip = vi.hoisted(() => ({ copyToClipboard: vi.fn() }))

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('../../../utils/clipboard', () => ({ copyToClipboard: clip.copyToClipboard }))

import { setSessionChannelApi } from '../../../api/chatApi'
import { useChatStore } from '../../../stores/chatStore'
import { resetRedactionCacheForTests } from '../../../stores/redactionCache'
import { hideRedaction } from '../redactionPopover'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { UserBubble } from '../UserBubble'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MAIL = '{{EMAIL_abcdefgh}}'
const MAIL_VALUE = 'alice@example.com'

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
  setSessionChannelApi({
    redaction: {
      resolve: async ({ placeholders }: { sessionId: string; placeholders: string[] }) =>
        Object.fromEntries(
          placeholders
            .filter((p) => p === MAIL)
            .map((p) => [p, { category: 'EMAIL', value: MAIL_VALUE, disclosed: false }])
        )
    },
    events: { subscribe: () => () => {} }
  } as unknown as SessionChannelApi)
})

beforeEach(() => {
  resetRedactionCacheForTests()
  useChatStore.setState({ activeSessionId: null })
  clip.copyToClipboard.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  hideRedaction()
  container.remove()
  document.body.innerHTML = ''
})

function message(over: Partial<UserTextMessage> = {}): UserTextMessage {
  return {
    id: 'u1',
    sessionId: 's1',
    content: 'hello',
    model: '',
    createdAt: 1,
    role: 'user',
    type: 'text',
    metadata: null,
    ...over
  }
}

type Host = 'none' | 'compact' | 'no-density' | 'touch'
const COMPACT_HOSTS: Host[] = ['none', 'compact', 'no-density']

/** 按宿主包一层：none = 没有 Provider；no-density = Provider 但不带 density */
function wrap(host: Host, el: ReactElement): ReactElement {
  if (host === 'none') return el
  const value = (host === 'no-density' ? {} : { density: host }) as ChatHostValue
  return createElement(ChatHostContext.Provider, { value }, el)
}

function show(host: Host, ...bubbles: ReactElement[]): void {
  act(() => {
    root.render(wrap(host, createElement('div', null, ...bubbles)))
  })
}

function bubble(
  props: { msg?: UserTextMessage; onRollback?: () => void } = {},
  key?: string
): ReactElement {
  return createElement(UserBubble, {
    key,
    msg: props.msg ?? message(),
    ...(props.onRollback ? { onRollback: props.onRollback } : {})
  })
}

const scopeOf = (index = 0): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[data-user-actions]')][index]!.parentElement!
const actionsOf = (index = 0): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[data-user-actions]')][index]!
const bubbleOf = (index = 0): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[data-user-bubble]')][index]!
const copyIn = (scope: ParentNode = container): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>(`button[aria-label="${en.message.copy}"]`)
const rollbackIn = (scope: ParentNode = container): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>(`button[aria-label="${en.message.rollback}"]`)
const click = (el: Element): void => {
  act(() => {
    ;(el as HTMLElement).click()
  })
}
const classesOf = (el: Element): string[] => el.getAttribute('class')!.split(/\s+/)
const isHoverOnly = (el: Element): boolean => {
  const cls = classesOf(el)
  return cls.includes('opacity-0') && cls.includes('group-hover:opacity-100')
}
const svgWidth = (el: Element): string | null =>
  el.querySelector('svg')?.getAttribute('width') ?? null

describe('MA-U5 compact：常驻、悬浮才显形', () => {
  it.each(COMPACT_HOSTS)(
    'MA-U5 %s：两颗一上来就在，hover-only + p-0.5，aria-label = title，图标 12',
    (host) => {
      const onRollback = vi.fn()
      show(host, bubble({ onRollback }))
      const copy = copyIn()
      const rollback = rollbackIn()
      expect(copy).not.toBeNull()
      expect(rollback).not.toBeNull()
      for (const [btn, label] of [
        [copy!, en.message.copy],
        [rollback!, en.message.rollback]
      ] as const) {
        expect(isHoverOnly(btn), btn.className).toBe(true)
        expect(classesOf(btn)).toContain('p-0.5')
        expect(classesOf(btn)).not.toContain('h-8')
        expect(btn.getAttribute('aria-label')).toBe(label)
        expect(btn.title).toBe(label)
        expect(svgWidth(btn)).toBe('12')
        expect(actionsOf().contains(btn)).toBe(true)
      }

      // 点气泡什么都不变：两颗还是那两颗，没有多出、没有收起
      const before = actionsOf().innerHTML
      click(bubbleOf())
      expect(actionsOf().innerHTML).toBe(before)
      click(bubbleOf())
      expect(actionsOf().innerHTML).toBe(before)
      expect(onRollback).not.toHaveBeenCalled()
    }
  )
})

describe('MA-U6 touch：点气泡翻出、再点收起', () => {
  it('MA-U6 一上来没有；点 → 两颗 h-8 w-8、不是 hover-only、图标 15；再点 → 收；第三下 → 又出', () => {
    show('touch', bubble({ onRollback: vi.fn() }))
    expect(copyIn()).toBeNull()
    expect(rollbackIn()).toBeNull()

    click(bubbleOf())
    const copy = copyIn()
    const rollback = rollbackIn()
    expect(copy).not.toBeNull()
    expect(rollback).not.toBeNull()
    for (const btn of [copy!, rollback!]) {
      const cls = classesOf(btn)
      expect(cls).toContain('h-8')
      expect(cls).toContain('w-8')
      expect(cls).not.toContain('opacity-0')
      expect(cls.some((c) => c.startsWith('group-hover'))).toBe(false)
      expect(svgWidth(btn)).toBe('15')
      expect(btn.getAttribute('aria-label')).toBe(btn.title)
    }

    click(bubbleOf())
    expect(copyIn()).toBeNull()
    expect(rollbackIn()).toBeNull()

    click(bubbleOf())
    expect(copyIn()).not.toBeNull()
    expect(rollbackIn()).not.toBeNull()
  })
})

describe('MA-U7 复制原文、回退', () => {
  const PASTE_MSG = message({
    content: 'see {{shuvixInlineToken:p1}} now',
    metadata: {
      inlineTokens: {
        p1: { type: 'paste', id: 'p', displayText: '[Pasted]', payload: 'a\nb' }
      }
    }
  })

  it.each<Host>(['compact', 'touch'])(
    'MA-U7 %s：复制 = paste 展开后的原文，恰一次；点完两颗都还在（复制换成勾）；回退恰一次、行还在',
    (host) => {
      const onRollback = vi.fn()
      show(host, bubble({ msg: PASTE_MSG, onRollback }))
      // 显示的是胶囊，不是粘贴原文
      expect(bubbleOf().textContent).not.toContain('a\nb')
      if (host === 'touch') click(bubbleOf())

      click(copyIn()!)
      expect(clip.copyToClipboard).toHaveBeenCalledTimes(1)
      expect(clip.copyToClipboard).toHaveBeenCalledWith('see a\nb now')
      expect(copyIn()).not.toBeNull()
      expect(copyIn()!.querySelector('.lucide-check')).not.toBeNull()
      expect(rollbackIn()).not.toBeNull()

      click(rollbackIn()!)
      expect(onRollback).toHaveBeenCalledTimes(1)
      expect(copyIn()).not.toBeNull()
      expect(rollbackIn()).not.toBeNull()
    }
  )

  it.each<Host>(['compact', 'touch'])(
    'MA-U7 %s：脱敏占位符换回真值（当前会话问得到）、token 照样展开',
    async (host) => {
      useChatStore.setState({ activeSessionId: 's1' })
      const msg = message({
        content: `mail ${MAIL} and {{shuvixInlineToken:p1}}`,
        metadata: {
          inlineTokens: {
            p1: { type: 'paste', id: 'p', displayText: '[Pasted]', payload: 'a\nb' }
          }
        }
      })
      show(host, bubble({ msg }))
      // 让攒着的查询跑完、记进缓存
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      // 界面上仍是模型收到的样子（占位符）
      expect(container.querySelector('[data-redaction-placeholder]')?.textContent).toBe(MAIL)
      if (host === 'touch') click(bubbleOf())
      click(copyIn()!)
      expect(clip.copyToClipboard).toHaveBeenCalledTimes(1)
      expect(clip.copyToClipboard).toHaveBeenCalledWith(`mail ${MAIL_VALUE} and a\nb`)
    }
  )
})

describe('MA-U8 touch：只翻出有的那几颗', () => {
  it('MA-U8 没给 onRollback → 只有复制', () => {
    show('touch', bubble())
    click(bubbleOf())
    expect(copyIn()).not.toBeNull()
    expect(rollbackIn()).toBeNull()
    expect(actionsOf().querySelectorAll('button')).toHaveLength(1)
  })

  it('MA-U8 没有正文、一张附图 + onRollback → 只有回退', () => {
    const msg = message({
      content: '',
      metadata: { images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] }
    })
    show('touch', bubble({ msg, onRollback: vi.fn() }))
    expect(container.querySelector('img')).not.toBeNull()
    click(bubbleOf())
    expect(copyIn()).toBeNull()
    expect(rollbackIn()).not.toBeNull()
    expect(actionsOf().querySelectorAll('button')).toHaveLength(1)
  })
})

describe('MA-U9 touch：每条气泡各管各的', () => {
  it('MA-U9 两条气泡，点第一条 → 只有第一条翻出复制', () => {
    show(
      'touch',
      bubble({ msg: message({ id: 'u1', content: 'first' }), onRollback: vi.fn() }, 'u1'),
      bubble({ msg: message({ id: 'u2', content: 'second' }), onRollback: vi.fn() }, 'u2')
    )
    click(bubbleOf(0))
    expect(copyIn(scopeOf(0))).not.toBeNull()
    expect(copyIn(scopeOf(1))).toBeNull()
    expect(rollbackIn(scopeOf(1))).toBeNull()
    expect(container.querySelectorAll(`button[aria-label="${en.message.copy}"]`)).toHaveLength(1)
  })
})

describe('MA-U10 长消息的展开键', () => {
  const LONG = message({
    content: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
  })
  const expandLabel = i18n.t.bind(i18n)
  const findButton = (text: string): HTMLButtonElement | null =>
    [...actionsOf().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.textContent ?? '').trim() === text
    ) ?? null

  it.each<Host>(['compact', 'touch'])(
    'MA-U10 %s：展开键一上来就在操作行里；点 → Collapse（touch 下复制仍不出）；点气泡 → 复制出在同一行',
    (host) => {
      show(host, bubble({ msg: LONG, onRollback: vi.fn() }))
      const expandText = expandLabel('message.expandLines', { lines: 20 })
      expect(expandText).toBe('Show all 20 lines')
      const expand = findButton(expandText)
      expect(expand).not.toBeNull()
      if (host === 'touch') expect(copyIn()).toBeNull()

      click(expand!)
      expect(findButton(en.message.collapseLines)).not.toBeNull()
      expect(findButton(expandText)).toBeNull()
      if (host === 'touch') expect(copyIn()).toBeNull()

      if (host === 'touch') click(bubbleOf())
      const copy = copyIn()
      expect(copy).not.toBeNull()
      expect(copy!.parentElement).toBe(actionsOf())
      expect(findButton(en.message.collapseLines)!.parentElement).toBe(actionsOf())
    }
  )
})

describe('MA-U11 touch：脱敏占位符的点击不算点气泡', () => {
  it('MA-U11 没有当前会话：点占位符 → 不翻出；点旁边的文字 → 翻出', () => {
    show('touch', bubble({ msg: message({ content: `mail ${MAIL} here` }) }))
    const mark = container.querySelector<HTMLElement>('[data-redaction-placeholder]')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe(MAIL)

    click(mark!)
    expect(copyIn()).toBeNull()

    // 那段文字所在的 span（占位符的父节点，仍在气泡里）
    const text = mark!.parentElement!
    expect(text.tagName).toBe('SPAN')
    expect(bubbleOf().contains(text)).toBe(true)
    click(text)
    expect(copyIn()).not.toBeNull()
  })
})
