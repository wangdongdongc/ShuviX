// @vitest-environment jsdom
/**
 * 文本类产物的画幅 `ArtifactTextFrame`（jsdom，直接挂组件）。
 *
 *   F-1..3   纯函数：artifactTextKind / countLines / prettyJson
 *   F-4..10  csv：表格、行列说明、收起最多 40 行、千分位、表头短于数据、空表与只有表头、不画幅时 1000 行 + 说明、分号文件
 *   F-11..12 md：渲染成正文；里面的 ```artifact / ```interactive 只按代码；源码切换
 *   F-13..14 json：排好缩进、解析不了原样、复制复制原文；收起先排后截 8000、展开 50000、framed=false 整份
 *   F-15     txt：等宽，「N 行」，中文界面
 *   F-16..19 打开与原地展开：说明行的打开键、未溢出不可点、溢出点画幅原地展开（选区/链接不触发、展开后点内容不误收起）、无路径仍可原地展开、framed=false
 *   F-20     复制：对勾 2 秒后复原、提前卸载干净
 *   F-21..22 溢出渐隐、横向溢出可展开、收起与展开高度上限（touch 收一点）
 *   F-23     说明行：名字与 extras（紧跟规模）
 *   F-24..25 源码切换（csv / md 有，json / txt 无）与 stateKey 跨重挂载保持状态
 *
 * 剪贴板桩掉；`requestFilePreview` 换成记录器；溢出靠给 HTMLElement 原型桩 scrollHeight / clientHeight / scrollWidth / clientWidth。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'

const clip = vi.hoisted(() => ({ copy: vi.fn() }))
vi.mock('../../../utils/clipboard', () => ({ copyToClipboard: clip.copy }))

import { setChatApi } from '../../../api/chatApi'
import { ChatHostProvider } from '../../../host/ChatHost'
import type { ChatHostValue } from '../../../host/chatHostContext'
import { useChatStore } from '../../../stores/chatStore'
import {
  ARTIFACT_EXPANDED_MAX_HEIGHT,
  ARTIFACT_EXPANDED_MAX_HEIGHT_TOUCH,
  ArtifactTextFrame,
  artifactTextKind,
  countLines,
  EXPANDED_TEXT_CHARS,
  prettyJson
} from '../ArtifactFrame'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const read = vi.fn(async () => null)
const API = {
  artifact: { read, list: async () => [] },
  events: { subscribe: () => () => {} }
} as unknown as ChatApi

const HOST: ChatHostValue = {
  appearance: { theme: 'light', darkTheme: 'd', lightTheme: 'l', fontSize: 14, focusMode: false },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  },
  interactiveFigures: true
}
const HostProvider = ChatHostProvider as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

type FrameProps = Parameters<typeof ArtifactTextFrame>[0]

let container: HTMLDivElement
let root: Root
const preview = vi.fn<(p: string) => void>()
const originalPreview = useChatStore.getState().requestFilePreview

function show(props: FrameProps, host: ChatHostValue = HOST): void {
  act(() => {
    root.render(
      createElement(HostProvider, { value: host }, createElement(ArtifactTextFrame, props))
    )
  })
}

const q = <T extends Element = HTMLElement>(sel: string): T | null =>
  container.querySelector<T>(sel)
const frame = (): HTMLElement => q('[data-artifact-frame]')!
const size = (): string => q('[data-artifact-size]')?.textContent ?? ''
const bodyRows = (): number => container.querySelectorAll('[data-artifact-table] tbody tr').length
const headCells = (): string[] =>
  [...container.querySelectorAll('[data-artifact-table] thead th')].map(
    (th) => th.textContent ?? ''
  )

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function stubHeights(scroll: number, client: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scroll)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(client)
}

function stubWidths(scroll: number, client: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client)
}

/** n 条数据行（加一行表头） */
const csvOf = (n: number): string =>
  ['h1,h2', ...Array.from({ length: n }, (_, i) => `${i},${i * 2}`)].join('\n')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh } },
    showSupportNotice: false
  })
  setChatApi(API)
})

