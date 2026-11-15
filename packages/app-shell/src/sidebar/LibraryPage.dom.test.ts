// @vitest-environment jsdom
/**
 * 资料库某一组的那一页（sidebar/LibraryPage.tsx，手机布局；jsdom）与注册表三组共用的排节函数 `registrySections`。
 *
 * 契约（LibraryPage）：根是 `[data-library-page=<pageKey>]`；有行或有 `emptyHint` 的节才画（`[data-library-section=<key>]`，
 * 小标题在 `[data-library-section-label]`）；一行 = `[data-library-row]` + 它自己的 `attrs`，点 → `onOpen`、
 * 右键 / 长按 → `onMenu`；工具栏（数量 + 新建）不给 `toolbarSlot` 时画在页尾，给了元素画进那个元素，给 null 不画；
 * 「⋯」只在有 `onMenu` 且有 `menuSlot` 时画进那个槽；`header` 排在各节之前，`children` 代替各节。
 *
 *   LP-1  根的锚点
 *   LP-2 / LP-3 / LP-4  哪些节画、空节的那一句、整页的那一句
 *   LP-5 / LP-6  一行的各个部件与三个标志（mono / struck / dimmed）
 *   LP-7  点一行、长按一行
 *   LP-8  小标题：attrs、off、长按
 *   LP-9 / LP-10 / LP-13  工具栏在哪儿画；槽后到也画
 *   LP-11 「⋯」
 *   LP-12 header 与 children
 *   LP-20..27 registrySections：两节、行的 key / attrs / 标志、点与长按交给谁
 *   LP-30 文案键三语齐全
 *
 * 不需要任何替身（只引 react / react-dom / lucide）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import {
  LibraryPage,
  registrySections,
  type LibraryDrill,
  type LibraryPageProps,
  type LibraryPageRow,
  type LibraryPageSection,
  type RegistryPageItem
} from './LibraryPage'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const slots: HTMLElement[] = []

/** 宿主页面里的一个槽（列表之外的元素：顶栏右边 / 底栏），用例结束时摘掉 */
function slot(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-test-slot', '')
  document.body.appendChild(el)
  slots.push(el)
  return el
}

const baseDrill = (extra: Partial<LibraryDrill> = {}): LibraryDrill => ({
  scope: 'x',
  onOpen: vi.fn(),
  ...extra
})

const row = (key: string, extra: Partial<LibraryPageRow> = {}): LibraryPageRow => ({
  key,
  title: `Title ${key}`,
  onOpen: vi.fn(),
  ...extra
})

function render(props: Partial<LibraryPageProps> & { children?: ReactNode } = {}): void {
  act(() =>
    root.render(
      createElement(LibraryPage, {
        pageKey: 'x',
        drill: baseDrill(),
        sections: [],
        countText: 'count text',
        ...props
      })
    )
  )
}

const q = (sel: string, from: ParentNode = container): HTMLElement | null =>
  from.querySelector<HTMLElement>(sel)
const qa = (sel: string, from: ParentNode = container): HTMLElement[] => [
  ...from.querySelectorAll<HTMLElement>(sel)
]
const page = (): HTMLElement => q('[data-library-page]')!
const sectionKeys = (): string[] =>
  qa('[data-library-section]').map((el) => el.getAttribute('data-library-section') ?? '')
const sectionEl = (key: string): HTMLElement => q(`[data-library-section="${key}"]`)!
const rowEl = (name: string): HTMLElement => q(`[data-row="${name}"]`)!
const titleEl = (el: HTMLElement): HTMLElement => q('[data-library-row-title]', el)!
/** a 在 b 之前（文档顺序） */
const before = (a: Element, b: Element): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
function contextMenu(el: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  act(() => {
    el.dispatchEvent(event)
  })
  return event
}
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  for (const el of slots.splice(0)) el.remove()
})

