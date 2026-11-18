// @vitest-environment jsdom
/**
 * 文件时间线（LibraryTimeline.tsx，右侧栏的「文件」页）—— 测试设计 docs/file-library-timeline-tests.md §10，
 * TL-106…TL-131（TL-115 / TL-120 / TL-130 按削减名单略去）。
 *
 *   TL-106/107  空页；还没取回来时既不画空页也不画天
 *   TL-108      天的顺序与抬头（今天 / 昨天 / 不带年 / 带年）
 *   TL-109…111  会话抬头：标题、项目名、时间；给了 onOpenSession 才可点；没有会话的一组
 *   TL-112…114  图片是缩略图、别的是一行（扩展名、显示名、关系 · 大小）；大小与关系的写法
 *   TL-116/117  一组先显示 8 张图，其余收在 +N 后面；各组各管各的
 *   TL-118/119  文件不在了：data-missing、不画图；图加载失败同样
 *   TL-121      点文件 → requestFilePreview('library:<id>')
 *   TL-122/123  搜索（文件名、会话标题）；件数按不同的文件数、不随搜索变
 *   TL-124…126  可见时才取、每次重新可见都重取；library.changed 只在可见时重取
 *   TL-127…129  取失败：第一次 → 空页；之后 → 留着原来的；宿主没有 library → 空页
 *   TL-131      先发的答复晚到：不盖掉后发的
 *
 * `@shuvix/chat-ui` 整份换成替身：`getHostApi` 回每个用例自己的那一份，`useAppEvent` 记下处理函数好让用例发
 * `library.changed`，`useChatStore.getState()` 给 requestFilePreview 间谍，`useMediaUrl` 回 `media://<引用>`。
 * 今天定在 2026-11-18 12:00（只假 Date）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type {
  LibraryItemKind,
  LibraryLinkRelation,
  LibraryTimelineEntry,
  LibraryTimelineResult,
  LibraryTimelineSession
} from '@shuvix/chat-protocol/fileLibrary'

const store = vi.hoisted(() => ({
  /** getHostApi() 交回的东西（每个用例换） */
  hostApi: null as unknown,
  /** useAppEvent 最近一次登记的处理函数，按事件名 */
  handlers: {} as Record<string, () => void>,
  requestFilePreview: (_path: string): void => {},
  mediaUrl: (_session: string, path: string): string | null => `media://${path}`
}))

vi.mock('@shuvix/chat-ui', () => ({
  getHostApi: () => store.hostApi,
  useAppEvent: (type: string, handler: () => void) => {
    store.handlers[type] = handler
  },
  useChatStore: { getState: () => ({ requestFilePreview: store.requestFilePreview }) },
  useMediaUrl: (session: string, path: string) => store.mediaUrl(session, path)
}))

import { LibraryTimeline, type LibraryTimelineProps } from './LibraryTimeline'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ID = (n: number): string => `0199d3a2-0000-7000-8000-${String(n).padStart(12, '0')}`
const at = (month: number, day: number, hour = 9, min = 0, year = 2026): number =>
  new Date(year, month - 1, day, hour, min).getTime()

let container: HTMLDivElement
let root: Root
let timeline: ReturnType<typeof vi.fn<() => Promise<LibraryTimelineResult>>>
let preview: ReturnType<typeof vi.fn<(path: string) => void>>

function entry(
  n: number,
  sessionId: string | null,
  over: {
    name?: string
    kind?: LibraryItemKind
    size?: number
    relation?: LibraryLinkRelation | null
    at?: number
    missing?: boolean
  } = {}
): LibraryTimelineEntry {
  const kind = over.kind ?? 'image'
  const name = over.name ?? (kind === 'image' ? `img-${n}.png` : `doc-${n}.pdf`)
  return {
    item: {
      id: ID(n),
      name,
      fileName: name,
      kind,
      mime: kind === 'image' ? 'image/png' : 'application/pdf',
      size: over.size ?? 12 * 1024,
      storage: 'managed',
      source: 'chat-image',
      createdAt: 1
    },
    sessionId,
    relation: over.relation === undefined ? (sessionId ? 'sent' : null) : over.relation,
    at: over.at ?? at(11, 18),
    ...(over.missing ? { missing: true } : {})
  }
}