beforeEach(() => {
  clip.copy.mockReset()
  read.mockClear()
  preview.mockReset()
  useChatStore.setState({ requestFilePreview: preview })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  useChatStore.setState({ requestFilePreview: originalPreview })
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('纯函数', () => {
  it('F-1 artifactTextKind 按扩展名', () => {
    expect(artifactTextKind('a.CSV')).toBe('csv')
    expect(artifactTextKind('a.md')).toBe('markdown')
    expect(artifactTextKind('a.markdown')).toBe('markdown')
    expect(artifactTextKind('a.json')).toBe('json')
    expect(artifactTextKind('a.txt')).toBe('text')
    expect(artifactTextKind('noext')).toBe('text')
    expect(artifactTextKind('a.')).toBe('text')
  })

  it('F-2 countLines', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\r\nb\rc')).toBe(3)
    expect(countLines('\n')).toBe(1)
  })

  it('F-3 prettyJson', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('{"a":')).toBe('{"a":')
    expect(prettyJson('  "x" ')).toBe('"x"')
  })
})

describe('csv', () => {
  it('F-4 表格 + 行 × 列', () => {
    show({ name: 'd.csv', content: 'h1,h2\n1,2\n3,4' })
    expect(frame().getAttribute('data-artifact-frame')).toBe('csv')
    expect(q('table[data-artifact-table]')).not.toBeNull()
    expect(headCells()).toEqual(['h1', 'h2'])
    expect(bodyRows()).toBe(2)
    expect(size()).toBe('2 rows × 2 columns')
  })

  it('F-5 收起画幅最多 40 行；点画幅原地展开到最多 1000 行，超过 1000 行给截断说明', () => {
    show({ name: 'd.csv', content: csvOf(100) })
    expect(bodyRows()).toBe(40)
    expect(size()).toBe('100 rows × 2 columns')
    expect(container.textContent).not.toContain('Showing the first')
    expect(q('[data-artifact-expand]')?.getAttribute('aria-expanded')).toBe('false')

    click(frame())
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(true)
    expect(bodyRows()).toBe(100)
    expect(q('[data-artifact-expand]')?.getAttribute('aria-expanded')).toBe('true')

    act(() => root.unmount())
    root = createRoot(container)
    show({ name: 'd.csv', content: csvOf(1500) })
    click(frame())
    expect(bodyRows()).toBe(1000)
    expect(container.textContent).toContain('Showing the first 1000 rows')
  })

  it('F-6 千分位', () => {
    show({ name: 'd.csv', content: csvOf(1234) })
    expect(size()).toBe('1,234 rows × 2 columns')
  })

  it('F-7 表头短于数据：列数按最宽的行', () => {
    show({ name: 'd.csv', content: 'a\n1,2,3' })
    expect(headCells()).toEqual(['a', '', ''])
  })

  it('F-8 空表与只有表头', () => {
    show({ name: 'd.csv', content: '' })
    expect(q('[data-artifact-table]')).toBeNull()
    expect(frame().textContent).toBe(en.message.artifactEmpty)
    expect(size()).toBe('0 rows × 0 columns')

    show({ name: 'd.csv', content: 'a,b' })
    expect(headCells()).toEqual(['a', 'b'])
    expect(bodyRows()).toBe(0)
    expect(size()).toBe('0 rows × 2 columns')
  })

  it('F-9 framed=false：最多 1000 行 + 说明；正好 1000 行没有说明', () => {
    show({ name: 'd.csv', content: csvOf(1500), framed: false })
    expect(bodyRows()).toBe(1000)
    expect(container.textContent).toContain('Showing the first 1000 rows')

    show({ name: 'd.csv', content: csvOf(1000), framed: false })
    expect(bodyRows()).toBe(1000)
    expect(container.textContent).not.toContain('Showing the first')
  })

  it('F-10 分号文件拆成两列', () => {
    show({ name: 'd.csv', content: 'a;b\n1;2' })
    expect(headCells()).toEqual(['a', 'b'])
    expect([...container.querySelectorAll('tbody td')].map((td) => td.textContent)).toEqual([
      '1',
      '2'
    ])
  })
})

describe('markdown', () => {
  it('F-11 渲染成正文', () => {
    show({ name: 'n.md', content: '# Title\n\nbody **bold**' })
    expect(frame().getAttribute('data-artifact-frame')).toBe('markdown')
    expect(q('.markdown-body h1')?.textContent).toBe('Title')
    expect(q('.markdown-body strong')?.textContent).toBe('bold')
    expect(size()).toBe('3 lines')
  })

  it('F-12 画幅里的 ```artifact 与 ```interactive 只按代码', async () => {
    show({
      name: 'n.md',
      content: '```artifact\nother.csv\n```\n\n```interactive\n<div id="x">hello-box</div>\n```\n'
    })
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    }
    expect(read).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[data-artifact-frame]')).toHaveLength(1)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[data-interactive-figure]')).toBeNull()
    expect(frame().textContent).toContain('other.csv')
    expect(frame().textContent).toContain('hello-box')
  })
})

