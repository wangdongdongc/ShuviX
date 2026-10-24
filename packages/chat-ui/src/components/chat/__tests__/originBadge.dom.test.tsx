// @vitest-environment jsdom
/**
 * 用户气泡下方的来源标签（UserBubble → OriginBadge；jsdom）。来源是宿主按连接盖的章（`metadata.origin`，
 * chat-protocol `inputOrigin.ts`，2026-10-21）：
 *
 *   OB-01 没有宿主（ChatHostContext 为空）：本机窗口 / 没有来源 / 认不出的种类 → 没有标签（认不出的不抛）；
 *         remote →「Remote · <地址>」，悬停是带连接 id 的说明、有 UA 时换行接 UA（没有 UA 不换行），地址是空串
 *         →「Remote」；chrome / telegram → 纯文字标签，telegram 的悬停带 Telegram 用户；session / parent-session
 *         → `<span>`（不是按钮），悬停带标题，session 没有标题时带会话 id；`data-origin` = 种类
 *   OB-02 宿主给了 `openSession`：session / parent-session 是 `<button type=button>`，点一下 `openSession(sessionId)`
 *         恰一次，悬停末尾换行接「Click to open it」；remote / chrome / telegram 仍是 span、点了不切会话；
 *         宿主值里没有 openSession → span
 *   OB-03 配色：不是本机打的气泡换成来源的浅底（分类色槽位 `--viz-N-tint`，remote 3 / chrome 4 / telegram 2 /
 *         parent-session 7 / session 5），标签同一个浅底 + 同色深字（`--viz-N-ink`）；本机 / 没有来源 / 认不出的种类
 *         → 照旧是强调色的气泡（`bg-accent/10`），没有内联底色
 *   OB-04 trigger（触发器替 bot 发的，2026-10-24）：`<span data-origin="trigger">`，文字 = 「Trigger」，悬停带 bot 名与
 *         埋点 id；宿主给了 openSession 也不是按钮、点了不切会话
 *   OB-05 trigger 的配色 = parent-session 的槽位（viz-7 浅底 + 同色深字）：`originTone` 与气泡、标签一致
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（getHostApi → null）；i18n 走真 en 资源。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { UserTextMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { UserBubble } from '../UserBubble'
import { originTone } from '../OriginBadge'

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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const REMOTE: InputOrigin = {
  kind: 'remote',
  clientId: 'ws:4',
  address: '192.168.1.20',
  userAgent: 'Mozilla/5.0 UA'
}

function message(origin?: unknown): UserTextMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    content: 'hello',
    model: '',
    createdAt: 1,
    role: 'user',
    type: 'text',
    metadata: origin === undefined ? null : { origin: origin as InputOrigin }
  }
}

/** 渲染一条用户气泡；`host` 给了就包一层 ChatHostContext */
function renderBubble(origin?: unknown, host?: Partial<ChatHostValue>): void {
  const bubble = createElement(UserBubble, { msg: message(origin) })
  act(() => {
    root.render(
      host === undefined
        ? bubble
        : createElement(ChatHostContext.Provider, { value: host as ChatHostValue }, bubble)
    )
  })
}

const tags = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-origin]')]
const tag = (): HTMLElement => {
  const all = tags()
  expect(all).toHaveLength(1)
  return all[0]!
}

