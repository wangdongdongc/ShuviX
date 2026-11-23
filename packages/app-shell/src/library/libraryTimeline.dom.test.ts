// @vitest-environment jsdom
/**
 * 文件时间线（LibraryTimeline.tsx，右侧栏的「文件」页）—— 测试设计 docs/file-library-timeline-tests.md §10。
 * 2026-11-23 改版（用户裁决：不按会话分组、一件一行、没有搜索与件数）后重写；沿用原编号的保留原号，
 * 搜索 / 件数 / 会话抬头 / 缩略图网格 / +N 的用例（TL-109/110/116/117/122/123/127 网格/140）随之删去，新增 TL-150…159。
 *
 *   TL-106/107  空页（只有那句话，没有搜索框与件数）；还没取回来时既不画空页也不画天
 *   TL-108      天的顺序与抬头（今天 / 昨天 / 不带年 / 带年）
 *   TL-150      一天里一件一行，按 entry.at 新的在前（不按会话聚）；没有会话抬头 / 缩略图网格 / +N
 *   TL-151      同一件当天在两条会话里 = 两行
 *   TL-152/153  行里的会话名：给了 onOpenSession 是按钮，点了只切会话、不开文件；不给是文字
 *   TL-111      没有会话的与会话已删的：data-session=''、不写会话名；同一件并成一行
 *   TL-112      左端：图是 img（库引用的媒体地址），别的是图标；打开按钮的 title / aria-label / data-relation
 *   TL-113/114  大小的写法；关系只进 title，不进第二行
 *   TL-154      时刻（entry.at 的 HH:MM）
 *   TL-118/119  文件不在了：data-missing、不画图、第二行与 title 写「File not found」；图加载失败同样带 data-missing
 *   TL-121      点图的行 → 看图层打开这一天的图（去重、按行序、点中的那张）；点别的行 → requestFilePreview('library:<id>')；
 *               不在了的图不进组，点它照旧 requestFilePreview
 *   TL-155      看图层的一组只含这一天的图，不带别的天
 *   TL-156      同一张图当天在两条会话里：组里只算一次，两行点开的是同一张
 *   TL-124…126  可见时才取、每次重新可见都重取；library.changed 只在可见时重取
 *   TL-127…129  取失败：第一次 → 空页；之后 → 留着原来的；宿主没有 library → 空页
 *   TL-131      先发的答复晚到：不盖掉后发的
 *   TL-135…141  专注模式（`focusSessionId`）：FADED = `opacity-30 hover:opacity-100 focus-within:opacity-100`
 *               三个类一起在或一起不在。不传 / null / '' → 什么都不淡；给了 S1 → 每天的抬头、S2 的行与没有会话的行淡，
 *               S1 的行（哪天都算）不淡；给了一个不在时间线里的会话 → 全淡、不抛；S1 → S2 重渲染，淡跟着走
 *
 *   TL-160…184 行的右键菜单（docs/file-library-open-reveal-tests.md §4）：哪些项（打开 / 打开所属会话 | 复制路径 /
 *               在文件夹中显示）、每一项做什么、`library.locate` 什么时候问、取不到路径（宿主没有、拒绝、同步抛、
 *               回 null、过了 LOCATE_TIMEOUT_MS 还没答）时只剩前两项、内置 DOM 菜单、没有 Provider 时什么都不做。
 *               菜单经 `ContextMenuProvider` 的 `render` 间谍观察（没有 Provider 时 useContextMenu 是空操作）
 *
 * `@shuvix/chat-ui` 整份换成替身：`getHostApi` 回每个用例自己的那一份，`useAppEvent` 记下处理函数好让用例发
 * `library.changed`，`useChatStore.getState()` 给 requestFilePreview 间谍，`useMediaUrl` 回 `media://<引用>`。
 * 今天定在 2026-11-18 12:00（只假 Date）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type FunctionComponent } from 'react'
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
  openImageViewer: (_images: unknown[], _index?: number): void => {},
  copyToClipboard: (_text: string): void => {},
  mediaUrl: (_session: string, path: string): string | null => `media://${path}`
}))

vi.mock('@shuvix/chat-ui', () => ({
  getHostApi: () => store.hostApi,
  useAppEvent: (type: string, handler: () => void) => {
    store.handlers[type] = handler
  },
  useChatStore: { getState: () => ({ requestFilePreview: store.requestFilePreview }) },
  openImageViewer: (images: unknown[], index?: number) => store.openImageViewer(images, index),
  copyToClipboard: (text: string) => store.copyToClipboard(text),
  useMediaUrl: (session: string, path: string) => store.mediaUrl(session, path)
}))

import { LibraryTimeline, LOCATE_TIMEOUT_MS, type LibraryTimelineProps } from './LibraryTimeline'
import { ContextMenuProvider, type ContextMenuRenderer } from '../contextmenu/ContextMenuProvider'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import type { LibraryFileLocation } from '@shuvix/chat-protocol/fileLibrary'

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
let viewer: ReturnType<typeof vi.fn<(images: unknown[], index?: number) => void>>

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
/** 这一件的那一行；一件在几条会话里就有几行，给 sessionId 挑（'' = 不带会话的那一行） */
const rowEl = (n: number, sessionId?: string): HTMLElement => {
  const rows = $$('[data-timeline-row]').filter(
    (r) =>
      r.querySelector(`[data-timeline-file="${ID(n)}"]`) &&
      (sessionId === undefined || r.getAttribute('data-session') === sessionId)
  )
  if (rows.length !== 1) throw new Error(`expected one row for ${n}, got ${rows.length}`)
  return rows[0]
}
const metaOf = (n: number): string => $('[data-timeline-meta]', rowEl(n)).textContent ?? ''
const nameOf = (n: number): string => $('[data-timeline-name]', rowEl(n)).textContent ?? ''
const fileIds = (within: ParentNode = container): string[] =>
  $$('[data-timeline-file]', within).map((el) => el.getAttribute('data-timeline-file') ?? '')