const result = (
  entries: LibraryTimelineEntry[],
  sessions: Record<string, LibraryTimelineSession> = { S1: { title: 'Trip plan' } }
): LibraryTimelineResult => ({ entries, sessions })

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(props: LibraryTimelineProps = {}): Promise<void> {
  act(() => root.render(createElement(LibraryTimeline, props)))
  await flush()
}

/** 用给定的结果挂上（已取回） */
async function show(r: LibraryTimelineResult, props: LibraryTimelineProps = {}): Promise<void> {
  timeline.mockResolvedValue(r)
  await mount(props)
}

async function fireChanged(): Promise<void> {
  act(() => store.handlers['library.changed']?.())
  await flush()
}

const $ = <T extends Element = HTMLElement>(
  selector: string,
  within: ParentNode = container
): T => {
  const el = within.querySelector<T>(selector)
  if (!el) throw new Error(`not found: ${selector}`)
  return el
}
const $$ = <T extends Element = HTMLElement>(
  selector: string,
  within: ParentNode = container
): T[] => Array.from(within.querySelectorAll<T>(selector))

const fileEl = (n: number): HTMLElement => $(`[data-timeline-file="${ID(n)}"]`)
const metaOf = (n: number): string => fileEl(n).lastElementChild?.textContent ?? ''
const groupEl = (sessionId: string): HTMLElement => $(`[data-timeline-session="${sessionId}"]`)
const fileIds = (within: ParentNode = container): string[] =>
  $$('[data-timeline-file]', within).map((el) => el.getAttribute('data-timeline-file') ?? '')
const countText = (): string => $('[data-timeline-count]').textContent ?? ''