describe('OB-01 来源标签（没有宿主）', () => {
  it.each([
    ['本机窗口', { kind: 'local' }],
    ['没有来源', undefined],
    ['认不出的种类', { kind: 'hook', sessionId: 'H' }]
  ] as const)('OB-01 %s → 没有标签，气泡照常渲染', (_label, origin) => {
    expect(() => renderBubble(origin)).not.toThrow()
    expect(container.textContent).toContain('hello')
    expect(tags()).toHaveLength(0)
  })

  it('OB-01 remote：「Remote · 地址」，悬停 = 带连接 id 的说明 + 换行 + UA', () => {
    renderBubble(REMOTE)
    const el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(el.getAttribute('data-origin')).toBe('remote')
    expect(el.textContent).toBe('Remote · 192.168.1.20')
    const hint = i18n.t('message.originRemoteHint', {
      address: '192.168.1.20',
      clientId: 'ws:4'
    })
    expect(hint).toContain('ws:4')
    expect(el.getAttribute('title')).toBe(`${hint}\nMozilla/5.0 UA`)
  })

  it('OB-01 remote 的地址是空串 →「Remote」；没有 UA → 悬停不换行', () => {
    renderBubble({ kind: 'remote', clientId: 'ws:9', address: '' })
    const el = tag()
    expect(el.textContent).toBe(en.message.originRemoteNoAddress)
    expect(el.textContent).toBe('Remote')
    expect(el.getAttribute('title')).toContain('ws:9')
    expect(el.getAttribute('title')).not.toContain('\n')

    renderBubble({ kind: 'remote', clientId: 'ws:4', address: '10.0.0.7' })
    expect(tag().textContent).toBe('Remote · 10.0.0.7')
    expect(tag().getAttribute('title')).toBe(
      i18n.t('message.originRemoteHint', { address: '10.0.0.7', clientId: 'ws:4' })
    )
    expect(tag().getAttribute('title')).not.toContain('\n')
  })

  it('OB-01 chrome / telegram：纯文字标签；telegram 的悬停带 Telegram 用户', () => {
    renderBubble({ kind: 'chrome', installId: 'inst-1' })
    let el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(el.getAttribute('data-origin')).toBe('chrome')
    expect(el.textContent).toBe(en.message.originChrome)
    expect(el.getAttribute('title')).toBe(en.message.originChromeHint)

    renderBubble({ kind: 'telegram', botId: 'b1', userId: 'tg-777', chatId: 'c1' })
    el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(el.getAttribute('data-origin')).toBe('telegram')
    expect(el.textContent).toBe(en.message.originTelegram)
    expect(el.getAttribute('title')).toContain('tg-777')
  })

  it.each([
    [
      'session（带标题）',
      { kind: 'session', sessionId: 'S1', title: 'Driver-Title' },
      en.message.originSession,
      'Driver-Title'
    ],
    ['session（没有标题）', { kind: 'session', sessionId: 'S1' }, en.message.originSession, 'S1'],
    [
      'parent-session（带标题）',
      { kind: 'parent-session', sessionId: 'P1', title: 'Planner' },
      en.message.originParent,
      'Planner'
    ]
  ] as const)(
    'OB-01 %s：<span>（不是按钮），标签对，悬停带标题（session 没有标题时带会话 id）',
    (_label, origin, label, inHint) => {
      renderBubble(origin)
      const el = tag()
      expect(el.tagName).toBe('SPAN')
      expect(el.getAttribute('data-origin')).toBe(origin.kind)
      expect(el.textContent).toBe(label)
      expect(el.getAttribute('title')).toContain(inHint)
      expect(el.getAttribute('title')).not.toContain(en.message.originOpenHint)
      expect(container.querySelector('button[data-origin]')).toBeNull()
    }
  )

  it('OB-01 parent-session 没有标题：用不带标题的那句悬停说明', () => {
    renderBubble({ kind: 'parent-session', sessionId: 'P1' })
    const el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(el.textContent).toBe(en.message.originParent)
    expect(el.getAttribute('title')).toBe(en.message.originParentHintNoTitle)
  })
})

describe('OB-02 宿主能切会话（ChatHostContext 给了 openSession）', () => {
  it.each([
    ['session', { kind: 'session', sessionId: 'S1', title: 'Driver-Title' }, 'S1'],
    ['parent-session', { kind: 'parent-session', sessionId: 'P1' }, 'P1']
  ] as const)(
    'OB-02 %s → <button type=button>，点一下 openSession(sessionId) 恰一次；悬停末尾换行接「Click to open it」',
    (_label, origin, sessionId) => {
      const openSession = vi.fn()
      renderBubble(origin, { openSession })
      const el = tag()
      expect(el.tagName).toBe('BUTTON')
      expect(el.getAttribute('type')).toBe('button')
      expect(el.getAttribute('data-origin')).toBe(origin.kind)
      expect(el.getAttribute('title')!.endsWith(`\n${en.message.originOpenHint}`)).toBe(true)
      expect(en.message.originOpenHint).toBe('Click to open it')
      act(() => el.click())
      expect(openSession.mock.calls).toEqual([[sessionId]])
    }
  )

  it.each([
    ['remote', REMOTE],
    ['chrome', { kind: 'chrome' }],
    ['telegram', { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' }]
  ] as const)('OB-02 %s 仍是 span，点了不切会话', (_label, origin) => {
    const openSession = vi.fn()
    renderBubble(origin, { openSession })
    const el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(el.getAttribute('title') ?? '').not.toContain(en.message.originOpenHint)
    act(() => el.click())
    expect(openSession).not.toHaveBeenCalled()
  })

  it('OB-02 宿主值里没有 openSession → session 来源仍是 span', () => {
    renderBubble({ kind: 'session', sessionId: 'S1' }, { appearance: undefined as never })
    const el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(el.getAttribute('title')).not.toContain(en.message.originOpenHint)
  })
})

describe('OB-03 气泡与标签按来源配色', () => {
  const bubble = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.rounded-lg')
    expect(el).not.toBeNull()
    return el!
  }

  it.each([
    ['remote', REMOTE, 3],
    ['chrome', { kind: 'chrome', installId: 'i' }, 4],
    ['telegram', { kind: 'telegram', botId: 'b', userId: 'u', chatId: 'c' }, 2],
    ['parent-session', { kind: 'parent-session', sessionId: 'P1', title: 'Parent' }, 7],
    ['session', { kind: 'session', sessionId: 'S1' }, 5]
  ] as const)('OB-03 %s → 气泡与标签都是 --viz-%s 的浅底，标签是同色深字', (kind, origin, slot) => {
    renderBubble(origin)
    const el = bubble()
    expect(el.getAttribute('data-origin-tone')).toBe(kind)
    expect(el.className).not.toContain('bg-accent/10')
    expect(el.style.backgroundColor).toBe(`var(--viz-${slot}-tint)`)
    const chip = tag()
    expect(chip.style.backgroundColor).toBe(`var(--viz-${slot}-tint)`)
    expect(chip.style.color).toBe(`var(--viz-${slot}-ink)`)
  })

  it('OB-03 有宿主时 session 的按钮同样配色', () => {
    renderBubble({ kind: 'session', sessionId: 'S1' }, { openSession: vi.fn() })
    const chip = tag()
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.style.backgroundColor).toBe('var(--viz-5-tint)')
    expect(chip.style.color).toBe('var(--viz-5-ink)')
  })

  it.each([
    ['本机窗口', { kind: 'local' }],
    ['没有来源', undefined],
    ['认不出的种类', { kind: 'hook', sessionId: 'H' }]
  ] as const)('OB-03 %s → 强调色的气泡，没有内联底色、没有配色标记', (_label, origin) => {
    renderBubble(origin)
    const el = bubble()
    expect(el.className).toContain('bg-accent/10')
    expect(el.getAttribute('style')).toBeNull()
    expect(el.hasAttribute('data-origin-tone')).toBe(false)
  })
})