describe('LibraryPage: sections and rows', () => {
  it('LP-1 the root carries data-library-page = pageKey', () => {
    render({ pageKey: 'agents' })
    expect(page().getAttribute('data-library-page')).toBe('agents')
    expect(container.firstElementChild).toBe(page())
  })

  it('LP-2 only sections with rows or an empty hint are drawn, in order; a section without a label has no label element', () => {
    const sections: LibraryPageSection[] = [
      { key: 'a', label: 'Section A', rows: [row('a1')] },
      { key: 'nothing', label: 'Nothing', rows: [] },
      { key: 'b', rows: [row('b1')] },
      { key: 'hint', label: 'Hinted', rows: [], emptyHint: 'nothing here' }
    ]
    render({ sections })
    expect(sectionKeys()).toEqual(['a', 'b', 'hint'])
    expect(q('[data-library-section-label]', sectionEl('a'))?.textContent).toBe('Section A')
    expect(q('[data-library-section-label]', sectionEl('b'))).toBeNull()
    expect(qa('[data-library-row]', sectionEl('b'))).toHaveLength(1)
    expect(container.textContent).not.toContain('Nothing')
  })

  it('LP-3 a section with no rows and an empty hint: the label and the sentence, no row', () => {
    render({ sections: [{ key: 'e', label: 'Empty one', rows: [], emptyHint: 'nothing here' }] })
    const section = sectionEl('e')
    expect(q('[data-library-section-label]', section)?.textContent).toBe('Empty one')
    expect(section.textContent).toContain('nothing here')
    expect(qa('[data-library-row]', section)).toEqual([])
    // 整页的那一句不画：有一节在
    expect(q('[data-library-empty]')).toBeNull()
  })

  it('LP-4 all sections empty: the page hint; without one nothing but the toolbar', () => {
    const sections: LibraryPageSection[] = [{ key: 'a', label: 'A', rows: [] }]
    render({ sections, emptyHint: 'no items at all' })
    expect(sectionKeys()).toEqual([])
    expect(q('[data-library-empty]')?.textContent).toBe('no items at all')
    expect(q('[data-library-toolbar]')).not.toBeNull()

    render({ sections })
    expect(q('[data-library-empty]')).toBeNull()
    expect(sectionKeys()).toEqual([])
    expect(q('[data-library-toolbar]')).not.toBeNull()
  })

  it('LP-5 the parts of a row: attrs, title, description, identifier, badge, lock, warning, hint, a trailing chevron', () => {
    render({
      sections: [
        {
          key: 's',
          rows: [
            row('full', {
              attrs: { 'data-row': 'full', 'data-agent-row': 'a.md' },
              title: 'Full row',
              description: 'what it does',
              identifier: 'ident',
              badge: 'Badge',
              locked: true,
              warning: true,
              hint: 'hover text'
            }),
            row('bare', { attrs: { 'data-row': 'bare' }, title: 'Bare row' })
          ]
        }
      ]
    })
    const full = rowEl('full')
    expect(full.hasAttribute('data-library-row')).toBe(true)
    expect(full.getAttribute('data-agent-row')).toBe('a.md')
    expect(titleEl(full).textContent).toBe('Full row')
    expect(q('[data-library-row-description]', full)?.textContent).toBe('what it does')
    expect(q('[data-library-row-identifier]', full)?.textContent).toBe('ident')
    expect(q('[data-library-row-badge]', full)?.textContent).toBe('Badge')
    expect(q('[data-library-row-lock]', full)).not.toBeNull()
    expect(full.querySelector('.text-amber-500')).not.toBeNull()
    expect(full.getAttribute('title')).toBe('hover text')

    const bare = rowEl('bare')
    expect(bare.hasAttribute('data-library-row')).toBe(true)
    expect(titleEl(bare).textContent).toBe('Bare row')
    expect(q('[data-library-row-description]', bare)).toBeNull()
    expect(q('[data-library-row-identifier]', bare)).toBeNull()
    expect(q('[data-library-row-badge]', bare)).toBeNull()
    expect(q('[data-library-row-lock]', bare)).toBeNull()
    expect(bare.querySelector('.text-amber-500')).toBeNull()
    expect(bare.hasAttribute('title')).toBe(false)

    // 行尾都是 ›：最后一个 svg，排在挂锁之后
    for (const el of [full, bare]) {
      const svgs = [...el.querySelectorAll('svg')]
      expect(svgs.length).toBeGreaterThan(0)
      const chevron = svgs.at(-1)!
      expect(chevron.hasAttribute('data-library-row-lock')).toBe(false)
      expect(chevron.classList.contains('text-amber-500')).toBe(false)
      expect(chevron.parentElement!.lastElementChild).toBe(chevron)
    }
  })

  it('LP-6 mono → a monospace title; struck → a line through the title only; dimmed → the row fades', () => {
    render({
      sections: [
        {
          key: 's',
          rows: [
            row('plain', { attrs: { 'data-row': 'plain' } }),
            row('mono', { attrs: { 'data-row': 'mono' }, mono: true }),
            row('struck', { attrs: { 'data-row': 'struck' }, struck: true, description: 'd' }),
            row('dimmed', { attrs: { 'data-row': 'dimmed' }, dimmed: true })
          ]
        }
      ]
    })
    const plain = rowEl('plain')
    expect(titleEl(plain).className).not.toContain('font-mono')
    expect(titleEl(plain).className).not.toContain('line-through')
    expect(plain.className).not.toContain('opacity-50')

    expect(titleEl(rowEl('mono')).className).toContain('font-mono')

    const struck = rowEl('struck')
    expect(titleEl(struck).className).toContain('line-through')
    expect(qa('.line-through', struck)).toEqual([titleEl(struck)])
    expect(struck.className).not.toContain('line-through')
    expect(struck.className).not.toContain('opacity-50')

    const dimmed = rowEl('dimmed')
    expect(dimmed.className).toContain('opacity-50')
    expect(titleEl(dimmed).className).not.toContain('line-through')
  })

  it('LP-7 a click opens the row; a contextmenu calls onMenu with the event; a row without onMenu does not throw', () => {
    const onOpen = vi.fn()
    const onMenu = vi.fn()
    const otherOpen = vi.fn()
    render({
      sections: [
        {
          key: 's',
          rows: [
            row('a', { attrs: { 'data-row': 'a' }, onOpen, onMenu }),
            row('b', { attrs: { 'data-row': 'b' }, onOpen: otherOpen })
          ]
        }
      ]
    })
    click(rowEl('a'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onMenu).not.toHaveBeenCalled()
    expect(otherOpen).not.toHaveBeenCalled()

    contextMenu(rowEl('a'))
    expect(onMenu).toHaveBeenCalledTimes(1)
    expect((onMenu.mock.calls[0][0] as { type: string }).type).toBe('contextmenu')
    expect(onOpen).toHaveBeenCalledTimes(1)

    expect(() => contextMenu(rowEl('b'))).not.toThrow()
    expect(otherOpen).not.toHaveBeenCalled()
  })

  it('LP-8 a section label: its attrs, off → struck, a contextmenu → the section’s onMenu, a click does nothing', () => {
    const onMenu = vi.fn()
    const onOpen = vi.fn()
    render({
      sections: [
        {
          key: 'dir:team',
          label: 'team',
          attrs: { 'data-skill-folder': 'team' },
          off: true,
          onMenu,
          rows: [row('r', { onOpen })]
        },
        { key: 'on', label: 'on', rows: [row('r2')] }
      ]
    })
    const label = q('[data-library-section-label]', sectionEl('dir:team'))!
    expect(label.getAttribute('data-skill-folder')).toBe('team')
    expect(label.className).toContain('line-through')
    expect(q('[data-library-section-label]', sectionEl('on'))!.className).not.toContain(
      'line-through'
    )

    contextMenu(label)
    expect(onMenu).toHaveBeenCalledTimes(1)
    click(label)
    expect(onMenu).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('LibraryPage: the toolbar, the menu button, header and children', () => {
  it('LP-9 without a toolbarSlot key the toolbar is inline after the sections; the new button only with onNew', () => {
    const onNew = vi.fn()
    render({
      sections: [{ key: 's', rows: [row('a')] }],
      countText: 'Agents: 3',
      onNew,
      newLabel: 'New agent'
    })
    const toolbar = q('[data-library-toolbar]')!
    expect(page().contains(toolbar)).toBe(true)
    expect(before(sectionEl('s'), toolbar)).toBe(true)
    expect(q('[data-library-count]', toolbar)?.textContent).toBe('Agents: 3')
    const add = q('[data-library-new]', toolbar)!
    expect(add.getAttribute('aria-label')).toBe('New agent')
    click(add)
    expect(onNew).toHaveBeenCalledTimes(1)

    render({ sections: [{ key: 's', rows: [row('a')] }], countText: 'Agents: 3' })
    expect(q('[data-library-toolbar]')).not.toBeNull()
    expect(q('[data-library-new]')).toBeNull()
  })

  it('LP-10 toolbarSlot: an element → the toolbar is drawn there; null → no toolbar anywhere', () => {
    const el = slot()
    render({ drill: baseDrill({ toolbarSlot: el }), countText: 'in the slot' })
    expect(q('[data-library-toolbar]', el)).not.toBeNull()
    expect(q('[data-library-count]', el)?.textContent).toBe('in the slot')
    expect(q('[data-library-toolbar]')).toBeNull()

    render({ drill: baseDrill({ toolbarSlot: null }) })
    expect(document.querySelector('[data-library-toolbar]')).toBeNull()
  })

  it('LP-13 a slot that arrives later: the toolbar appears in it', () => {
    render({ drill: baseDrill({ toolbarSlot: null }) })
    expect(document.querySelector('[data-library-toolbar]')).toBeNull()
    const el = slot()
    render({ drill: baseDrill({ toolbarSlot: el }) })
    expect(q('[data-library-toolbar]', el)).not.toBeNull()
    expect(document.querySelectorAll('[data-library-toolbar]')).toHaveLength(1)
  })

  it('LP-11 the menu button: only with onMenu and a menuSlot element, drawn in the slot', () => {
    const onMenu = vi.fn()
    const el = slot()
    render({ drill: baseDrill({ menuSlot: el }), onMenu, menuLabel: 'More actions' })
    const button = q('[data-library-menu]', el)!
    expect(button).not.toBeNull()
    expect(q('[data-library-menu]')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('More actions')
    click(button)
    expect(onMenu).toHaveBeenCalledTimes(1)

    render({ drill: baseDrill(), onMenu, menuLabel: 'More actions' })
    expect(document.querySelector('[data-library-menu]')).toBeNull()

    render({ drill: baseDrill({ menuSlot: null }), onMenu, menuLabel: 'More actions' })
    expect(document.querySelector('[data-library-menu]')).toBeNull()

    render({ drill: baseDrill({ menuSlot: el }) })
    expect(document.querySelector('[data-library-menu]')).toBeNull()
  })

  it('LP-12 header comes before the first section; children replace the sections and the page hint; children = false draws no body', () => {
    const sections: LibraryPageSection[] = [{ key: 's', rows: [row('a')] }]
    render({ sections, header: createElement('div', { 'data-test-header': '' }, 'header') })
    expect(before(q('[data-test-header]')!, sectionEl('s'))).toBe(true)

    const onMenu = vi.fn()
    const menu = slot()
    render({
      sections,
      emptyHint: 'page hint',
      onMenu,
      drill: baseDrill({ menuSlot: menu }),
      children: createElement('div', { 'data-test-body': '' }, 'body')
    })
    expect(q('[data-test-body]')).not.toBeNull()
    expect(sectionKeys()).toEqual([])
    expect(q('[data-library-empty]')).toBeNull()
    expect(q('[data-library-toolbar]')).not.toBeNull()
    expect(q('[data-library-menu]', menu)).not.toBeNull()

    // false 不是「没给」：代码用的是 ??，不回落到各节
    render({ sections, emptyHint: 'page hint', children: false })
    expect(sectionKeys()).toEqual([])
    expect(q('[data-library-empty]')).toBeNull()
    expect(qa('[data-library-row]')).toEqual([])
    expect(q('[data-library-toolbar]')).not.toBeNull()

    // 空的各节 + children：整页的那一句也不画
    render({ sections: [], emptyHint: 'page hint', children: createElement('i') })
    expect(q('[data-library-empty]')).toBeNull()
  })
})

interface Item extends RegistryPageItem {
  extra?: string
}

const item = (name: string, source: 'builtin' | 'user', extra: Partial<Item> = {}): Item => ({
  name,
  displayName: `Display ${name}`,
  source,
  fileName: source === 'user' ? `${name}.md` : '',
  ...extra
})

const LABELS = { mine: 'MINE', builtin: 'BUILTIN', overridden: 'OVERRIDDEN', disabled: 'DISABLED' }

function makeOpts(): {
  opts: Parameters<typeof registrySections<Item>>[2]
  onOpen: ReturnType<typeof vi.fn>
  onOpenInvalid: ReturnType<typeof vi.fn>
  menus: Map<string, (e: React.MouseEvent) => void>
} {
  const onOpen = vi.fn()
  const onOpenInvalid = vi.fn()
  const menus = new Map<string, (e: React.MouseEvent) => void>()
  const menuFor = (id: string): ((e: React.MouseEvent) => void) => {
    const existing = menus.get(id)
    if (existing) return existing
    const fn = (): void => {}
    menus.set(id, fn)
    return fn
  }
  return {
    onOpen,
    onOpenInvalid,
    menus,
    opts: {
      labels: LABELS,
      attrsOf: (it) => ({ 'data-item': it.name }),
      invalidAttrs: (fileName) => ({ 'data-invalid': fileName }),
      hintOf: (it) => (it.extra ? `hint ${it.extra}` : undefined),
      onOpen,
      onOpenInvalid,
      menuOf: (it) => menuFor(`item:${it.source}:${it.name}`),
      invalidMenu: (fileName) => menuFor(`invalid:${fileName}`)
    }
  }
}

describe('registrySections', () => {
  const B1 = item('b1', 'builtin', { description: 'builtin one' })
  const U1 = item('u1', 'user', { description: 'user one', extra: 'x' })
  const B2 = item('b2', 'builtin')
  const U2 = item('u2', 'user')
  const INVALID = [
    { fileName: 'bad.md', error: 'boom' },
    { fileName: 'worse.md', error: 'bang' }
  ]

  it('LP-20 two sections, mine then builtin; user items then invalid files in mine, builtins in builtin, all in input order', () => {
    const { opts } = makeOpts()
    const sections = registrySections([B1, U1, B2, U2], INVALID, opts)
    expect(sections.map((s) => s.key)).toEqual(['mine', 'builtin'])
    expect(sections.map((s) => s.label)).toEqual(['MINE', 'BUILTIN'])
    expect(sections[0].rows.map((r) => r.title)).toEqual([
      'Display u1',
      'Display u2',
      'bad.md',
      'worse.md'
    ])
    expect(sections[1].rows.map((r) => r.title)).toEqual(['Display b1', 'Display b2'])
  })

  it('LP-21 row keys and attrs', () => {
    const { opts } = makeOpts()
    const [mine, builtin] = registrySections([B1, U1], INVALID.slice(0, 1), opts)
    expect(mine.rows.map((r) => r.key)).toEqual(['file:u1.md', 'invalid:bad.md'])
    expect(builtin.rows.map((r) => r.key)).toEqual(['builtin:b1'])
    expect(mine.rows[0].attrs).toEqual({ 'data-item': 'u1' })
    expect(mine.rows[1].attrs).toEqual({ 'data-invalid': 'bad.md' })
    expect(builtin.rows[0].attrs).toEqual({ 'data-item': 'b1' })
  })

  it('LP-22 locked only for builtin items', () => {
    const { opts } = makeOpts()
    const [mine, builtin] = registrySections([B1, U1], INVALID.slice(0, 1), opts)
    expect(builtin.rows[0].locked).toBe(true)
    expect(mine.rows[0].locked).toBe(false)
    expect(mine.rows[1].locked ?? false).toBe(false)
  })

  it('LP-23 overridden → struck + the overridden badge, never dimmed; disabled only → dimmed + the disabled badge; neither → no badge', () => {
    const { opts } = makeOpts()
    const [mine] = registrySections(
      [
        item('over', 'user', { overridden: true }),
        item('both', 'user', { overridden: true, disabled: true }),
        item('off', 'user', { disabled: true }),
        item('plain', 'user')
      ],
      [],
      opts
    )
    const [over, both, off, plain] = mine.rows
    expect([over.struck, over.dimmed, over.badge]).toEqual([true, false, 'OVERRIDDEN'])
    expect([both.struck, both.dimmed, both.badge]).toEqual([true, false, 'OVERRIDDEN'])
    expect([off.struck, off.dimmed, off.badge]).toEqual([false, true, 'DISABLED'])
    expect([plain.struck, plain.dimmed, plain.badge]).toEqual([false, false, undefined])
  })

  it('LP-24 an invalid file row: the file name in monospace, a warning, the error as the hint; open and menu go to the invalid handlers', () => {
    const { opts, onOpen, onOpenInvalid, menus } = makeOpts()
    const [mine] = registrySections([], INVALID.slice(0, 1), opts)
    const bad = mine.rows[0]
    expect(bad.title).toBe('bad.md')
    expect(bad.mono).toBe(true)
    expect(bad.warning).toBe(true)
    expect(bad.hint).toBe('boom')
    expect(bad.description).toBeUndefined()
    expect(bad.locked ?? false).toBe(false)
    expect(bad.badge).toBeUndefined()

    bad.onOpen()
    expect(onOpenInvalid).toHaveBeenCalledTimes(1)
    expect(onOpenInvalid).toHaveBeenCalledWith('bad.md')
    expect(onOpen).not.toHaveBeenCalled()
    expect(bad.onMenu).toBe(menus.get('invalid:bad.md'))
  })

  it('LP-25 an item row: open gets the same object, the menu is menuOf(item), hint and description pass through', () => {
    const { opts, onOpen, onOpenInvalid, menus } = makeOpts()
    const [mine, builtin] = registrySections([B1, U1, U2], [], opts)
    const u1 = mine.rows[0]
    u1.onOpen()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0]).toBe(U1)
    expect(onOpenInvalid).not.toHaveBeenCalled()
    expect(u1.onMenu).toBe(menus.get('item:user:u1'))
    expect(u1.hint).toBe('hint x')
    expect(u1.description).toBe('user one')
    expect(u1.mono ?? false).toBe(false)
    expect(u1.warning ?? false).toBe(false)

    expect(mine.rows[1].hint).toBeUndefined()
    expect(mine.rows[1].description).toBeUndefined()

    builtin.rows[0].onOpen()
    expect(onOpen.mock.calls[1][0]).toBe(B1)
    expect(builtin.rows[0].onMenu).toBe(menus.get('item:builtin:b1'))
    expect(builtin.rows[0].description).toBe('builtin one')
  })

  it('LP-26 an overridden builtin stays in builtin; a shadowed user file stays in mine', () => {
    const { opts } = makeOpts()
    const [mine, builtin] = registrySections(
      [item('b', 'builtin', { overridden: true }), item('u', 'user', { overridden: true })],
      [],
      opts
    )
    expect(mine.rows.map((r) => r.key)).toEqual(['file:u.md'])
    expect(builtin.rows.map((r) => r.key)).toEqual(['builtin:b'])
    expect(builtin.rows[0].locked).toBe(true)
    expect(builtin.rows[0].struck).toBe(true)
  })

  it('LP-27 empty inputs → two sections without rows, and LibraryPage then draws no section', () => {
    const { opts } = makeOpts()
    const sections = registrySections<Item>([], [], opts)
    expect(sections.map((s) => [s.key, s.rows])).toEqual([
      ['mine', []],
      ['builtin', []]
    ])
    render({ sections })
    expect(sectionKeys()).toEqual([])
    expect(q('[data-library-toolbar]')).not.toBeNull()
  })

  it('LP-20 the sections render through LibraryPage with their rows’ anchors', () => {
    const { opts } = makeOpts()
    render({ sections: registrySections([B1, U1], INVALID.slice(0, 1), opts) })
    expect(sectionKeys()).toEqual(['mine', 'builtin'])
    expect(
      qa('[data-library-row]', sectionEl('mine')).map(
        (el) => el.getAttribute('data-item') ?? el.getAttribute('data-invalid')
      )
    ).toEqual(['u1', 'bad.md'])
    expect(q('[data-library-row][data-item="b1"] [data-library-row-lock]')).not.toBeNull()
  })
})

describe('library locale keys', () => {
  it('LP-30 the library strings exist in en / zh / ja, counted ones with _one and _other, and on ≠ off', () => {
    for (const [lang, locale] of [
      ['en', en],
      ['zh', zh],
      ['ja', ja]
    ] as const) {
      const m = locale.mobile as Record<string, string>
      for (const key of ['libraryMine', 'libraryBuiltin', 'on', 'off']) {
        expect(typeof m[key], `${lang} ${key}`).toBe('string')
        expect(m[key].trim(), `${lang} ${key}`).not.toBe('')
      }
      for (const key of ['libraryCount', 'libraryOwn', 'libraryEntries', 'libraryEntriesCount']) {
        for (const suffix of ['_one', '_other']) {
          const value = m[key + suffix]
          expect(typeof value, `${lang} ${key}${suffix}`).toBe('string')
          expect(value, `${lang} ${key}${suffix}`).toContain('{{count}}')
        }
      }
      expect(m.libraryCount_other, lang).toContain('{{name}}')
      expect(m.on, lang).not.toBe(m.off)
      expect(m.libraryMine, lang).not.toBe(m.libraryBuiltin)
    }
  })
})