describe('json', () => {
  it('F-13 排好缩进 / 解析不了原样 / 复制原文', () => {
    show({ name: 'd.json', content: '{"a":1,"b":[2]}' })
    expect(frame().getAttribute('data-artifact-frame')).toBe('json')
    expect(q('pre')?.textContent).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}')
    click(q('[data-artifact-copy]')!)
    expect(clip.copy).toHaveBeenCalledWith('{"a":1,"b":[2]}')

    show({ name: 'd.json', content: '{"a": broken' })
    expect(q('pre')?.textContent).toBe('{"a": broken')
  })

  it('F-14 超长：收起截到 8000；原地展开放宽到 50000（超了给提示）；framed=false 整份', () => {
    const content = JSON.stringify(
      Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `item-${i}`, tags: ['x', 'y'] }))
    )
    const pretty = prettyJson(content)
    expect(pretty.length).toBeGreaterThan(EXPANDED_TEXT_CHARS)

    show({ name: 'd.json', content })
    const collapsedShown = q('pre')!.textContent!
    expect(collapsedShown.length).toBe(8000)
    expect(collapsedShown).toBe(pretty.slice(0, 8000))
    expect(q('[data-artifact-capped]')).toBeNull()

    click(frame())
    expect(q('pre')!.textContent!.length).toBe(EXPANDED_TEXT_CHARS)
    expect(q('[data-artifact-capped]')?.textContent).toContain('50,000')

    act(() => root.unmount())
    root = createRoot(container)
    show({ name: 'd.json', content, framed: false })
    expect(q('pre')!.textContent).toBe(pretty)
    expect(q('[data-artifact-capped]')).toBeNull()
  })
})

describe('text', () => {
  it('F-15 等宽文本，「N 行」；中文界面', async () => {
    show({ name: 'a.txt', content: 'only' })
    expect(frame().getAttribute('data-artifact-frame')).toBe('text')
    expect(q('pre')?.className).toContain('font-mono')
    expect(q('pre')?.textContent).toBe('only')
    expect(size()).toBe('1 line')

    show({ name: 'a.txt', content: 'a\nb\nc' })
    expect(size()).toBe('3 lines')

    await act(async () => {
      await i18n.changeLanguage('zh')
    })
    stubHeights(500, 240)
    show({ name: 'a.txt', content: 'a\nb\nc\nd', path: '/abs/a.txt' })
    expect(size()).toBe('4 行')
    expect(q('[data-artifact-open]')?.textContent).toBe(zh.message.artifactOpen)
    expect(q('[data-artifact-expand]')?.textContent).toBe(zh.message.diagramUnfold)
    expect(q('[data-artifact-source]')).toBeNull()
    show({ name: 'n.md', content: '# 标题' })
    expect(q('[data-artifact-source]')?.textContent).toBe(zh.message.source)

    show({ name: 'd.csv', content: 'h\n1' })
    expect(size()).toBe('1 行 × 1 列')
  })
})

