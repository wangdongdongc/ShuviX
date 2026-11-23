// @vitest-environment jsdom
/**
 * 文本类产物的画幅 `ArtifactTextFrame`（jsdom，直接挂组件）。
 *
 *   F-1..3   纯函数：artifactTextKind / countLines / prettyJson
 *   F-4..10  csv：表格、行列说明、画幅里最多 40 行、千分位、表头短于数据、空表与只有表头、不画幅时 1000 行 + 说明、分号文件
 *   F-11..12 md：渲染成正文；里面的 ```artifact / ```interactive 只按代码
 *   F-13..14 json：排好缩进、解析不了原样、复制复制原文；超长先排后截（framed=false 整份）
 *   F-15     txt：等宽，「N 行」，中文界面
 *   F-16..19 打开：说明行的打开键、点画幅（有选区时不算）、没有路径、framed=false
 *   F-20     复制：对勾 2 秒后复原、提前卸载干净
 *   F-21..22 溢出渐隐、高度上限（touch 收一点）
 *   F-23     说明行：名字与 extras（紧跟规模）
 *
 * 剪贴板桩掉；`requestFilePreview` 换成记录器；溢出靠给 HTMLElement 原型桩 scrollHeight / clientHeight。
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
import { ArtifactTextFrame, artifactTextKind, countLines, prettyJson } from '../ArtifactFrame'

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

  it('F-5 画幅里最多 40 行，说明行照写总数，没有「只显示前」', () => {
    show({ name: 'd.csv', content: csvOf(100) })
    expect(bodyRows()).toBe(40)
    expect(size()).toBe('100 rows × 2 columns')
    expect(container.textContent).not.toContain('Showing the first')
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

  it('F-14 超长：先排后截到 8000；framed=false 整份', () => {
    const content = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item-${i}`, tags: ['x', 'y'] }))
    )
    expect(content.length).toBeGreaterThan(8000)
    const pretty = prettyJson(content)
    show({ name: 'd.json', content })
    const shown = q('pre')!.textContent!
    expect(shown.length).toBe(8000)
    expect(shown).toBe(pretty.slice(0, 8000))
    expect(shown.startsWith('[\n  {\n    "id": 0')).toBe(true)

    show({ name: 'd.json', content, framed: false })
    expect(q('pre')!.textContent).toBe(pretty)
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
    show({ name: 'a.txt', content: 'a\nb\nc', path: '/abs/a.txt' })
    expect(size()).toBe('3 行')
    expect(q('[data-artifact-open]')?.textContent).toBe(zh.message.artifactOpen)

    show({ name: 'd.csv', content: 'h\n1' })
    expect(size()).toBe('1 行 × 1 列')
  })
})

describe('打开', () => {
  it('F-16 说明行的打开键 → requestFilePreview(path) 一次', () => {
    show({ name: 'x.csv', content: 'a\n1', path: '/abs/x.csv' })
    const btn = q<HTMLButtonElement>('[data-artifact-open]')!
    expect(btn.title).toBe(en.message.artifactOpenHint)
    expect(btn.textContent).toBe(en.message.artifactOpen)
    click(btn)
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenCalledWith('/abs/x.csv')
  })

  it('F-17 点画幅：没有选区 → 打开；有选区 → 不动', () => {
    show({ name: 'x.txt', content: 'hello', path: '/abs/x.txt' })
    expect(frame().className).toContain('cursor-pointer')
    const sel = vi.spyOn(window, 'getSelection')
    sel.mockReturnValue({ toString: () => '' } as unknown as Selection)
    click(q('pre')!)
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenLastCalledWith('/abs/x.txt')

    sel.mockReturnValue({ toString: () => 'hel' } as unknown as Selection)
    click(q('pre')!)
    expect(preview).toHaveBeenCalledTimes(1)
  })

  it('F-18 没有路径：没有打开键、不是指针、点了不动，复制还在', () => {
    show({ name: 'x.txt', content: 'hello' })
    expect(q('[data-artifact-open]')).toBeNull()
    expect(frame().className).not.toContain('cursor-pointer')
    click(frame())
    expect(preview).not.toHaveBeenCalled()
    expect(q('[data-artifact-copy]')).not.toBeNull()
  })

  it('F-19 framed=false：打开键照常，点正文不动，没有高度上限', () => {
    show({ name: 'x.txt', content: 'hello', path: '/abs/x.txt', framed: false })
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

describe('高度', () => {
  function stubHeights(scroll: number, client: number): void {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scroll)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(client)
  }

  it('F-21 溢出 → 渐隐 + data-overflowing；等高 → 没有；framed=false → 从不', () => {
    stubHeights(500, 240)
    show({ name: 'x.txt', content: 'long' })
    expect(q('[data-artifact-fade]')).not.toBeNull()
    expect(frame().hasAttribute('data-overflowing')).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    vi.restoreAllMocks()
    stubHeights(240, 240)
    show({ name: 'x.txt', content: 'short' })
    expect(q('[data-artifact-fade]')).toBeNull()
    expect(frame().hasAttribute('data-overflowing')).toBe(false)

    act(() => root.unmount())
    root = createRoot(container)
    vi.restoreAllMocks()
    stubHeights(500, 240)
    show({ name: 'x.txt', content: 'long', framed: false })
    expect(q('[data-artifact-fade]')).toBeNull()
    expect(frame().hasAttribute('data-overflowing')).toBe(false)
  })

  it('F-22 上限 240px，touch 200px', () => {
    show({ name: 'x.txt', content: 'a' })
    expect(frame().style.maxHeight).toBe('240px')
    act(() => root.unmount())
    root = createRoot(container)
    show({ name: 'x.txt', content: 'a', touch: true })
    expect(frame().style.maxHeight).toBe('200px')
  })
})

describe('说明行', () => {
  it('F-23 名字进说明行，extras 紧跟规模', () => {
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
    expect(extra.previousElementSibling?.hasAttribute('data-artifact-size')).toBe(true)
  })
})