function type(text: string): void {
  const input = $<HTMLInputElement>('[data-timeline-search]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 18, 12, 0))
  timeline = vi.fn(async () => result([]))
  preview = vi.fn()
  store.hostApi = { library: { timeline } }
  store.handlers = {}
  store.requestFilePreview = preview
  store.mediaUrl = (_session, path) => `media://${path}`
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('空页与加载', () => {
  it('TL-106 没有文件：空页的那句话，没有天，件数 0', async () => {
    await show(result([], {}))
    expect($$('[data-library-timeline]')).toHaveLength(1)
    expect($('[data-timeline-empty]').textContent).toBe(en.library.empty)
    expect($$('[data-timeline-day]')).toEqual([])
    expect(countText()).toBe('0 files')
  })

  it('TL-107 还没取回来：既没有空页也没有天', async () => {
    timeline.mockReturnValue(new Promise(() => {}))
    await mount()
    expect($$('[data-timeline-empty]')).toEqual([])
    expect($$('[data-timeline-day]')).toEqual([])
  })
})

describe('天与会话抬头', () => {
  it('TL-108 四天按新到旧；抬头：Today、Yesterday、不带年的日期、带年的日期', async () => {
    await show(
      result([
        entry(1, 'S1', { at: at(11, 18) }),
        entry(2, 'S1', { at: at(11, 17) }),
        entry(3, 'S1', { at: at(11, 10) }),
        entry(4, 'S1', { at: at(12, 31, 9, 0, 2025) })
      ])
    )
    const days = $$('[data-timeline-day]')
    expect(days.map((d) => d.getAttribute('data-timeline-day'))).toEqual([
      '2026-11-18',
      '2026-11-17',
      '2026-11-10',
      '2025-12-31'
    ])
    const headings = days.map((d) => $('h3', d).textContent ?? '')
    expect(headings.slice(0, 2)).toEqual(['Today', 'Yesterday'])
    expect(headings[2]).toContain('10')
    expect(headings[2]).not.toContain('2026')
    expect(headings[3]).toContain('31')
    expect(headings[3]).toContain('2025')
  })

  it('TL-109 会话抬头：标题、项目名、时间；是按钮，点了 → onOpenSession(会话)', async () => {
    const onOpenSession = vi.fn()
    await show(
      result([entry(1, 'S1', { at: at(11, 18, 9, 5) })], {
        S1: { title: 'Trip plan', projectName: 'Alpha' }
      }),
      { onOpenSession }
    )
    const text = groupEl('S1').textContent ?? ''
    expect(text).toContain('Trip plan')
    expect(text).toContain('Alpha')
    expect(text).toContain('09:05')
    const open = $('[data-timeline-open-session="S1"]')
    expect(open.tagName).toBe('BUTTON')
    act(() => open.click())
    expect(onOpenSession.mock.calls).toEqual([['S1']])
  })

  it('TL-110 不给 onOpenSession：抬头不可点，标题还在', async () => {
    await show(result([entry(1, 'S1')]))
    expect($$('[data-timeline-open-session]')).toEqual([])
    expect(groupEl('S1').textContent).toContain('Trip plan')
  })

  it('TL-111 没有会话的与会话已删的并成一组：「Not in a chat」，不可点，两件都在里面', async () => {
    await show(
      result([entry(1, null), entry(2, 'gone', { kind: 'pdf' })], { S1: { title: 'Trip plan' } }),
      { onOpenSession: vi.fn() }
    )
    const groups = $$('[data-timeline-session]')
    expect(groups.map((g) => g.getAttribute('data-timeline-session'))).toEqual([''])
    expect(groups[0].textContent).toContain(en.library.noSession)
    expect($$('[data-timeline-open-session]', groups[0])).toEqual([])
    expect(fileIds(groups[0]).sort()).toEqual([ID(1), ID(2)])
  })
})

describe('文件：缩略图与行', () => {
  it('TL-112 图片是格子里的缩略图（src = 库引用的媒体地址）；别的是一行：扩展名、显示名、关系 · 大小', async () => {
    await show(
      result([
        entry(1, 'S1'),
        entry(2, 'S1'),
        entry(3, 'S1'),
        entry(4, 'S1', { kind: 'pdf', name: 'Report.pdf' }),
        entry(5, 'S1', { kind: 'document', name: 'notes.md' })
      ])
    )
    const grid = $('.grid.grid-cols-4', groupEl('S1'))
    const thumbs = $$('[data-timeline-file]', grid)
    expect(thumbs.map((t) => t.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON'])
    expect(thumbs.map((t) => $<HTMLImageElement>('img', t).getAttribute('src'))).toEqual(
      [1, 2, 3].map((n) => `media://library:${ID(n)}`)
    )
    for (const [n, badge, name] of [
      [4, 'PDF', 'Report.pdf'],
      [5, 'MD', 'notes.md']
    ] as const) {
      const row = fileEl(n)
      expect(row.tagName).toBe('BUTTON')
      expect(grid.contains(row)).toBe(false)
      expect($$('img', row)).toEqual([])
      expect(row.firstElementChild?.textContent).toBe(badge)
      expect(row.textContent).toContain(name)
      expect(metaOf(n)).toBe('Sent · 12 KB')
    }
  })

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '2 KB'],
    [1023 * 1024, '1023 KB'],
    [1048575, '1.0 MB'],
    [1048576, '1.0 MB'],
    [5.5 * 1024 * 1024, '5.5 MB']
  ])('TL-113 大小 %d 字节写成 %s', async (size, label) => {
    await show(result([entry(1, null, { kind: 'pdf', size })], {}))
    expect(metaOf(1)).toBe(label)
  })

  it('TL-114 关系的写法；没有关系只写大小，不带分隔符', async () => {
    await show(
      result([
        entry(1, 'S1', { kind: 'pdf', relation: 'sent' }),
        entry(2, 'S1', { kind: 'pdf', relation: 'attached' }),
        entry(3, 'S1', { kind: 'pdf', relation: 'shown' }),
        entry(4, 'S1', { kind: 'pdf', relation: 'produced' }),
        entry(5, null, { kind: 'pdf' })
      ])
    )
    expect(
      [1, 2, 3, 4, 5].map((n) => [fileEl(n).getAttribute('data-relation'), metaOf(n)])
    ).toEqual([
      ['sent', 'Sent · 12 KB'],
      ['attached', 'Added · 12 KB'],
      ['shown', 'Shown by the agent · 12 KB'],
      ['produced', 'Made by the agent · 12 KB'],
      ['', '12 KB']
    ])
  })

  it('TL-116 一组 8 张图：全画出来，没有 +N', async () => {
    await show(result(Array.from({ length: 8 }, (_, i) => entry(i + 1, 'S1'))))
    expect($$('[data-timeline-file]')).toHaveLength(8)
    expect($$('[data-timeline-more]')).toEqual([])
  })

  it('TL-117 一组 11 张图：先 8 张加一格 +3；点了全画出来；别的组不受影响', async () => {
    await show(
      result(
        [
          ...Array.from({ length: 11 }, (_, i) => entry(i + 1, 'S1', { at: at(11, 18, 10) })),
          ...Array.from({ length: 11 }, (_, i) => entry(i + 101, 'S2', { at: at(11, 18, 8) }))
        ],
        { S1: { title: 'Trip plan' }, S2: { title: 'Other' } }
      )
    )
    const s1 = groupEl('S1')
    expect(fileIds(s1)).toEqual(Array.from({ length: 8 }, (_, i) => ID(i + 1)))
    expect($('[data-timeline-more]', s1).textContent).toBe('+3')

    act(() => $('[data-timeline-more]', s1).click())

    expect(fileIds(groupEl('S1'))).toHaveLength(11)
    expect($$('[data-timeline-more]', groupEl('S1'))).toEqual([])
    expect(fileIds(groupEl('S2'))).toHaveLength(8)
    expect($('[data-timeline-more]', groupEl('S2')).textContent).toBe('+3')
  })

  it('TL-118 文件不在了：带 data-missing；行写「File not found」；图不画 img；还在的没有这个属性', async () => {
    await show(
      result([
        entry(1, 'S1', { kind: 'pdf', missing: true }),
        entry(2, 'S1', { missing: true }),
        entry(3, 'S1', { kind: 'pdf' }),
        entry(4, 'S1')
      ])
    )
    expect(fileEl(1).hasAttribute('data-missing')).toBe(true)
    expect(metaOf(1)).toBe(en.library.missing)
    expect(fileEl(1).textContent).not.toContain('Sent')
    expect(fileEl(2).hasAttribute('data-missing')).toBe(true)
    expect($$('img', fileEl(2))).toEqual([])
    expect(fileEl(3).hasAttribute('data-missing')).toBe(false)
    expect(fileEl(4).hasAttribute('data-missing')).toBe(false)
    expect($$('img', fileEl(4))).toHaveLength(1)
  })

  it('TL-119 图加载失败：那一格带上 data-missing、不再画 img', async () => {
    await show(result([entry(1, 'S1'), entry(2, 'S1')]))
    act(() => {
      $('img', fileEl(1)).dispatchEvent(new Event('error'))
    })
    expect(fileEl(1).hasAttribute('data-missing')).toBe(true)
    expect($$('img', fileEl(1))).toEqual([])
    expect(fileEl(2).hasAttribute('data-missing')).toBe(false)
    expect($$('img', fileEl(2))).toHaveLength(1)
  })

  it('TL-121 点缩略图、点行：各开一次那件的预览', async () => {
    await show(result([entry(1, 'S1'), entry(2, 'S1', { kind: 'pdf' })]))
    act(() => fileEl(1).click())
    act(() => fileEl(2).click())
    expect(preview.mock.calls).toEqual([[`library:${ID(1)}`], [`library:${ID(2)}`]])
  })
})

describe('搜索与件数', () => {
  it('TL-122 按文件名、按会话标题搜；什么都不匹配写「Nothing matches」；清空后都回来', async () => {
    await show(
      result(
        [
          entry(1, 'S1', { kind: 'pdf', name: 'Report.pdf', at: at(11, 18, 10) }),
          entry(2, 'S2', { name: 'cat.png', at: at(11, 18, 8) })
        ],
        { S1: { title: 'Trip plan' }, S2: { title: 'Other' } }
      )
    )
    const sessions = (): Array<string | null> =>
      $$('[data-timeline-session]').map((g) => g.getAttribute('data-timeline-session'))

    type('report')
    expect(sessions()).toEqual(['S1'])
    expect(fileIds()).toEqual([ID(1)])

    type('TRIP')
    expect(sessions()).toEqual(['S1'])

    type('zzz')
    expect(sessions()).toEqual([])
    expect($('[data-timeline-empty]').textContent).toBe(en.library.noMatch)

    type('')
    expect(sessions()).toEqual(['S1', 'S2'])
    expect($$('[data-timeline-empty]')).toEqual([])
  })

  it('TL-123 件数按不同的文件：在两条会话里的一件只算一次；不随搜索变；一件写单数', async () => {
    await show(
      result(
        [
          entry(1, 'S1', { name: 'a.png' }),
          entry(1, 'S2', { name: 'a.png' }),
          entry(2, 'S1', { name: 'b.png' })
        ],
        { S1: { title: 'Trip plan' }, S2: { title: 'Other' } }
      )
    )
    expect(countText()).toBe('2 files')
    type('b.png')
    expect(fileIds()).toEqual([ID(2)])
    expect(countText()).toBe('2 files')

    timeline.mockResolvedValue(result([entry(3, 'S1')]))
    await fireChanged()
    expect(countText()).toBe('1 file')
  })
})

describe('什么时候取', () => {
  it('TL-124 不可见时不取；可见了取一次；再次可见再取一次', async () => {
    await mount({ active: false })
    expect(timeline).not.toHaveBeenCalled()

    await mount({ active: true })
    expect(timeline).toHaveBeenCalledTimes(1)

    await mount({ active: false })
    expect(timeline).toHaveBeenCalledTimes(1)
    await mount({ active: true })
    expect(timeline).toHaveBeenCalledTimes(2)
  })

  it('TL-125 可见时 library.changed：重取，画新的结果', async () => {
    await show(result([entry(1, 'S1')]))
    expect(fileIds()).toEqual([ID(1)])

    timeline.mockResolvedValue(result([entry(2, 'S1'), entry(1, 'S1')]))
    await fireChanged()

    expect(timeline).toHaveBeenCalledTimes(2)
    expect(fileIds()).toEqual([ID(2), ID(1)])
  })

  it('TL-126 不可见时 library.changed：不取；之后可见了才取', async () => {
    await mount({ active: false })
    await fireChanged()
    expect(timeline).not.toHaveBeenCalled()

    await mount({ active: true })
    expect(timeline).toHaveBeenCalledTimes(1)
  })

  it('TL-127 第一次取就失败：空页，不抛', async () => {
    timeline.mockRejectedValue(new Error('offline'))
    await mount()
    expect($('[data-timeline-empty]').textContent).toBe(en.library.empty)
  })

  it('TL-128 已有内容之后的一次重取失败：原来的文件留着', async () => {
    await show(result([entry(1, 'S1'), entry(2, 'S1')]))
    timeline.mockRejectedValue(new Error('offline'))
    await fireChanged()
    expect(timeline).toHaveBeenCalledTimes(2)
    expect(fileIds()).toEqual([ID(1), ID(2)])
    expect($$('[data-timeline-empty]')).toEqual([])
  })

  it.each([
    ['null', null],
    ['没有 library', {}]
  ])('TL-129 宿主是 %s：空页，不抛', async (_label, api) => {
    store.hostApi = api
    await mount()
    expect($('[data-timeline-empty]').textContent).toBe(en.library.empty)
    expect(timeline).not.toHaveBeenCalled()
  })

  it('TL-131 两次重取，先发的后到：画的是后发的那一份', async () => {
    await show(result([entry(1, 'S1')]))
    const first = deferred<LibraryTimelineResult>()
    const second = deferred<LibraryTimelineResult>()
    timeline.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await fireChanged()
    await fireChanged()
    expect(timeline).toHaveBeenCalledTimes(3)

    second.resolve(result([entry(3, 'S1')]))
    await flush()
    expect(fileIds()).toEqual([ID(3)])

    first.resolve(result([entry(2, 'S1')]))
    await flush()
    expect(fileIds()).toEqual([ID(3)])
  })
})
