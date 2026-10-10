/**
 * 笔记本里一张图 → 导出面板认的图源（notebookFigureSource）—— node，纯分派。
 *
 * 这一层只决定「笔记本里的图怎么取色、垫什么底」，真正的烘焙 / 补尺寸在 chat-ui（那边有自己的
 * DOM 测试），渲染在 atomic-editor —— 所以两边都桩掉，只看这里把什么参数交了出去：
 *
 *   - ```svg（NFS-1）：走对话手写图那同一条烘焙路径，底色取**页面**那一层，字体从放图那一格抄；
 *   - ```mermaid（NFS-2…8）：笔记本的 mermaid 是 mermaid 自己的 `default` 主题铺在白卡上，所以
 *     「当前主题」与「浅色」都是屏幕上那张白底图，「深色」换 mermaid 的 `dark` 主题配它自己的
 *     #333333 底；面板按 ShuviX 主题解析出来的 themeId 一律不往下传（那样「当前」就不是屏幕上那张了）。
 *
 * `mermaidTitleOf` 用真的（经相对路径直取 chat-ui 的纯逻辑模块），文件名规则只有一份。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shuvix/atomic-editor', () => ({ renderMermaid: vi.fn() }))
vi.mock('@shuvix/chat-ui', async () => {
  const pure = await import('../../../chat-ui/src/components/figure/figureExportPure')
  return {
    authoredFigureSource: vi.fn(),
    standaloneSvg: vi.fn(),
    mermaidTitleOf: pure.mermaidTitleOf
  }
})

import { renderMermaid, type FigureExportRequest } from '@shuvix/atomic-editor'
import { authoredFigureSource, standaloneSvg } from '@shuvix/chat-ui'
import { NOTEBOOK_MERMAID_BACKGROUND, notebookFigureSource } from './notebookFigureSource'

const render = vi.mocked(renderMermaid)
const authored = vi.mocked(authoredFigureSource)
const standalone = vi.mocked(standaloneSvg)

/** node 里没有 DOM：anchor / figure 只需要带上被读的那一项 */
function request(kind: 'svg' | 'mermaid', code: string, figureHtml = ''): FigureExportRequest {
  return {
    kind,
    code,
    anchor: { tag: 'anchor' } as unknown as HTMLElement,
    figure: { innerHTML: figureHtml, tag: 'figure' } as unknown as HTMLElement
  }
}

const STANDALONE = { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', width: 10, height: 20 }

beforeEach(() => {
  render.mockReset()
  render.mockResolvedValue({ svg: '<svg id="nb-mermaid"/>' })
  authored.mockReset()
  standalone.mockReset()
  standalone.mockReturnValue(STANDALONE)
})

describe('```svg', () => {
  it('NFS-1 交给 authoredFigureSource：屏幕上那份净化过的标记、底色取页面、字体从放图那一格抄', () => {
    const sentinel = { name: 'x', build: vi.fn() }
    authored.mockReturnValue(sentinel)
    const req = request('svg', '<svg>raw source</svg>', '<svg aria-label="sanitized">…</svg>')
    const source = notebookFigureSource(req)
    expect(source).toBe(sentinel)
    expect(authored).toHaveBeenCalledTimes(1)
    const [markup, opts] = authored.mock.calls[0]
    // 交出去的是屏幕上那一格里的东西，不是围栏源码
    expect(markup).toBe('<svg aria-label="sanitized">…</svg>')
    expect(opts.surface).toBe('page')
    expect(opts.name).toBeUndefined()
    expect(opts.inheritFrom?.()).toBe(req.figure)
    expect(render).not.toHaveBeenCalled()
  })
})

describe('```mermaid', () => {
  const CODE = 'graph TD\n  nfs1 --> nfs2'

  it('NFS-2 当前主题：mermaid default 主题、白底；不挂 ShuviX 主题', async () => {
    const source = notebookFigureSource(request('mermaid', CODE))
    const out = await source.build({ scheme: 'current', themeId: 'nord', background: true })
    expect(render).toHaveBeenCalledWith(CODE, { theme: 'default' })
    expect(standalone).toHaveBeenCalledWith('<svg id="nb-mermaid"/>', {
      themeId: '',
      background: '#ffffff'
    })
    expect(out).toBe(STANDALONE)
  })

  it('NFS-3 浅色与当前主题一样（都是屏幕上那张白底图）', async () => {
    const source = notebookFigureSource(request('mermaid', CODE))
    await source.build({ scheme: 'light', themeId: 'solarized-light', background: true })
    expect(render).toHaveBeenCalledWith(CODE, { theme: 'default' })
    expect(standalone).toHaveBeenCalledWith(expect.any(String), {
      themeId: '',
      background: '#ffffff'
    })
  })

  it('NFS-4 深色：mermaid dark 主题，配它自己的 #333333 底', async () => {
    const source = notebookFigureSource(request('mermaid', CODE))
    await source.build({ scheme: 'dark', themeId: 'github-dark', background: true })
    expect(render).toHaveBeenCalledWith(CODE, { theme: 'dark' })
    expect(standalone).toHaveBeenCalledWith(expect.any(String), {
      themeId: '',
      background: '#333333'
    })
    expect(NOTEBOOK_MERMAID_BACKGROUND).toEqual({ default: '#ffffff', dark: '#333333' })
  })

  it.each(['current', 'light', 'dark'] as const)(
    'NFS-5 不要底色（%s）→ background null',
    async (scheme) => {
      const source = notebookFigureSource(request('mermaid', CODE))
      await source.build({ scheme, themeId: 'x', background: false })
      expect(standalone).toHaveBeenCalledWith(expect.any(String), {
        themeId: '',
        background: null
      })
    }
  )

  it('NFS-6 渲染失败：带着 mermaid 的错误拒绝；没有错误文案就用缺省的', async () => {
    const source = notebookFigureSource(request('mermaid', CODE))
    render.mockResolvedValueOnce({ error: 'Parse error on line 2' })
    await expect(
      source.build({ scheme: 'current', themeId: '', background: true })
    ).rejects.toThrow('Parse error on line 2')
    render.mockResolvedValueOnce({})
    await expect(
      source.build({ scheme: 'current', themeId: '', background: true })
    ).rejects.toThrow('Mermaid render failed')
    expect(standalone).not.toHaveBeenCalled()
  })

  it('NFS-7 名字：源码里写的标题，没有就是 mermaid', () => {
    expect(notebookFigureSource(request('mermaid', CODE)).name).toBe('mermaid')
    expect(
      notebookFigureSource(request('mermaid', '---\ntitle: Flow\n---\ngraph LR\n  a --> b')).name
    ).toBe('Flow')
    expect(
      notebookFigureSource(request('mermaid', 'gantt\n  title Release plan\n  section A')).name
    ).toBe('Release plan')
  })

  it('NFS-8 面板给的 themeId 一概不往 mermaid 那边传', async () => {
    const source = notebookFigureSource(request('mermaid', CODE))
    for (const scheme of ['current', 'light', 'dark'] as const) {
      await source.build({ scheme, themeId: 'catppuccin-mocha', background: true })
    }
    for (const call of render.mock.calls) {
      expect(call[1]).toEqual({ theme: expect.stringMatching(/^(default|dark)$/) })
    }
    for (const call of standalone.mock.calls) expect(call[1].themeId).toBe('')
    expect(JSON.stringify([render.mock.calls, standalone.mock.calls])).not.toContain(
      'catppuccin-mocha'
    )
  })
})