const TRIGGER: InputOrigin = {
  kind: 'trigger',
  trigger: 'timer.fired',
  sourceId: 'timer:builtin:minute',
  bot: 'ticker'
}

describe('OB-04 trigger 来源标签', () => {
  it('OB-04 没有宿主：<span data-origin="trigger">，文字「Trigger」，悬停带 bot 名与埋点 id', () => {
    renderBubble(TRIGGER)
    const el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(el.getAttribute('data-origin')).toBe('trigger')
    expect(el.textContent).toBe(en.message.originTrigger)
    expect(el.textContent).toBe(i18n.t('message.originTrigger'))
    const title = el.getAttribute('title')!
    expect(title).toBe(
      i18n.t('message.originTriggerHint', { bot: 'ticker', trigger: 'timer.fired' })
    )
    expect(title).toContain('ticker')
    expect(title).toContain('timer.fired')
    expect(title).not.toContain(en.message.originOpenHint)
  })

  it('OB-04 宿主给了 openSession：仍是 span（不是按钮），点了不切会话', () => {
    const openSession = vi.fn()
    renderBubble(TRIGGER, { openSession })
    const el = tag()
    expect(el.tagName).toBe('SPAN')
    expect(container.querySelector('button[data-origin]')).toBeNull()
    expect(el.getAttribute('title')).not.toContain(en.message.originOpenHint)
    act(() => el.click())
    expect(openSession).not.toHaveBeenCalled()
  })

  it('OB-04 没有 sourceId 的 trigger 照样出标签', () => {
    renderBubble({ kind: 'trigger', trigger: 'timer.fired', bot: 'daily' })
    const el = tag()
    expect(el.getAttribute('data-origin')).toBe('trigger')
    expect(el.getAttribute('title')).toContain('daily')
  })
})

describe('OB-05 trigger 的配色', () => {
  it('OB-05 originTone(trigger) = parent-session 的 viz-7 浅底 / 深字', () => {
    const tone = originTone(TRIGGER)
    expect(tone).toEqual({ tint: 'var(--viz-7-tint)', ink: 'var(--viz-7-ink)' })
    expect(tone).toEqual(originTone({ kind: 'parent-session', sessionId: 'P1' }))
  })

  it('OB-05 气泡与标签都用 viz-7', () => {
    renderBubble(TRIGGER)
    const el = container.querySelector<HTMLElement>('.rounded-lg')!
    expect(el.getAttribute('data-origin-tone')).toBe('trigger')
    expect(el.className).not.toContain('bg-accent/10')
    expect(el.style.backgroundColor).toBe('var(--viz-7-tint)')
    const chip = tag()
    expect(chip.style.backgroundColor).toBe('var(--viz-7-tint)')
    expect(chip.style.color).toBe('var(--viz-7-ink)')
  })
})