describe('原地展开与独立窗口打开', () => {
  it('F-16 说明行的打开键 → requestFilePreview(path) 一次；短内容画幅本身不可点', () => {
    show({ name: 'x.csv', content: 'a\n1', path: '/abs/x.csv' })
    expect(frame().className).not.toContain('cursor-pointer')
    expect(q('[data-artifact-expand]')).toBeNull()
    click(frame())
    expect(preview).not.toHaveBeenCalled()

    const btn = q<HTMLButtonElement>('[data-artifact-open]')!
    expect(btn.title).toBe(en.message.artifactOpenHint)
    expect(btn.textContent).toBe(en.message.artifactOpen)
    click(btn)
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenCalledWith('/abs/x.csv')
  })

  it('F-17 溢出画幅：有选区或点链接不触发；普通点击原地展开（不弹新窗），展开后点内容不误收起，点收起键还原', () => {
    stubHeights(500, 240)
    show({ name: 'x.md', content: 'hello [docs](#section)', path: '/abs/x.md' })
    expect(frame().className).toContain('cursor-pointer')

    const sel = vi.spyOn(window, 'getSelection')
    sel.mockReturnValue({ toString: () => 'hel' } as unknown as Selection)
    click(frame())
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(false)

    sel.mockReturnValue({ toString: () => '' } as unknown as Selection)
    const link = q('a')!
    link.addEventListener('click', (e) => e.preventDefault())
    click(link)
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(false)

    click(frame())
    expect(preview).not.toHaveBeenCalled()
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(true)
    expect(frame().style.maxHeight).toBe(ARTIFACT_EXPANDED_MAX_HEIGHT)
    expect(q('[data-artifact-body]')?.className).toContain('overflow-auto')
    expect(frame().className).not.toContain('cursor-pointer')
    expect(q('[data-artifact-fade]')).toBeNull()
    // 展开态下底栏动作常驻（没有 opacity-0）
    expect(q('[data-figure-actions]')?.className).not.toContain('opacity-0')

    // 展开后在内容里点击不会把它收回去
    click(frame())
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(true)

    // 点底栏「收起」还原
    click(q('[data-artifact-expand]')!)
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(false)
    expect(frame().style.maxHeight).toBe('240px')
  })

  it('F-18 没有路径但溢出的画幅：没有打开键，仍可原地展开阅读全文，复制也在', () => {
    stubHeights(500, 240)
    show({ name: 'x.txt', content: 'pinned old content' })
    expect(q('[data-artifact-open]')).toBeNull()
    expect(frame().className).toContain('cursor-pointer')
    click(frame())
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(true)
    expect(preview).not.toHaveBeenCalled()
    expect(q('[data-artifact-copy]')).not.toBeNull()
  })

  it('F-19 framed=false：打开键照常，没有展开键，点正文不动，没有高度上限', () => {
    stubHeights(500, 240)
    show({ name: 'x.txt', content: 'hello', path: '/abs/x.txt', framed: false })
    expect(q('[data-artifact-expand]')).toBeNull()
    click(frame())
    expect(preview).not.toHaveBeenCalled()
    expect(frame().className).not.toContain('cursor-pointer')
    expect(frame().style.maxHeight).toBe('')
    click(q('[data-artifact-open]')!)
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenCalledWith('/abs/x.txt')
  })
})

