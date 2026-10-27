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
 *   OB-06 采纳提议发出的（来源带 `suggestion`，2026-10-25）：「Accepted suggestion」标签（`data-origin-suggestion`，悬停是
 *         「AI 写的字」那句）—— 本机窗口发的也有（且没有来源标签、仍是强调色气泡）；远程连接发的标签与来源标签并排；
 *         不带引用（各种来源）→ 没有这个标签
 *   OB-07 标签的位置（2026-10-26，两种密度都一样）：来源标签与提议标签收在消息块**最上面**一行 `[data-user-meta]`
 *         （附图、气泡 `[data-user-bubble]` 之前），右对齐（行 justify-end，父列 items-end），提议在前、来源在后，
 *         两枚都不带 mr-1；只有非本机、认得出配色的来源或采纳的提议才有这一行（本机 / 没有 / 认不出 → 没有）；
 *         会话来源的标签是按钮、点它 openSession，触屏下点它不翻出气泡的操作（它不在气泡里）
 *         —— MA-U1 有没有这一行 / MA-U2 在哪 / MA-U3 次序 / MA-U4 会话按钮
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

describe('OB-06 采纳提议的标签', () => {
  const REF = { messageId: 'a1', toolCallId: 'call_0', index: 1 }
  const suggestionTag = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-origin-suggestion]')

  it('OB-06 本机窗口 + 引用：有「Accepted suggestion」标签、悬停说明；没有来源标签；气泡仍是强调色', () => {
    renderBubble({ kind: 'local', suggestion: REF })
    const el = suggestionTag()!
    expect(el).not.toBeNull()
    expect(el.textContent).toBe(en.message.originSuggestion)
    expect(el.getAttribute('title')).toBe(en.message.originSuggestionHint)
    expect(tags()).toHaveLength(0)
    expect(container.querySelector('.rounded-lg')!.className).toContain('bg-accent/10')
  })

  it('OB-06 远程连接 + 引用：来源标签与提议标签都在', () => {
    renderBubble({ ...REMOTE, suggestion: REF })
    expect(suggestionTag()).not.toBeNull()
    expect(tag().getAttribute('data-origin')).toBe('remote')
    expect(tag().textContent).toBe('Remote · 192.168.1.20')
  })

  it.each([
    ['没有来源', undefined],
    ['本机窗口', { kind: 'local' }],
    ['远程连接', REMOTE],
    ['父会话', { kind: 'parent-session', sessionId: 'P1' }],
    ['trigger', { kind: 'trigger', trigger: 'timer.fired', bot: 'daily' }]
  ] as const)('OB-06 %s、不带引用 → 没有提议标签', (_label, origin) => {
    renderBubble(origin)
    expect(suggestionTag()).toBeNull()
  })
})