/** 每一行的 [会话, 文件 id]，DOM 序 */
const rowPairs = (within: ParentNode = container): Array<[string, string]> =>
  $$('[data-timeline-row]', within).map((r) => [
    r.getAttribute('data-session') ?? '',
    $('[data-timeline-file]', r).getAttribute('data-timeline-file') ?? ''
  ])
const dayEl = (day: string): HTMLElement => $(`[data-timeline-day="${day}"]`)

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
  viewer = vi.fn()
  store.openImageViewer = viewer
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
  it('TL-106 没有文件：空页的那句话，没有天；没有搜索框与件数', async () => {
    await show(result([], {}))
    expect($$('[data-library-timeline]')).toHaveLength(1)
    expect($('[data-timeline-empty]').textContent).toBe(en.library.empty)
    expect($$('[data-timeline-day]')).toEqual([])
    expect($$('[data-timeline-search]')).toEqual([])
    expect($$('[data-timeline-count]')).toEqual([])
    expect($$('input')).toEqual([])
  })

  it('TL-107 还没取回来：既没有空页也没有天', async () => {
    timeline.mockReturnValue(new Promise(() => {}))
    await mount()
    expect($$('[data-timeline-empty]')).toEqual([])
    expect($$('[data-timeline-day]')).toEqual([])
  })
})

describe('天与行', () => {
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
    expect(days.map((d) => d.tagName)).toEqual(['SECTION', 'SECTION', 'SECTION', 'SECTION'])
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

  it('TL-150 一天里一件一行、按时刻新的在前，不按会话聚；没有会话抬头、缩略图网格、+N', async () => {
    await show(
      result(
        [
          entry(1, 'S1', { at: at(11, 18, 8) }),
          entry(2, 'S2', { at: at(11, 18, 11) }),
          entry(3, 'S1', { at: at(11, 18, 10), kind: 'pdf' }),
          entry(4, null, { at: at(11, 18, 9) }),
          entry(5, 'S2', { at: at(11, 17, 23) })
        ],
        { S1: { title: 'Trip plan' }, S2: { title: 'Other' } }
      )
    )
    expect(rowPairs(dayEl('2026-11-18'))).toEqual([
      ['S2', ID(2)],
      ['S1', ID(3)],
      ['', ID(4)],
      ['S1', ID(1)]
    ])
    expect(rowPairs(dayEl('2026-11-17'))).toEqual([['S2', ID(5)]])
    // 天下面只有抬头与行
    expect(
      Array.from(dayEl('2026-11-18').children).map((c) =>
        c.tagName === 'H3' ? 'h3' : c.hasAttribute('data-timeline-row') ? 'row' : c.tagName
      )
    ).toEqual(['h3', 'row', 'row', 'row', 'row'])
    for (const gone of [
      '[data-timeline-session]',
      '[data-timeline-heading]',
      '[data-timeline-thumbs]',
      '[data-timeline-more]'
    ]) {
      expect($$(gone)).toEqual([])
    }
  })

  it('TL-150 一天 11 张图：11 行，全部排出来', async () => {
    await show(
      result(Array.from({ length: 11 }, (_, i) => entry(i + 1, 'S1', { at: at(11, 18, 9, i) })))
    )
    expect(fileIds()).toEqual(Array.from({ length: 11 }, (_, i) => ID(11 - i)))
    expect($$('[data-timeline-row]')).toHaveLength(11)
  })

  it('TL-151 同一件当天在两条会话里：两行，各带各的会话名', async () => {
    const onOpenSession = vi.fn()
    await show(
      result(
        [
          entry(1, 'S1', { name: 'a.png', at: at(11, 18, 10) }),
          entry(1, 'S2', { name: 'a.png', at: at(11, 18, 9), relation: 'attached' })
        ],
        { S1: { title: 'Trip plan' }, S2: { title: 'Other' } }
      ),
      { onOpenSession }
    )
    expect(rowPairs()).toEqual([
      ['S1', ID(1)],
      ['S2', ID(1)]
    ])
    expect($('[data-timeline-open-session]', rowEl(1, 'S1')).textContent).toBe('Trip plan')
    expect($('[data-timeline-open-session]', rowEl(1, 'S2')).textContent).toBe('Other')
    expect($('[data-timeline-file]', rowEl(1, 'S2')).getAttribute('data-relation')).toBe('attached')
  })

  it('TL-152 给了 onOpenSession：会话名是按钮；点它 → onOpenSession(会话)，不开文件也不开看图层', async () => {
    const onOpenSession = vi.fn()
    await show(result([entry(1, 'S1'), entry(2, 'S1', { kind: 'pdf', at: at(11, 18, 8) })]), {
      onOpenSession
    })
    for (const n of [1, 2]) {
      const open = $('[data-timeline-open-session="S1"]', rowEl(n))
      expect(open.tagName).toBe('BUTTON')
      expect(open.textContent).toBe('Trip plan')
      expect($$('[data-timeline-session-name]', rowEl(n))).toEqual([])
      act(() => open.click())
    }
    expect(onOpenSession.mock.calls).toEqual([['S1'], ['S1']])
    expect(viewer).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
    // 会话名不在打开按钮里面（两个按钮不嵌套）
    expect(fileEl(1).contains($('[data-timeline-open-session]', rowEl(1)))).toBe(false)
  })

  it('TL-153 不给 onOpenSession：会话名只是文字', async () => {
    await show(result([entry(1, 'S1')]))
    expect($$('[data-timeline-open-session]')).toEqual([])
    const name = $('[data-timeline-session-name]', rowEl(1))
    expect(name.tagName).toBe('SPAN')
    expect(name.textContent).toBe('Trip plan')
  })

  it("TL-111 没有会话的与会话已删的：data-session=''、不写会话名、不可点；第二行只有大小", async () => {
    await show(
      result(
        [
          entry(1, null, { at: at(11, 18, 10) }),
          entry(2, 'gone', { kind: 'pdf', at: at(11, 18, 9) })
        ],
        { S1: { title: 'Trip plan' } }
      ),
      { onOpenSession: vi.fn() }
    )
    expect(rowPairs()).toEqual([
      ['', ID(1)],
      ['', ID(2)]
    ])
    for (const n of [1, 2]) {
      const row = rowEl(n)
      expect($$('[data-timeline-open-session]', row)).toEqual([])
      expect($$('[data-timeline-session-name]', row)).toEqual([])
      expect(row.textContent).not.toContain('Trip plan')
      // 名字下面那一行：只有大小，没有分隔点
      expect($('[data-timeline-meta]', row).parentElement?.textContent).toBe('12 KB')
    }
  })

  it('TL-111 同一件当天的关联会话都删了：并成一行', async () => {
    await show(
      result(
        [entry(1, 'gone-a', { at: at(11, 18, 10) }), entry(1, 'gone-b', { at: at(11, 18, 9) })],
        {}
      )
    )
    expect(rowPairs()).toEqual([['', ID(1)]])
  })
})

