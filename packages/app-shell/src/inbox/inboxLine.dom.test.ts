// @vitest-environment jsdom
/**
 * 父会话行尾的子会话圆点（FamilyPips，jsdom）—— 在跑的两种（S1）：
 *
 *   INL-1 次序：等你回答 → 新回复 → 运行中（agent 在干活的写 running、只剩后台命令的写 resident）；
 *         各自的样子：琥珀实心、蓝色实心、蓝色空心呼吸、绿色空心不动
 *   INL-2 给了 onToggle 是一个按钮（aria-expanded 跟 open，点一下调一次）；不给是一枚带读屏文字的图形
 *   INH-20 留着的那条子会话（`held`）的圆点是 read（灰色实心）；真的新回复仍是 unread（蓝色）
 *
 * 一行（InboxLine，2026-11-12 起在右侧面板里，两层）：
 *
 *   INH-17 点开的按钮：有预览两层（第二层是预览），没有预览（null / undefined / false / ''）只有一层；第一层是标题 + 时间
 *   INH-18 selected → 外层 aria-current="true" + data-selected=""，否则两样都没有；attrs 写在外层；
 *          点按钮 onOpen 一次，点行尾自带的按钮不触发 onOpen
 *   IL-B1…4 `below`（任务列表那一块）：不给 / null 不多出外壳；给了在按钮之后、不在按钮里；点它 onOpen 一次；不多一个 Tab 停靠点
 *
 * InboxLine 只从 inboxItems 引类型，不用替身。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Session, SessionRunKind } from '@shuvix/chat-ui'
import type { InboxFamily, InboxItem } from './inboxItems'
import { FamilyPips, InboxLine, type InboxLineProps } from './InboxLine'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function session(id: string, parentId: string | null = 'R'): Session {
  return {
    id,
    title: id,
    projectId: null,
    parentId,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  }
}
const item = (id: string, run: SessionRunKind | null, asks = 0): InboxItem => ({
  session: session(id),
  asks,
  run,
  commands: []
})

function family(): InboxFamily {
  return {
    root: session('R', null),
    rootItem: null,
    rootUnread: null,
    waiting: [item('W', null, 1)],
    unread: [{ session: session('U'), unread: { since: 1, failed: false, manual: false } }],
    running: [item('A', 'agent'), item('B', 'resident')]
  }
}

function render(props: { open?: boolean; onToggle?: () => void }): void {
  act(() =>
    root.render(
      createElement(FamilyPips, {
        family: family(),
        open: props.open ?? false,
        label: '4 sub-sessions',
        onToggle: props.onToggle
      })
    )
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('INL-1 pip order and look', () => {
  it('INL-1 waiting, unread, running, resident — each in its own style', () => {
    render({})
    const pips = [...container.querySelectorAll<HTMLElement>('[data-pip]')]
    expect(pips.map((p) => p.getAttribute('data-pip'))).toEqual([
      'waiting',
      'unread',
      'running',
      'resident'
    ])
    const [waiting, unread, running, resident] = pips
    expect(waiting.classList.contains('bg-amber-400')).toBe(true)
    expect(unread.classList.contains('bg-accent')).toBe(true)
    for (const cls of ['border-accent', 'animate-pulse', 'motion-reduce:animate-none']) {
      expect(running.classList.contains(cls), cls).toBe(true)
    }
    expect(resident.classList.contains('border-success')).toBe(true)
    expect(resident.classList.contains('animate-pulse')).toBe(false)
    expect(resident.classList.contains('border-accent')).toBe(false)
  })
})

describe('INL-2 toggle or picture', () => {
  it.each([true, false])('INL-2 with onToggle (open %s): a button that toggles once', (open) => {
    const onToggle = vi.fn()
    render({ open, onToggle })
    const button = container.querySelector<HTMLButtonElement>('button[data-inbox-family-toggle]')
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-expanded')).toBe(String(open))
    act(() => button!.click())
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('INL-2 without onToggle: a labelled picture, no button', () => {
    render({})
    expect(container.querySelector('button')).toBeNull()
    const img = container.querySelector<HTMLElement>('span[role="img"]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('aria-label')).toBe('4 sub-sessions')
  })
})

describe('INH-20 a held child pip', () => {
  it('INH-20 held child → read (grey); a live unread child → unread (accent)', () => {
    const fam: InboxFamily = {
      root: session('R', null),
      rootItem: null,
      rootUnread: null,
      waiting: [],
      unread: [
        { session: session('K'), unread: { since: 2, failed: false, manual: false }, held: true },
        { session: session('L'), unread: { since: 1, failed: false, manual: false } }
      ],
      running: []
    }
    act(() =>
      root.render(createElement(FamilyPips, { family: fam, open: false, label: '2 sub-sessions' }))
    )
    const pips = [...container.querySelectorAll<HTMLElement>('[data-pip]')]
    expect(pips.map((p) => p.getAttribute('data-pip'))).toEqual(['read', 'unread'])
    expect(pips[0].classList.contains('bg-text-tertiary/50')).toBe(true)
    expect(pips[0].classList.contains('bg-accent')).toBe(false)
    expect(pips[1].classList.contains('bg-accent')).toBe(true)
    expect(pips[1].classList.contains('bg-text-tertiary/50')).toBe(false)
  })
})

describe('InboxLine', () => {
  function line(props: Partial<InboxLineProps> = {}): void {
    act(() =>
      root.render(
        createElement(InboxLine, {
          leading: createElement('span', { 'data-lead': '' }),
          title: 'T',
          meta: '12:00',
          onOpen: () => {},
          ...props
        })
      )
    )
  }
  const outer = (): HTMLElement => container.firstElementChild as HTMLElement
  const openButton = (): HTMLButtonElement => {
    const el = container.querySelector<HTMLButtonElement>('button')
    if (!el) throw new Error('no open button')
    return el
  }

  it.each<[string, React.ReactNode, string | null]>([
    ['a string', 'P', 'P'],
    ['an element', createElement('em', null, 'E'), 'E'],
    ['null', null, null],
    ['undefined', undefined, null],
    ['false', false, null],
    ["''", '', null]
  ])('INH-17 preview %s', (_label, preview, text) => {
    line({ preview })
    const children = [...openButton().children]
    expect(children).toHaveLength(text === null ? 1 : 2)
    expect(children[0].textContent).toContain('T')
    expect(children[0].textContent).toContain('12:00')
    if (text !== null) expect(children[1].textContent).toBe(text)
  })

  it.each<[string, boolean | undefined]>([
    ['false', false],
    ['omitted', undefined]
  ])('INH-18 selected %s → neither aria-current nor data-selected', (_label, selected) => {
    line(selected === undefined ? {} : { selected })
    expect(outer().hasAttribute('aria-current')).toBe(false)
    expect(outer().hasAttribute('data-selected')).toBe(false)
  })

  it('INH-18 selected → aria-current="true" and data-selected=""; attrs on the outer div; open vs trailing clicks', () => {
    const onOpen = vi.fn()
    const onTrailing = vi.fn()
    line({
      selected: true,
      attrs: { 'data-x': 'y', 'data-gone': undefined },
      onOpen,
      trailing: createElement('button', { type: 'button', 'data-trail': '', onClick: onTrailing })
    })
    const el = outer()
    expect(el.tagName).toBe('DIV')
    expect(el.getAttribute('aria-current')).toBe('true')
    expect(el.getAttribute('data-selected')).toBe('')
    expect(el.getAttribute('data-x')).toBe('y')
    expect(el.hasAttribute('data-gone')).toBe(false)

    act(() => openButton().click())
    expect(onOpen).toHaveBeenCalledTimes(1)

    act(() => container.querySelector<HTMLButtonElement>('[data-trail]')!.click())
    expect(onTrailing).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('InboxLine below（IL-B）', () => {
  function line(props: Partial<InboxLineProps> = {}): void {
    act(() =>
      root.render(
        createElement(InboxLine, {
          leading: createElement('span', { 'data-lead': '' }),
          title: 'T',
          meta: '12:00',
          onOpen: () => {},
          ...props
        })
      )
    )
  }
  const openButton = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button')!
  const belowContent = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-below-content]')
  const content = (): React.ReactNode =>
    createElement('ol', { 'data-below-content': '' }, createElement('li', null, 'step'))

  it.each<[string, React.ReactNode]>([
    ['omitted', undefined],
    ['null', null]
  ])('IL-B1 below %s → the open button is alone in its column', (_label, below) => {
    line(below === undefined ? {} : { below })
    const column = openButton().parentElement!
    expect([...column.children]).toEqual([openButton()])
  })

  it('IL-B2 below given → right after the open button, not inside it', () => {
    line({ below: content() })
    const el = belowContent()
    expect(el).not.toBeNull()
    expect(openButton().contains(el)).toBe(false)
    const column = openButton().parentElement!
    expect(column.children).toHaveLength(2)
    expect(column.children[0]).toBe(openButton())
    expect(column.children[1].contains(el)).toBe(true)
  })

  it('IL-B3 a click inside below → onOpen once', () => {
    const onOpen = vi.fn()
    line({ below: content(), onOpen })
    act(() => container.querySelector<HTMLElement>('[data-below-content] li')!.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('IL-B4 [WB] below adds no tab stop: still one focusable element, the wrapper has no tabindex', () => {
    line({ below: content() })
    const focusables = container.querySelectorAll(
      'button, [tabindex]:not([tabindex="-1"]), a[href], input, select, textarea'
    )
    expect([...focusables]).toEqual([openButton()])
    const wrapper = openButton().nextElementSibling as HTMLElement
    expect(wrapper.hasAttribute('tabindex')).toBe(false)
    expect(wrapper.getAttribute('role')).toBeNull()
  })
})