describe('OB-07 标签在消息块的右上方（两种密度）', () => {
  const REF = { messageId: 'a1', toolCallId: 'call_0', index: 1 }
  const DENSITIES = ['compact', 'touch'] as const
  const KINDS: Array<[string, unknown]> = [
    ['remote', REMOTE],
    ['chrome', { kind: 'chrome', installId: 'inst-1' }],
    ['telegram', { kind: 'telegram', botId: 'b1', userId: 'u', chatId: 'c' }],
    ['session', { kind: 'session', sessionId: 'S1', title: 'Driver' }],
    ['parent-session', { kind: 'parent-session', sessionId: 'P1', title: 'Parent' }],
    ['trigger', TRIGGER]
  ]
  const metas = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>('[data-user-meta]')
  ]
  const meta = (): HTMLElement => {
    const all = metas()
    expect(all).toHaveLength(1)
    return all[0]!
  }
  const bubbleEl = (): HTMLElement => container.querySelector<HTMLElement>('[data-user-bubble]')!
  const actionsRow = (): HTMLElement => container.querySelector<HTMLElement>('[data-user-actions]')!
  /** 渲染一整条消息（可带附图）；宿主值缺省只带密度 */
  const renderMessage = (msg: UserTextMessage, host: Partial<ChatHostValue>): void => {
    act(() => {
      root.render(
        createElement(
          ChatHostContext.Provider,
          { value: host as ChatHostValue },
          createElement(UserBubble, { msg })
        )
      )
    })
  }
  /** 「有 meta 行时至少一个孩子」 —— 每条用例渲染之后都核一遍 */
  const metaNeverEmpty = (): void => {
    for (const el of metas()) expect(el.children.length).toBeGreaterThanOrEqual(1)
  }

  describe.each(DENSITIES)('%s', (density) => {
    it.each(KINDS)(
      'MA-U1 %s → 恰一行 meta，里面恰一枚 [data-origin=<种类>]，没有提议标签',
      (kind, origin) => {
        renderBubble(origin, { density })
        const row = meta()
        const chips = [...row.querySelectorAll<HTMLElement>('[data-origin]')]
        expect(chips).toHaveLength(1)
        expect(chips[0]!.getAttribute('data-origin')).toBe(kind)
        expect(row.querySelector('[data-origin-suggestion]')).toBeNull()
        // 整条消息里也只有这一枚（没留在气泡下面那行里）
        expect(tags()).toHaveLength(1)
        metaNeverEmpty()
      }
    )

    it.each([
      ['本机窗口', { kind: 'local' }],
      ['没有来源', undefined],
      ['认不出的种类', { kind: 'hook', sessionId: 'H' }]
    ] as const)('MA-U1 %s → 没有 meta 行、没有来源标签', (_label, origin) => {
      renderBubble(origin, { density })
      expect(metas()).toHaveLength(0)
      expect(tags()).toHaveLength(0)
      expect(bubbleEl()).not.toBeNull()
    })

    it('MA-U1 本机窗口 + 采纳的提议 → meta 行里只有提议标签', () => {
      renderBubble({ kind: 'local', suggestion: REF }, { density })
      const row = meta()
      expect(row.children).toHaveLength(1)
      expect(row.children[0]!.hasAttribute('data-origin-suggestion')).toBe(true)
      expect(row.querySelector('[data-origin]')).toBeNull()
      metaNeverEmpty()
    })

    it('MA-U2 remote：meta 在气泡之前、与气泡的外层同一个 items-end 父列，行 justify-end；气泡与操作行里没有标签', () => {
      renderBubble(REMOTE, { density })
      const row = meta()
      const bubble = bubbleEl()
      expect(row.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const wrapper = bubble.parentElement!
      expect(row.parentElement).toBe(wrapper.parentElement)
      expect(row.parentElement!.className).toContain('items-end')
      expect(row.className).toContain('justify-end')
      for (const scope of [bubble, actionsRow()]) {
        expect(scope.querySelector('[data-origin]')).toBeNull()
        expect(scope.querySelector('[data-origin-suggestion]')).toBeNull()
      }
    })

    it('MA-U2 remote + 一张附图：meta 也在图之前，是消息块的第一个子元素', () => {
      const msg: UserTextMessage = {
        ...message(REMOTE),
        metadata: {
          origin: REMOTE,
          images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }]
        }
      }
      renderMessage(msg, { density })
      const row = meta()
      const img = container.querySelector('img')!
      expect(img).not.toBeNull()
      expect(row.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(
        row.compareDocumentPosition(bubbleEl()) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(row.parentElement!.firstElementChild).toBe(row)
    })

    it('MA-U3 remote + 采纳的提议：提议在前、来源在后；两枚都不带 mr-1', () => {
      renderBubble({ ...REMOTE, suggestion: REF }, { density })
      const row = meta()
      expect(row.children).toHaveLength(2)
      const [first, second] = [...row.children] as HTMLElement[]
      expect(first!.hasAttribute('data-origin-suggestion')).toBe(true)
      expect(second!.getAttribute('data-origin')).toBe('remote')
      for (const chip of [first!, second!]) {
        expect(chip.className.split(/\s+/)).not.toContain('mr-1')
      }
      metaNeverEmpty()
    })

    it('MA-U4 宿主给了 openSession：meta 行里是一颗 session 按钮，点一下 → openSession(S1) 恰一次；触屏下不翻出操作', () => {
      const openSession = vi.fn()
      renderBubble({ kind: 'session', sessionId: 'S1', title: 'Driver' }, { openSession, density })
      const btn = meta().querySelector<HTMLButtonElement>(
        'button[type="button"][data-origin="session"]'
      )
      expect(btn).not.toBeNull()
      act(() => btn!.click())
      expect(openSession).toHaveBeenCalledTimes(1)
      expect(openSession).toHaveBeenCalledWith('S1')
      if (density === 'touch') {
        // 标签不在气泡里：点它不是点气泡
        expect(actionsRow().querySelector('button[title="Copy"]')).toBeNull()
      } else {
        expect(actionsRow().querySelector('button[title="Copy"]')).not.toBeNull()
      }
    })
  })
})