describe('一行里的东西', () => {
  it('TL-112 图：左端是 img（src = 库引用的媒体地址）；别的：图标。打开按钮带名字与关系', async () => {
    await show(
      result([
        entry(1, 'S1', { at: at(11, 18, 10) }),
        entry(4, 'S1', { kind: 'pdf', name: 'Report.pdf', at: at(11, 18, 9) }),
        entry(5, 'S1', {
          kind: 'document',
          name: 'notes.md',
          at: at(11, 18, 8),
          relation: 'attached'
        })
      ])
    )
    expect($$('[data-timeline-row]').map((r) => r.tagName)).toEqual(['DIV', 'DIV', 'DIV'])
    const img = $<HTMLImageElement>('img', rowEl(1))
    expect(img.getAttribute('src')).toBe(`media://library:${ID(1)}`)
    expect(img.parentElement?.style.width).toBe('32px')
    expect(img.parentElement?.style.height).toBe('32px')
    for (const [n, name, hint, relation] of [
      [1, 'img-1.png', 'img-1.png · Sent', 'sent'],
      [4, 'Report.pdf', 'Report.pdf · Sent', 'sent'],
      [5, 'notes.md', 'notes.md · Added', 'attached']
    ] as const) {
      const open = fileEl(n)
      expect(open.tagName).toBe('BUTTON')
      expect(open.getAttribute('title')).toBe(hint)
      expect(open.getAttribute('aria-label')).toBe(hint)
      expect(open.getAttribute('data-relation')).toBe(relation)
      expect(nameOf(n)).toBe(name)
    }
    for (const n of [4, 5]) {
      expect($$('img', rowEl(n))).toEqual([])
      expect($$('svg', rowEl(n))).toHaveLength(1)
    }
  })

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '2 KB'],
    [48 * 1024, '48 KB'],
    [1023 * 1024, '1023 KB'],
    [1048575, '1.0 MB'],
    [1048576, '1.0 MB'],
    [3.4 * 1024 * 1024, '3.4 MB'],
    [5.5 * 1024 * 1024, '5.5 MB']
  ])('TL-113 大小 %d 字节写成 %s', async (size, label) => {
    await show(result([entry(1, null, { kind: 'pdf', size })], {}))
    expect(metaOf(1)).toBe(label)
  })

  it('TL-114 关系只进 title，不进第二行；没有关系 title 只有名字', async () => {
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
      [1, 2, 3, 4, 5].map((n) => [
        fileEl(n).getAttribute('data-relation'),
        fileEl(n).getAttribute('title'),
        metaOf(n)
      ])
    ).toEqual([
      ['sent', 'doc-1.pdf · Sent', '12 KB'],
      ['attached', 'doc-2.pdf · Added', '12 KB'],
      ['shown', 'doc-3.pdf · Shown by the agent', '12 KB'],
      ['produced', 'doc-4.pdf · Made by the agent', '12 KB'],
      ['', 'doc-5.pdf', '12 KB']
    ])
    // 带会话的行：会话名 · 大小
    expect($('[data-timeline-meta]', rowEl(1)).parentElement?.textContent).toBe('Trip plan·12 KB')
  })

  it('TL-154 右端是 entry.at 的时刻', async () => {
    await show(
      result([entry(1, 'S1', { at: at(11, 18, 9, 5) }), entry(2, null, { at: at(11, 18, 7, 42) })])
    )
    expect($('[data-timeline-time]', rowEl(1)).textContent).toBe('09:05')
    expect($('[data-timeline-time]', rowEl(2)).textContent).toBe('07:42')
  })

  it('TL-118 文件不在了：带 data-missing；第二行与 title 写「File not found」；图不画 img；还在的没有这个属性', async () => {
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
    expect(fileEl(1).getAttribute('title')).toBe(`doc-1.pdf · ${en.library.missing}`)
    expect(fileEl(1).getAttribute('aria-label')).toBe(`doc-1.pdf · ${en.library.missing}`)
    expect(rowEl(1).textContent).not.toContain('12 KB')
    expect(fileEl(2).hasAttribute('data-missing')).toBe(true)
    expect(metaOf(2)).toBe(en.library.missing)
    expect($$('img', rowEl(2))).toEqual([])
    expect(fileEl(3).hasAttribute('data-missing')).toBe(false)
    expect(metaOf(3)).toBe('12 KB')
    expect(fileEl(4).hasAttribute('data-missing')).toBe(false)
    expect($$('img', rowEl(4))).toHaveLength(1)
  })

  it('TL-119 图加载失败：那一行带上 data-missing、不再画 img；第二行仍是大小', async () => {
    await show(result([entry(1, 'S1'), entry(2, 'S1', { at: at(11, 18, 8) })]))
    act(() => {
      $('img', rowEl(1)).dispatchEvent(new Event('error'))
    })
    expect(fileEl(1).hasAttribute('data-missing')).toBe(true)
    expect($$('img', rowEl(1))).toEqual([])
    expect(metaOf(1)).toBe('12 KB')
    expect(fileEl(2).hasAttribute('data-missing')).toBe(false)
    expect($$('img', rowEl(2))).toHaveLength(1)
  })

  it('TL-119 媒体地址解不出来（null）：画图标，不画 img', async () => {
    store.mediaUrl = () => null
    await show(result([entry(1, 'S1')]))
    expect($$('img', rowEl(1))).toEqual([])
    expect($$('svg', rowEl(1))).toHaveLength(1)
  })
})