describe('复制', () => {
  it('F-20 复制 → 对勾，2 秒后复原；提前卸载干净', () => {
    vi.useFakeTimers()
    show({ name: 'x.txt', content: 'payload' })
    const btn = q('[data-artifact-copy]')!
    expect(btn.querySelector('.lucide-copy')).not.toBeNull()
    click(btn)
    expect(clip.copy).toHaveBeenCalledWith('payload')
    expect(btn.querySelector('.lucide-check')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(btn.querySelector('.lucide-check')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(btn.querySelector('.lucide-check')).toBeNull()
    expect(btn.querySelector('.lucide-copy')).not.toBeNull()

    // 复制后不到 2 秒就卸载：计时器清掉，不再 setState
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    click(q('[data-artifact-copy]')!)
    act(() => root.unmount())
    root = createRoot(container)
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('高度与溢出', () => {
  it('F-21 纵向溢出 → 渐隐 + 可展开；仅横向溢出（宽矮表）→ 无纵向渐隐但仍可展开；等高 → 都无；framed=false → 从不', () => {
    stubHeights(500, 240)
    show({ name: 'x.txt', content: 'long' })
    expect(q('[data-artifact-fade]')).not.toBeNull()
    expect(frame().hasAttribute('data-overflowing')).toBe(true)
    expect(q('[data-artifact-expand]')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    vi.restoreAllMocks()
    stubHeights(120, 120)
    stubWidths(900, 500)
    show({ name: 'wide.csv', content: 'a,b,c\n1,2,3' })
    expect(q('[data-artifact-fade]')).toBeNull()
    expect(frame().hasAttribute('data-overflowing')).toBe(false)
    expect(q('[data-artifact-expand]')).not.toBeNull()
    expect(frame().className).toContain('cursor-pointer')

    act(() => root.unmount())
    root = createRoot(container)
    vi.restoreAllMocks()
    stubHeights(240, 240)
    stubWidths(400, 400)
    show({ name: 'x.txt', content: 'short' })
    expect(q('[data-artifact-fade]')).toBeNull()
    expect(frame().hasAttribute('data-overflowing')).toBe(false)
    expect(q('[data-artifact-expand]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    vi.restoreAllMocks()
    stubHeights(500, 240)
    show({ name: 'x.txt', content: 'long', framed: false })
    expect(q('[data-artifact-fade]')).toBeNull()
    expect(frame().hasAttribute('data-overflowing')).toBe(false)
    expect(q('[data-artifact-expand]')).toBeNull()
  })

  it('F-22 收起上限 240px（touch 200px），展开上限 min(65vh, 560px)（touch min(60vh, 480px)）', () => {
    stubHeights(500, 240)
    show({ name: 'x.txt', content: 'a' })
    expect(frame().style.maxHeight).toBe('240px')
    click(frame())
    expect(frame().style.maxHeight).toBe(ARTIFACT_EXPANDED_MAX_HEIGHT)

    act(() => root.unmount())
    root = createRoot(container)
    stubHeights(500, 200)
    show({ name: 'x.txt', content: 'a', touch: true })
    expect(frame().style.maxHeight).toBe('200px')
    click(frame())
    expect(frame().style.maxHeight).toBe(ARTIFACT_EXPANDED_MAX_HEIGHT_TOUCH)
  })
})

describe('说明行、源码切换与状态保持', () => {
  it('F-23 名字与 extras 常驻说明行，规模（行数/行列）归入右侧操作区随按钮一起自动隐藏', () => {
    show({
      name: 'x.csv',
      content: 'a\n1',
      label: 'My table',
      extras: createElement('span', { 'data-test-extra': '' }, 'Newer')
    })
    const caption = q('[data-figure-caption]')!
    expect(caption.querySelector('[data-figure-label]')?.textContent).toBe('My table')
    const extra = caption.querySelector('[data-test-extra]')!
    expect(extra).not.toBeNull()
    const actions = caption.querySelector('[data-figure-actions]')!
    expect(actions.className).toContain('opacity-0')
    expect(actions.contains(extra)).toBe(false)
    expect(actions.firstElementChild?.hasAttribute('data-artifact-size')).toBe(true)
  })

  it('F-24 csv 与 markdown 可切源码（源码态常驻说明行）；json 与 txt 不出源码键', () => {
    show({ name: 't.csv', content: 'h1,h2\n1,2' })
    const srcBtn = q<HTMLButtonElement>('[data-artifact-source]')!
    expect(srcBtn.textContent).toBe(en.message.source)
    click(srcBtn)
    expect(q('[data-artifact-table]')).toBeNull()
    expect(q('pre')?.textContent).toBe('h1,h2\n1,2')
    expect(q('[data-artifact-source]')?.textContent).toBe(en.message.artifactPreview)
    expect(q('[data-figure-actions]')?.className).not.toContain('opacity-0')
    click(q('[data-artifact-source]')!)
    expect(q('[data-artifact-table]')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    show({ name: 'n.md', content: '# Heading' })
    expect(q('.markdown-body h1')?.textContent).toBe('Heading')
    click(q('[data-artifact-source]')!)
    expect(q('.markdown-body')).toBeNull()
    expect(q('pre')?.textContent).toBe('# Heading')

    act(() => root.unmount())
    root = createRoot(container)
    show({ name: 'a.json', content: '{"x":1}' })
    expect(q('[data-artifact-source]')).toBeNull()
    show({ name: 'a.txt', content: 'plain' })
    expect(q('[data-artifact-source]')).toBeNull()
  })

  it('F-25 stateKey：卸载重挂载后保留展开与源码视图状态', () => {
    show({ name: 'd.csv', content: csvOf(60), stateKey: 'msg-1\u0000d.csv' })
    click(frame())
    click(q('[data-artifact-source]')!)
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(true)
    expect(q('pre')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    show({ name: 'd.csv', content: csvOf(60), stateKey: 'msg-1\u0000d.csv' })
    expect(frame().hasAttribute('data-artifact-expanded')).toBe(true)
    expect(q('pre')).not.toBeNull()
  })

  it('F-26 在 [data-virtuoso-scroller] 中收起时钉住画幅顶边位置，抵消虚拟列表滚动偏移且不调用 scrollIntoView', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const scroller = document.createElement('div')
    scroller.setAttribute('data-virtuoso-scroller', '')
    scroller.scrollTop = 1000
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 700,
      left: 0,
      right: 800,
      width: 800,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    container.appendChild(scroller)
    const innerRoot = createRoot(scroller)

    try {
      act(() => {
        innerRoot.render(
          createElement(
            HostProvider,
            { value: HOST },
            createElement(ArtifactTextFrame, { name: 'd.csv', content: csvOf(80) })
          )
        )
      })
      const shell = scroller.querySelector<HTMLElement>('[data-figure-block="artifact"]')!
      // 初始顶边在视口 y=150 处；模拟收起后 Virtuoso 向上滚动补偿把 scrollTop 减掉 320（导致顶边掉到 y=470）
      let shellTop = 150
      vi.spyOn(shell, 'getBoundingClientRect').mockImplementation(() => ({
        top: shellTop,
        bottom: shellTop + 240,
        left: 0,
        right: 700,
        width: 700,
        height: 240,
        x: 0,
        y: shellTop,
        toJSON: () => ({})
      }))

      click(scroller.querySelector('[data-artifact-frame]')!)
      // 模拟收起前 Virtuoso 把卡片往下推了 320px（scroller.scrollTop 从 1000 掉到 680，shellTop 变成 470）
      scroller.scrollTop = 680
      const origScrollTopDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
      let currentScrollTop = 680
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => currentScrollTop,
        set: (v: number) => {
          const diff = v - currentScrollTop
          currentScrollTop = v
          shellTop -= diff
        }
      })

      // 收起前在 y=150：React 根（scroller）先在冒泡阶段记下锚点 y=150，外层 container 紧接模拟收起引起的位置偏移（掉到 y=470）
      shellTop = 150
      currentScrollTop = 1000
      const simulateVirtuosoJump = (): void => {
        currentScrollTop = 680
        shellTop = 470
      }
      container.addEventListener('click', simulateVirtuosoJump, { once: true })
      click(scroller.querySelector<HTMLElement>('[data-artifact-expand]')!)

      // 布局补偿立刻把 scrollTop 加回 320（680 → 1000），画幅顶边稳在 y=150
      expect(currentScrollTop).toBe(1000)
      expect(shellTop).toBe(150)

      // 展开后滚到顶边出视口（y=-80），收起时落回距顶 12px 处
      click(scroller.querySelector('[data-artifact-frame]')!)
      shellTop = -80
      currentScrollTop = 1230
      click(scroller.querySelector<HTMLElement>('[data-artifact-expand]')!)
      expect(shellTop).toBe(12)
      expect(currentScrollTop).toBe(1138)
      expect(scrollIntoView).not.toHaveBeenCalled()
      if (origScrollTopDesc) Object.defineProperty(scroller, 'scrollTop', origScrollTopDesc)
    } finally {
      act(() => innerRoot.unmount())
    }
  })

  it('F-27 展开框内滚到末尾或中段后收起：保留收起前底部的那一块内容，切换顶部/底部渐隐，再次展开也接回原位', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.closest('[data-artifact-frame]')?.hasAttribute('data-artifact-expanded')
        ? 560
        : 240
    })

    show({ name: 'd.csv', content: csvOf(100) })
    const body = (): HTMLElement => q('[data-artifact-body]')!
    // 初始收起在顶部：只有底部渐隐，无顶部渐隐，表格仅渲染前 40 行
    expect(q('[data-artifact-fade-top]')).toBeNull()
    expect(q('[data-artifact-fade]')).not.toBeNull()
    expect(bodyRows()).toBe(40)

    // 展开并滚到最末尾（[640 .. 1200]）
    click(frame())
    expect(bodyRows()).toBe(100)
    body().scrollTop = 640
    act(() => {
      body().dispatchEvent(new Event('scroll'))
    })

    // 收起回 240px：保留末尾 [960 .. 1200]，100 行不裁回 40 行，顶部渐隐出现、底部渐隐消失
    click(q('[data-artifact-expand]')!)
    expect(body().scrollTop).toBe(960)
    expect(bodyRows()).toBe(100)
    expect(q('[data-artifact-fade-top]')).not.toBeNull()
    expect(q('[data-artifact-fade]')).toBeNull()

    // 从末尾收起态再次点画幅展开：底边不动，接回 [640 .. 1200]
    click(frame())
    expect(body().scrollTop).toBe(640)

    // 滚到中段（[200 .. 760]）再收起：保留 [520 .. 760]，上下渐隐同时出现
    body().scrollTop = 200
    click(q('[data-artifact-expand]')!)
    expect(body().scrollTop).toBe(520)
    expect(q('[data-artifact-fade-top]')).not.toBeNull()
    expect(q('[data-artifact-fade]')).not.toBeNull()

    // 展开滚回顶部（0）再收起：恢复初始态（顶部无渐隐、底部有渐隐，表格回 40 行）
    click(frame())
    body().scrollTop = 0
    click(q('[data-artifact-expand]')!)
    expect(body().scrollTop).toBe(0)
    expect(bodyRows()).toBe(40)
    expect(q('[data-artifact-fade-top]')).toBeNull()
    expect(q('[data-artifact-fade]')).not.toBeNull()
  })
})
