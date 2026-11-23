// @vitest-environment jsdom
/**
 * 文件预览窗口里 `.csv` 的表格视图（FilePreview + CsvTableView，jsdom）。
 *
 *   P-1 `.csv` 文本缺省是表格：说明「N rows × M columns」、表头、行号；顶栏的源码键（csvSourceToggle）；
 *       wrap / 行号开关不出
 *   P-2 源码键切到 CodeView 再切回；源码模式下 wrap / 行号开关出现
 *   P-3 正好 20 MB → 表格；多 1 字节 → 直接 CodeView，没有源码键
 *   P-4 空 csv → sheetEmpty
 *   P-5 回归：.md 的源码键（markdownSourceToggle）照旧；.txt 没有源码键；.tsv 不是表格
 *   P-6 源码模式开关 md 与 csv 共用、换文件不复位（钉住现状）
 *
 * 会话渠道 API 是假的（files.read 按路径回包，watch / unwatch / events.subscribe 空转）；TableVirtuoso 换成把
 * 表头与全部数据行直接画出来的桩；CodeView 与笔记本编辑器换成记号。文件是 `.ts`（app-shell 的单测只收
 * `*.test.ts`），一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'

vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  return {
    TableVirtuoso: (props: {
      data: string[][]
      fixedHeaderContent: () => ReactNode
      itemContent: (i: number, row: string[]) => ReactNode
    }) =>
      React.createElement(
        'table',
        { 'data-virtuoso-stub': '' },
        React.createElement('thead', null, props.fixedHeaderContent()),
        React.createElement(
          'tbody',
          null,
          props.data.map((row, i) =>
            React.createElement('tr', { key: i }, props.itemContent(i, row))
          )
        )
      )
  }
})

vi.mock('@shuvix/chat-ui', async (importOriginal) => {
  const React = await import('react')
  const orig = await importOriginal<typeof import('@shuvix/chat-ui')>()
  return {
    ...orig,
    CodeView: (props: { content: string; ext: string }) =>
      React.createElement('div', { 'data-code-view': props.ext }, props.content)
  }
})

vi.mock('../notebook/LivePreviewEditor', async () => {
  const React = await import('react')
  return {
    LivePreviewEditor: (props: { initialContent: string }) =>
      React.createElement('div', { 'data-md-view': '' }, props.initialContent)
  }
})

import { setSessionChannelApi } from '@shuvix/chat-ui'
import { FilePreview } from './FilePreview'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MB20 = 20 * 1024 * 1024
const files = new Map<string, FileReadResult>()

const textFile = (
  path: string,
  ext: string,
  content: string,
  size = content.length
): FileReadResult => ({ kind: 'text', path, ext, size, content }) as unknown as FileReadResult

const API = {
  files: {
    read: async ({ path }: { path: string }) => files.get(path)!,
    watch: async () => {},
    unwatch: async () => {}
  },
  events: { subscribe: () => () => {} }
} as unknown as SessionChannelApi

let container: HTMLDivElement
let root: Root

async function show(path: string): Promise<void> {
  act(() => {
    root.render(createElement(FilePreview, { path, sessionId: 's1' }))
  })
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

const q = <T extends Element = HTMLElement>(sel: string): T | null =>
  container.querySelector<T>(sel)
const sourceToggle = (): HTMLButtonElement | null =>
  q<HTMLButtonElement>('[data-preview-source-toggle]')
const byTitle = (title: string): HTMLButtonElement | null =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.title === title) ??
  null
const wrapToggle = (): HTMLButtonElement | null => byTitle(en.panel.preview.wrapToggle)
const lineToggle = (): HTMLButtonElement | null => byTitle(en.panel.preview.lineNumbersToggle)
const csvTable = (): HTMLElement | null => q('[data-csv-table]')
const codeView = (): HTMLElement | null => q('[data-code-view]')

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  setSessionChannelApi(API)
})

beforeEach(() => {
  files.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('csv 表格视图', () => {
  it('P-1 缺省是表格：说明、表头、行号、源码键；没有 wrap / 行号开关', async () => {
    files.set('/w/d.csv', textFile('/w/d.csv', '.csv', 'a,b\n1,2\n3,4', 100))
    await show('/w/d.csv')
    const table = csvTable()
    expect(table).not.toBeNull()
    expect(codeView()).toBeNull()
    expect(table!.textContent).toContain('2 rows × 2 columns')
    const heads = [...table!.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(heads).toEqual(['', 'a', 'b'])
    const rowNums = [...table!.querySelectorAll('tbody tr')].map(
      (tr) => tr.querySelector('td')?.textContent
    )
    expect(rowNums).toEqual(['1', '2'])
    expect(sourceToggle()?.title).toBe(en.panel.preview.csvSourceToggle)
    expect(sourceToggle()?.title).toBe('View source')
    expect(wrapToggle()).toBeNull()
    expect(lineToggle()).toBeNull()
  })

  it('P-2 源码键切到 CodeView 再切回；源码模式下出 wrap / 行号开关', async () => {
    files.set('/w/d.csv', textFile('/w/d.csv', '.csv', 'a,b\n1,2', 100))
    await show('/w/d.csv')
    click(sourceToggle()!)
    expect(csvTable()).toBeNull()
    expect(codeView()?.getAttribute('data-code-view')).toBe('.csv')
    expect(codeView()?.textContent).toBe('a,b\n1,2')
    expect(wrapToggle()).not.toBeNull()
    expect(lineToggle()).not.toBeNull()

    click(sourceToggle()!)
    expect(csvTable()).not.toBeNull()
    expect(codeView()).toBeNull()
    expect(wrapToggle()).toBeNull()
  })

  it('P-3 正好 20 MB → 表格；多 1 字节 → 直接 CodeView、没有源码键', async () => {
    files.set('/w/a.csv', textFile('/w/a.csv', '.csv', 'a,b\n1,2', MB20))
    await show('/w/a.csv')
    expect(csvTable()).not.toBeNull()
    expect(sourceToggle()).not.toBeNull()

    files.set('/w/b.csv', textFile('/w/b.csv', '.csv', 'a,b\n1,2', MB20 + 1))
    await show('/w/b.csv')
    expect(csvTable()).toBeNull()
    expect(codeView()).not.toBeNull()
    expect(sourceToggle()).toBeNull()
    expect(wrapToggle()).not.toBeNull()
  })

  it('P-4 空 csv → sheetEmpty', async () => {
    files.set('/w/e.csv', textFile('/w/e.csv', '.csv', '', 0))
    await show('/w/e.csv')
    expect(container.textContent).toContain(en.panel.preview.sheetEmpty)
    expect(q('[data-virtuoso-stub]')).toBeNull()
  })
})

describe('回归', () => {
  it('P-5 .md 的源码键照旧；.txt 没有源码键；.tsv 不是表格', async () => {
    files.set('/w/n.md', textFile('/w/n.md', '.md', '# hi'))
    await show('/w/n.md')
    expect(q('[data-md-view]')).not.toBeNull()
    expect(sourceToggle()?.title).toBe(en.panel.preview.markdownSourceToggle)
    expect(wrapToggle()).toBeNull()
    click(sourceToggle()!)
    expect(codeView()?.getAttribute('data-code-view')).toBe('.md')

    act(() => root.unmount())
    root = createRoot(container)
    files.set('/w/a.txt', textFile('/w/a.txt', '.txt', 'plain'))
    await show('/w/a.txt')
    expect(sourceToggle()).toBeNull()
    expect(codeView()).not.toBeNull()
    expect(wrapToggle()).not.toBeNull()

    files.set('/w/t.tsv', textFile('/w/t.tsv', '.tsv', 'a\tb\n1\t2'))
    await show('/w/t.tsv')
    expect(csvTable()).toBeNull()
    expect(sourceToggle()).toBeNull()
    expect(codeView()?.getAttribute('data-code-view')).toBe('.tsv')
  })

  it('P-6 源码模式开关 md 与 csv 共用、换文件不复位（现状）', async () => {
    files.set('/w/n.md', textFile('/w/n.md', '.md', '# hi'))
    files.set('/w/d.csv', textFile('/w/d.csv', '.csv', 'a,b\n1,2'))
    await show('/w/n.md')
    click(sourceToggle()!)
    expect(codeView()).not.toBeNull()

    // 换到 csv：源码模式还开着
    await show('/w/d.csv')
    expect(csvTable()).toBeNull()
    expect(codeView()?.getAttribute('data-code-view')).toBe('.csv')
    expect(sourceToggle()?.title).toBe(en.panel.preview.csvSourceToggle)

    // 在 csv 上关掉，再回 md：也关着
    click(sourceToggle()!)
    expect(csvTable()).not.toBeNull()
    await show('/w/n.md')
    expect(q('[data-md-view]')).not.toBeNull()
    expect(codeView()).toBeNull()
  })
})