describe('点一行', () => {
  it('TL-121 点图的行：看图层打开这一天的图（按行序，点中的那张）；点别的行：开那件的预览', async () => {
    await show(
      result([
        entry(1, 'S1', { at: at(11, 18, 11) }),
        entry(2, 'S1', { kind: 'pdf', at: at(11, 18, 10) }),
        entry(3, 'S1', { at: at(11, 18, 9) })
      ])
    )
    act(() => fileEl(3).click())
    expect(viewer).toHaveBeenCalledTimes(1)
    const [images, index] = viewer.mock.calls[0] as [Array<Record<string, unknown>>, number]
    expect(images.map((i) => i.path)).toEqual([`library:${ID(1)}`, `library:${ID(3)}`])
    expect(images.map((i) => i.name)).toEqual(['img-1.png', 'img-3.png'])
    expect(images[0]).toMatchObject({
      sessionId: 'library',
      mimeType: 'image/png',
      openPath: `library:${ID(1)}`
    })
    expect(index).toBe(1)
    expect(preview).not.toHaveBeenCalled()
    act(() => fileEl(2).click())
    expect(preview.mock.calls).toEqual([[`library:${ID(2)}`]])
    expect(viewer).toHaveBeenCalledTimes(1)
  })

  it('TL-121 不在了的图不进组：点它照旧请求预览（给出「文件不存在」）', async () => {
    await show(
      result([
        entry(1, 'S1', { at: at(11, 18, 11) }),
        entry(2, 'S1', { missing: true, at: at(11, 18, 10) }),
        entry(3, 'S1', { at: at(11, 18, 9) })
      ])
    )
    act(() => fileEl(2).click())
    expect(viewer).not.toHaveBeenCalled()
    expect(preview.mock.calls).toEqual([[`library:${ID(2)}`]])
    act(() => fileEl(3).click())
    const [images, index] = viewer.mock.calls[0] as [Array<Record<string, unknown>>, number]
    expect(images.map((i) => i.path)).toEqual([`library:${ID(1)}`, `library:${ID(3)}`])
    expect(index).toBe(1)
  })

  it('TL-155 一组是这一天的图：跨会话、含没有会话的，不带别的天', async () => {
    await show(
      result(
        [
          entry(1, 'S1', { at: at(11, 18, 11) }),
          entry(2, 'S2', { at: at(11, 18, 10) }),
          entry(3, null, { at: at(11, 18, 9) }),
          entry(4, 'S1', { at: at(11, 17, 12) }),
          entry(5, 'S2', { at: at(11, 17, 11) })
        ],
        { S1: { title: 'Trip plan' }, S2: { title: 'Other' } }
      )
    )
    act(() => fileEl(3).click())
    act(() => fileEl(4).click())
    const calls = viewer.mock.calls as Array<[Array<Record<string, unknown>>, number]>
    expect(calls.map(([images, index]) => [images.map((i) => i.path), index])).toEqual([
      [[1, 2, 3].map((n) => `library:${ID(n)}`), 2],
      [[4, 5].map((n) => `library:${ID(n)}`), 0]
    ])
  })

  it('TL-156 同一张图当天在两条会话里：组里只算一次，两行点开的是同一张', async () => {
    await show(
      result(
        [
          entry(9, 'S1', { at: at(11, 18, 12) }),
          entry(1, 'S1', { at: at(11, 18, 11) }),
          entry(1, 'S2', { at: at(11, 18, 10) }),
          entry(2, 'S2', { at: at(11, 18, 9) })
        ],
        { S1: { title: 'Trip plan' }, S2: { title: 'Other' } }
      )
    )
    act(() => $('[data-timeline-file]', rowEl(1, 'S1')).click())
    act(() => $('[data-timeline-file]', rowEl(1, 'S2')).click())
    act(() => fileEl(2).click())
    const calls = viewer.mock.calls as Array<[Array<Record<string, unknown>>, number]>
    const group = [9, 1, 2].map((n) => `library:${ID(n)}`)
    expect(calls.map(([images, index]) => [images.map((i) => i.path), index])).toEqual([
      [group, 1],
      [group, 1],
      [group, 2]
    ])
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

    timeline.mockResolvedValue(result([entry(2, 'S1', { at: at(11, 18, 10) }), entry(1, 'S1')]))
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
    await show(result([entry(1, 'S1', { at: at(11, 18, 10) }), entry(2, 'S1')]))
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

describe('专注模式（focusSessionId）', () => {
  const FADED_CLASSES = ['opacity-30', 'hover:opacity-100', 'focus-within:opacity-100']
  /** 三个淡化类：全在 → 'faded'，全不在 → 'none'，只在一部分 → 'partial'（不该出现） */
  const fadeOf = (el: Element): 'faded' | 'none' | 'partial' => {
    const classes = (el.getAttribute('class') ?? '').split(/\s+/)
    const present = FADED_CLASSES.filter((c) => classes.includes(c)).length
    return present === FADED_CLASSES.length ? 'faded' : present === 0 ? 'none' : 'partial'
  }
  /** 时间线里所有带 opacity-30 的元素 */
  const fadedEls = (): Element[] =>
    $$('[data-library-timeline] *').filter((el) =>
      (el.getAttribute('class') ?? '').split(/\s+/).includes('opacity-30')
    )
  const headings = (): HTMLElement[] => $$('[data-timeline-day] > h3')
  const rowsOf = (sessionId: string): HTMLElement[] =>
    $$('[data-timeline-row]').filter((r) => r.getAttribute('data-session') === sessionId)

  /** 今天：S1、S2、没有会话的一行；昨天：S1、S2 */
  const fixture = (): LibraryTimelineResult =>
    result(
      [
        entry(1, 'S1', { at: at(11, 18, 11) }),
        entry(2, 'S2', { name: 'beach-2.png', at: at(11, 18, 10) }),
        entry(3, null, { at: at(11, 18, 9) }),
        entry(4, 'S1', { at: at(11, 17, 11) }),
        entry(5, 'S2', { name: 'beach-5.png', at: at(11, 17, 10) })
      ],
      { S1: { title: 'Trip plan' }, S2: { title: 'Budget' } }
    )

  it.each<[string, LibraryTimelineProps]>([
    ['TL-135 不传', {}],
    ['TL-136 null', { focusSessionId: null }],
    ["TL-139 ''（当作不淡）", { focusSessionId: '' }]
  ])('%s：时间线里没有一处带 opacity-30', async (_label, props) => {
    await show(fixture(), props)
    expect(rowsOf('S1')).toHaveLength(2)
    expect(rowsOf('')).toHaveLength(1)
    expect(fadedEls()).toEqual([])
    for (const h of headings()) expect(fadeOf(h)).toBe('none')
    for (const r of $$('[data-timeline-row]')) expect(fadeOf(r)).toBe('none')
  })

  it('TL-137 给了 S1：每天抬头、S2 的行与没有会话的行都淡；S1 的行哪天都不淡', async () => {
    await show(fixture(), { focusSessionId: 'S1' })
    expect(headings()).toHaveLength(2)
    for (const h of headings()) expect(fadeOf(h)).toBe('faded')
    expect(rowsOf('S2')).toHaveLength(2)
    for (const r of rowsOf('S2')) expect(fadeOf(r)).toBe('faded')
    expect(fadeOf(rowsOf('')[0])).toBe('faded')
    expect(rowsOf('S1')).toHaveLength(2)
    for (const r of rowsOf('S1')) {
      // 不淡的行自己与祖先都没有被淡掉
      let node: Element | null = r
      while (node && !node.hasAttribute('data-library-timeline')) {
        expect(fadeOf(node)).toBe('none')
        node = node.parentElement
      }
    }
    // 过渡类常在，不是淡的标志
    expect(rowsOf('S1')[0].className.split(/\s+/)).toContain('transition-opacity')
  })

  it('TL-138 给了一个不在时间线里的会话：抬头与每一行都淡，不抛', async () => {
    await show(fixture(), { focusSessionId: 'GONE' })
    for (const h of headings()) expect(fadeOf(h)).toBe('faded')
    const rows = $$('[data-timeline-row]')
    expect(rows).toHaveLength(5)
    for (const r of rows) expect(fadeOf(r)).toBe('faded')
  })

  it('TL-141 S1 → S2 重渲染：淡跟着走', async () => {
    await show(fixture(), { focusSessionId: 'S1' })
    await mount({ focusSessionId: 'S2' })
    for (const r of rowsOf('S2')) expect(fadeOf(r)).toBe('none')
    for (const r of rowsOf('S1')) expect(fadeOf(r)).toBe('faded')
    expect(fadeOf(rowsOf('')[0])).toBe('faded')
    for (const h of headings()) expect(fadeOf(h)).toBe('faded')
  })
})

describe('行的右键菜单', () => {
  type Locate = (id: string) => Promise<LibraryFileLocation | null>

  let locate: ReturnType<typeof vi.fn<Locate>>
  let menu: ReturnType<typeof vi.fn<ContextMenuRenderer>>
  let copy: ReturnType<typeof vi.fn<(text: string) => void>>
  let openSession: ReturnType<typeof vi.fn<(id: string) => void>>
  let reveal: ReturnType<typeof vi.fn<(path: string) => void>>
  /** 菜单间谍下一次（及之后）回的那一项 */
  let pick: string | null

  const LOC = (n: number, over: Partial<LibraryFileLocation> = {}): LibraryFileLocation => ({
    path: `/files/item-${n}`,
    storage: 'linked',
    ...over
  })

  beforeEach(() => {
    pick = null
    locate = vi.fn<Locate>(async (id) => ({ path: `/files/${id}`, storage: 'linked' }))
    menu = vi.fn<ContextMenuRenderer>(async () => pick)
    copy = vi.fn()
    openSession = vi.fn()
    reveal = vi.fn()
    store.copyToClipboard = copy
    store.hostApi = { library: { timeline, locate } }
  })

  /** 等 locate → 菜单 → 动作这一串微任务走完 */
  const settle = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve()
    })
  }

  /** 挂在 ContextMenuProvider 里（`render` 是菜单间谍；传 null = 内置 DOM 菜单） */
  async function showWithMenu(
    r: LibraryTimelineResult,
    props: LibraryTimelineProps = { onOpenSession: openSession, onRevealPath: reveal },
    render: ContextMenuRenderer | null = menu
  ): Promise<void> {
    timeline.mockResolvedValue(r)
    act(() =>
      root.render(
        createElement(
          ContextMenuProvider as FunctionComponent<{ render?: ContextMenuRenderer }>,
          render ? { render } : {},
          createElement(LibraryTimeline, props)
        )
      )
    )
    await flush()
  }

  /** 在一个元素上发 contextmenu（不等后面的异步） */
  function fireMenu(el: Element, x = 30, y = 40): MouseEvent {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y
    })
    act(() => {
      el.dispatchEvent(event)
    })
    return event
  }

  async function rightClick(el: Element, x = 30, y = 40): Promise<MouseEvent> {
    const event = fireMenu(el, x, y)
    await settle()
    return event
  }

  /** 第 n 次弹出的菜单项 */
  const itemsOf = (call = 0): ContextMenuItem[] => menu.mock.calls[call][0]
  /** id 序列，分隔线写成 `|` */
  const shape = (items: ContextMenuItem[]): string[] =>
    items.map((i) => (i.type === 'separator' ? '|' : (i.id ?? '?')))
  const item = (items: ContextMenuItem[], id: string): ContextMenuItem => {
    const found = items.find((i) => i.id === id)
    if (!found) throw new Error(`no menu item ${id}`)
    return found
  }

  const doc = (n: number, sessionId: string | null = 'S1'): LibraryTimelineEntry =>
    entry(n, sessionId, { kind: 'pdf', relation: sessionId ? 'produced' : null })

  describe('哪些项', () => {
    it('TL-160 留在原位置的产物、会话在、两个回调都给：open, openSession | copyPath, reveal；四个标签；reveal 可用', async () => {
      locate.mockResolvedValue(LOC(1))
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))

      expect(menu).toHaveBeenCalledTimes(1)
      const items = itemsOf()
      expect(shape(items)).toEqual(['open', 'openSession', '|', 'copyPath', 'reveal'])
      expect(items.filter((i) => i.id).map((i) => i.label)).toEqual([
        'Open',
        'Open chat',
        'Copy path',
        'Show in folder'
      ])
      expect(item(items, 'reveal').enabled).not.toBe(false)
      expect(item(items, 'copyPath').enabled).not.toBe(false)
    })

    it('TL-161 文件不在了（missing）：同样四项，reveal 置灰、copyPath 仍可用', async () => {
      locate.mockResolvedValue(LOC(1, { missing: true }))
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))

      const items = itemsOf()
      expect(shape(items)).toEqual(['open', 'openSession', '|', 'copyPath', 'reveal'])
      expect(item(items, 'reveal').enabled).toBe(false)
      expect(item(items, 'copyPath').enabled).not.toBe(false)
    })

    it('TL-162 不给 onRevealPath：没有 reveal', async () => {
      await showWithMenu(result([doc(1)]), { onOpenSession: openSession })
      await rightClick(rowEl(1))
      expect(shape(itemsOf())).toEqual(['open', 'openSession', '|', 'copyPath'])
    })

    it('TL-163 不给 onOpenSession：没有 openSession（会话在也没有）', async () => {
      await showWithMenu(result([doc(1)]), { onRevealPath: reveal })
      await rightClick(rowEl(1))
      expect(shape(itemsOf())).toEqual(['open', '|', 'copyPath', 'reveal'])
    })

    it('TL-164 没有会话的行、会话已删的行：没有 openSession', async () => {
      await showWithMenu(
        result([doc(1, null), entry(2, 'GONE', { kind: 'pdf', at: at(11, 18, 8) })])
      )
      await rightClick(rowEl(1))
      await rightClick(rowEl(2))
      expect(shape(itemsOf(0))).toEqual(['open', '|', 'copyPath', 'reveal'])
      expect(shape(itemsOf(1))).toEqual(['open', '|', 'copyPath', 'reveal'])
    })

    it.each<[string, () => void]>([
      ['宿主没有 library.locate', () => (store.hostApi = { library: { timeline } })],
      ['locate 拒绝', () => locate.mockRejectedValue(new Error('offline'))],
      ['locate 回 null', () => locate.mockResolvedValue(null)],
      [
        'locate 同步抛',
        () =>
          locate.mockImplementation(() => {
            throw new Error('not connected')
          })
      ]
    ])('TL-165 取不到路径（%s）：恰好 open, openSession，没有分隔线', async (_l, arrange) => {
      arrange()
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(menu).toHaveBeenCalledTimes(1)
      expect(shape(itemsOf())).toEqual(['open', 'openSession'])
    })

    it('TL-165 既没有会话也取不到路径：恰好 [open]', async () => {
      locate.mockResolvedValue(null)
      await showWithMenu(result([doc(1, null)]))
      await rightClick(rowEl(1))
      expect(shape(itemsOf())).toEqual(['open'])
    })

    it.each<[string, unknown]>([
      ['null', null],
      ['没有 library', {}]
    ])('TL-166 弹菜单时宿主 api 是 %s：open（+ openSession），不抛', async (_l, api) => {
      await showWithMenu(result([doc(1)]))
      store.hostApi = api
      await rightClick(rowEl(1))
      expect(shape(itemsOf())).toEqual(['open', 'openSession'])
      expect(locate).not.toHaveBeenCalled()
    })

    it('取不到路径：过了 LOCATE_TIMEOUT_MS 还没答 → 不带路径那两项弹出；迟到的答复不再弹第二次', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 10, 18, 12, 0))
      const pending = deferred<LibraryFileLocation | null>()
      locate.mockReturnValue(pending.promise)
      await showWithMenu(result([doc(1)]))

      await rightClick(rowEl(1))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS - 1)
      })
      expect(menu).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      await settle()
      expect(menu).toHaveBeenCalledTimes(1)
      expect(shape(itemsOf())).toEqual(['open', 'openSession'])

      pending.resolve(LOC(1))
      await settle()
      expect(menu).toHaveBeenCalledTimes(1)
    })

    it('TL-167 locate 每次右键问一次、带这一行的 id；挂载、点击、library.changed 都不问；再右键再问（文件其间被删 → reveal 置灰）', async () => {
      await showWithMenu(result([doc(1), entry(2, 'S1', { kind: 'pdf', at: at(11, 18, 8) })]))
      expect(locate).not.toHaveBeenCalled()
      act(() => fileEl(1).click())
      await fireChanged()
      expect(locate).not.toHaveBeenCalled()

      locate.mockResolvedValueOnce(LOC(2))
      await rightClick(rowEl(2))
      expect(locate.mock.calls).toEqual([[ID(2)]])
      expect(item(itemsOf(0), 'reveal').enabled).not.toBe(false)

      locate.mockResolvedValueOnce(LOC(2, { missing: true }))
      await rightClick(rowEl(2))
      expect(locate.mock.calls).toEqual([[ID(2)], [ID(2)]])
      expect(item(itemsOf(1), 'reveal').enabled).toBe(false)
    })

    it('TL-168 渲染器收到事件的 { x: clientX, y: clientY }', async () => {
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1), 123, 456)
      expect(menu.mock.calls[0][1]).toEqual({ x: 123, y: 456 })
    })

    it('TL-169 contextmenu 当场 preventDefault、不再往外冒（locate 还没答）', async () => {
      const pending = deferred<LibraryFileLocation | null>()
      locate.mockReturnValue(pending.promise)
      await showWithMenu(result([doc(1)]))
      const outer = vi.fn()
      document.body.addEventListener('contextmenu', outer)
      try {
        const event = fireMenu(rowEl(1))
        expect(event.defaultPrevented).toBe(true)
        expect(outer).not.toHaveBeenCalled()
        expect(menu).not.toHaveBeenCalled()
      } finally {
        document.body.removeEventListener('contextmenu', outer)
        pending.resolve(null)
        await settle()
      }
    })

    it('TL-170 同一件在两条会话里的两行：各自的菜单打开各自的会话', async () => {
      pick = 'openSession'
      await showWithMenu(
        result(
          [
            entry(1, 'S1', { kind: 'pdf', at: at(11, 18, 11) }),
            entry(1, 'S2', { kind: 'pdf', at: at(11, 18, 10) })
          ],
          { S1: { title: 'Trip plan' }, S2: { title: 'Budget' } }
        )
      )
      await rightClick(rowEl(1, 'S2'))
      await rightClick(rowEl(1, 'S1'))
      expect(shape(itemsOf(0))).toContain('openSession')
      expect(shape(itemsOf(1))).toContain('openSession')
      expect(openSession.mock.calls).toEqual([['S2'], ['S1']])
    })

    it('TL-171 在行里的会话名按钮或小图上右键：弹的是这一行的菜单，不切会话、不开文件', async () => {
      await showWithMenu(result([entry(1, 'S1')]))
      await rightClick($('[data-timeline-open-session="S1"]', rowEl(1)))
      await rightClick($('img', rowEl(1)))

      expect(menu).toHaveBeenCalledTimes(2)
      expect(locate.mock.calls).toEqual([[ID(1)], [ID(1)]])
      expect(shape(itemsOf(1))).toEqual(['open', 'openSession', '|', 'copyPath', 'reveal'])
      expect(openSession).not.toHaveBeenCalled()
      expect(preview).not.toHaveBeenCalled()
      expect(viewer).not.toHaveBeenCalled()
    })
  })

  describe('每一项做什么', () => {
    const nothingElse = (
      except: 'preview' | 'viewer' | 'session' | 'copy' | 'reveal' | ''
    ): void => {
      if (except !== 'preview') expect(preview).not.toHaveBeenCalled()
      if (except !== 'viewer') expect(viewer).not.toHaveBeenCalled()
      if (except !== 'session') expect(openSession).not.toHaveBeenCalled()
      if (except !== 'copy') expect(copy).not.toHaveBeenCalled()
      if (except !== 'reveal') expect(reveal).not.toHaveBeenCalled()
    }

    it('TL-172 非图片行选 open：requestFilePreview(library:<id>) 一次，与点这一行相同；别的都不动', async () => {
      pick = 'open'
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(preview.mock.calls).toEqual([[`library:${ID(1)}`]])
      nothingElse('preview')

      act(() => fileEl(1).click())
      expect(preview.mock.calls[1]).toEqual(preview.mock.calls[0])
    })

    it('TL-173 图片行选 open：看图层，参数与点击完全一样；不在了的图 → requestFilePreview', async () => {
      pick = 'open'
      await showWithMenu(
        result([
          entry(1, 'S1', { at: at(11, 18, 11) }),
          entry(2, 'S1', { missing: true, at: at(11, 18, 10) }),
          entry(3, 'S1', { at: at(11, 18, 9) })
        ])
      )
      await rightClick(rowEl(3))
      act(() => fileEl(3).click())
      expect(viewer).toHaveBeenCalledTimes(2)
      expect(viewer.mock.calls[0]).toEqual(viewer.mock.calls[1])
      expect(viewer.mock.calls[0][1]).toBe(1)
      expect(preview).not.toHaveBeenCalled()

      await rightClick(rowEl(2))
      expect(preview.mock.calls).toEqual([[`library:${ID(2)}`]])
      expect(viewer).toHaveBeenCalledTimes(2)
    })

    it('TL-174 选 openSession：onOpenSession(会话) 一次；不开预览、不开看图层', async () => {
      pick = 'openSession'
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(openSession.mock.calls).toEqual([['S1']])
      nothingElse('session')
    })

    it.each<[string, Partial<LibraryFileLocation>]>([
      ['文件在', {}],
      ['文件不在了', { missing: true }]
    ])('TL-175 选 copyPath（%s）：copyToClipboard(那个路径) 一次；不 reveal', async (_l, over) => {
      pick = 'copyPath'
      locate.mockResolvedValue(LOC(1, over))
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(copy.mock.calls).toEqual([['/files/item-1']])
      nothingElse('copy')
    })

    it('TL-176 选 reveal：onRevealPath(那个路径) 一次；不碰剪贴板', async () => {
      pick = 'reveal'
      locate.mockResolvedValue(LOC(1))
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(reveal.mock.calls).toEqual([['/files/item-1']])
      nothingElse('reveal')
    })

    it('TL-177 渲染器不管 enabled、对不在了的文件回 reveal：onRevealPath 不调', async () => {
      pick = 'reveal'
      locate.mockResolvedValue(LOC(1, { missing: true }))
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(menu).toHaveBeenCalledTimes(1)
      nothingElse('')
    })

    it.each<[string, string | null]>([
      ['null（关掉了）', null],
      ['不认识的 id', 'delete']
    ])('TL-178 渲染器回 %s：什么都不做', async (_l, picked) => {
      pick = picked
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(menu).toHaveBeenCalledTimes(1)
      nothingElse('')
    })

    it('TL-179 路径是这一次菜单取的：A 关掉、B 选 copyPath → B 的路径', async () => {
      locate.mockImplementation(async (id) => ({ path: `/files/of/${id}`, storage: 'linked' }))
      await showWithMenu(result([doc(1), entry(2, 'S1', { kind: 'pdf', at: at(11, 18, 8) })]))
      pick = null
      await rightClick(rowEl(1))
      pick = 'copyPath'
      await rightClick(rowEl(2))
      expect(copy.mock.calls).toEqual([[`/files/of/${ID(2)}`]])
    })
  })

  describe('时序与生命周期', () => {
    it('TL-180 locate 还没答：渲染器没被调；答了之后调一次', async () => {
      const pending = deferred<LibraryFileLocation | null>()
      locate.mockReturnValue(pending.promise)
      await showWithMenu(result([doc(1)]))
      await rightClick(rowEl(1))
      expect(menu).not.toHaveBeenCalled()

      pending.resolve(LOC(1))
      await settle()
      expect(menu).toHaveBeenCalledTimes(1)
      expect(shape(itemsOf())).toEqual(['open', 'openSession', '|', 'copyPath', 'reveal'])
    })

    it('TL-181 locate 还没答组件就卸了：之后答复不抛、不告警', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const rejections: unknown[] = []
      const onRejection = (reason: unknown): void => void rejections.push(reason)
      process.on('unhandledRejection', onRejection)
      try {
        const pending = deferred<LibraryFileLocation | null>()
        locate.mockReturnValue(pending.promise)
        await showWithMenu(result([doc(1)]))
        await rightClick(rowEl(1))
        act(() => root.render(null))

        pending.resolve(LOC(1))
        await settle()
        await new Promise((resolve) => setImmediate(resolve))
        expect(rejections).toEqual([])
        expect(errors).not.toHaveBeenCalled()
        // 现状（记录，不是契约）：菜单的请求照样交给渲染器 —— 弹不弹由宿主的渲染器自己决定
        expect(menu.mock.calls.length).toBeLessThanOrEqual(1)
      } finally {
        process.off('unhandledRejection', onRejection)
        errors.mockRestore()
      }
    })

    it.each<[string, () => void]>([
      ['open', () => expect(preview.mock.calls).toEqual([[`library:${ID(1)}`]])],
      ['openSession', () => expect(openSession.mock.calls).toEqual([['S1']])]
    ])(
      'TL-182 菜单开着时重取把这一行拿掉了：选 %s 仍按开菜单时的那一件 / 会话',
      async (picked, verify) => {
        const choice = deferred<string | null>()
        menu.mockReturnValue(choice.promise)
        await showWithMenu(result([doc(1)]))
        await rightClick(rowEl(1))
        expect(menu).toHaveBeenCalledTimes(1)

        timeline.mockResolvedValue(result([], {}))
        await fireChanged()
        expect($$('[data-timeline-row]')).toEqual([])

        choice.resolve(picked)
        await settle()
        verify()
      }
    )

    it('TL-183 内置 DOM 菜单（Provider 不给 render）：四个标签；置灰的「Show in folder」点了没反应；点「Copy path」→ copyToClipboard', async () => {
      locate.mockResolvedValue(LOC(1, { missing: true }))
      await showWithMenu(
        result([doc(1)]),
        { onOpenSession: openSession, onRevealPath: reveal },
        null
      )
      expect(document.querySelector('[data-context-menu]')).toBeNull()
      await rightClick(rowEl(1))

      const panel = document.querySelector<HTMLElement>('[data-context-menu]')
      if (!panel) throw new Error('no context menu')
      const buttons = Array.from(panel.querySelectorAll('button'))
      expect(buttons.map((b) => b.textContent)).toEqual([
        'Open',
        'Open chat',
        'Copy path',
        'Show in folder'
      ])
      const byLabel = (label: string): HTMLButtonElement => {
        const b = buttons.find((x) => x.textContent === label)
        if (!b) throw new Error(`no button ${label}`)
        return b
      }

      act(() => byLabel('Show in folder').click())
      await settle()
      expect(reveal).not.toHaveBeenCalled()
      expect(document.querySelector('[data-context-menu]')).not.toBeNull()

      act(() => byLabel('Copy path').click())
      await settle()
      expect(copy.mock.calls).toEqual([['/files/item-1']])
      expect(reveal).not.toHaveBeenCalled()
      expect(document.querySelector('[data-context-menu]')).toBeNull()
    })

    it('TL-184 没有 ContextMenuProvider：右键什么都不做、不抛', async () => {
      await show(result([doc(1)]), { onOpenSession: openSession, onRevealPath: reveal })
      const event = fireMenu(rowEl(1))
      await settle()
      expect(event.defaultPrevented).toBe(true)
      expect(menu).not.toHaveBeenCalled()
      expect(document.querySelector('[data-context-menu]')).toBeNull()
      expect(preview).not.toHaveBeenCalled()
      expect(openSession).not.toHaveBeenCalled()
      expect(copy).not.toHaveBeenCalled()
      expect(reveal).not.toHaveBeenCalled()
    })
  })
})
