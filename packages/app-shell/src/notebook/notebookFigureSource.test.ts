/**
 * 笔记本里一张图 → 导出面板认的图源（notebookFigureSource）—— node，纯分派。
 *
 * 这一层只决定「笔记本里的图垫什么底、叫什么名字」，真正的烘焙在 chat-ui（那边有自己的 DOM
 * 测试）—— 所以把它桩掉，只看这里把什么参数交了出去：
 *
 *   - ```svg（NFS-1）与 ```mermaid（NFS-2）走**同一条**手写图烘焙路径：2026-10-17 起笔记本的
 *     mermaid 由 pele 渲染、颜色是 token（themes.css 的 `.pele`），不再是 mermaid.js 那张白底卡片，
 *     于是不再按主题重渲、也没有写死的白 / #333333 底（NFS-4）。交出去的都是**屏幕上那一格**里净化过
 *     的标记，底色取**页面**那一层，字体从放图那一格抄；
 *   - 名字（NFS-3）：mermaid 取源码里的 title → 图自己的名字 → 「mermaid」；svg 交给烘焙层自己读。
 *
 * `mermaidTitleOf` 用真的（经相对路径直取 chat-ui 的纯逻辑模块），文件名规则只有一份；
 * `figureLabelOf` 要 DOM，桩掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shuvix/chat-ui', async () => {
  const pure = await import('../../../chat-ui/src/components/figure/figureExportPure')
  return {
    authoredFigureSource: vi.fn(),
    figureLabelOf: vi.fn(),
    mermaidTitleOf: pure.mermaidTitleOf
  }
})

import type { FigureExportRequest } from '@shuvix/atomic-editor'
import { authoredFigureSource, figureLabelOf } from '@shuvix/chat-ui'
import * as notebookFigureSourceModule from './notebookFigureSource'
import { notebookFigureSource } from './notebookFigureSource'

const authored = vi.mocked(authoredFigureSource)
const labelOf = vi.mocked(figureLabelOf)

/** node 里没有 DOM：anchor / figure 只需要带上被读的那一项 */
function request(kind: 'svg' | 'mermaid', code: string, figureHtml = ''): FigureExportRequest {
  return {
    kind,
    code,
    anchor: { tag: 'anchor' } as unknown as HTMLElement,
    figure: { innerHTML: figureHtml, tag: 'figure' } as unknown as HTMLElement
  }
}

const sentinel = (): ReturnType<typeof authoredFigureSource> => ({ name: 'x', build: vi.fn() })

beforeEach(() => {
  authored.mockReset()
  labelOf.mockReset()
  labelOf.mockReturnValue(null)
})

describe('```svg', () => {
  it('NFS-1 交给 authoredFigureSource：屏幕上那份净化过的标记、名字留给烘焙层读、底色取页面、字体从放图那一格抄', () => {
    const s = sentinel()
    authored.mockReturnValue(s)
    // 源码里写了 title: 也不算 —— 那是 mermaid 的 frontmatter 规矩，svg 的名字由图自己说
    const req = request(
      'svg',
      '---\ntitle: Not a name\n---\n<svg>raw</svg>',
      '<svg aria-label="sanitized">…</svg>'
    )
    expect(notebookFigureSource(req)).toBe(s)
    expect(authored).toHaveBeenCalledTimes(1)
    const [markup, opts] = authored.mock.calls[0]
    expect(markup).toBe('<svg aria-label="sanitized">…</svg>')
    expect(opts).toEqual({ name: null, surface: 'page', inheritFrom: expect.any(Function) })
    expect(opts.inheritFrom?.()).toBe(req.figure)
  })
})

describe('```mermaid', () => {
  it('NFS-2 同一条路径：交出去的是屏幕上那一格的标记（不是源码），底色取页面，字体从那一格抄', () => {
    const s = sentinel()
    authored.mockReturnValue(s)
    const req = request(
      'mermaid',
      'graph TD\n  nfs2a --> nfs2b',
      '<svg class="pele">on screen</svg>'
    )
    expect(notebookFigureSource(req)).toBe(s)
    expect(authored).toHaveBeenCalledTimes(1)
    const [markup, opts] = authored.mock.calls[0]
    expect(markup).toBe('<svg class="pele">on screen</svg>')
    expect(opts.surface).toBe('page')
    expect(opts.inheritFrom?.()).toBe(req.figure)
  })

  it('NFS-3 名字：源码里的 title → 图自己的名字（accTitle 之类）→ 「mermaid」', () => {
    notebookFigureSource(
      request('mermaid', '---\ntitle: Flow\n---\ngraph TD\n  a --> b', '<svg>t</svg>')
    )
    expect(authored.mock.calls[0][1].name).toBe('Flow')
    expect(labelOf).not.toHaveBeenCalled()

    labelOf.mockReturnValue('Acc')
    notebookFigureSource(request('mermaid', 'graph TD\n  a --> b', '<svg>acc</svg>'))
    expect(labelOf).toHaveBeenCalledWith('<svg>acc</svg>')
    expect(authored.mock.calls[1][1].name).toBe('Acc')

    labelOf.mockReturnValue(null)
    notebookFigureSource(request('mermaid', 'graph TD\n  a --> b', '<svg>none</svg>'))
    expect(authored.mock.calls[2][1].name).toBe('mermaid')
  })

  it('NFS-4 不再有 mermaid.js 时代的写死底色导出（NOTEBOOK_MERMAID_BACKGROUND）', () => {
    expect('NOTEBOOK_MERMAID_BACKGROUND' in notebookFigureSourceModule).toBe(false)
  })
})
