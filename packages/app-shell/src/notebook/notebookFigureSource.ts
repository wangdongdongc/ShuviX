/**
 * 笔记本里一张图 → 导出面板认的图源。面板是 chat-ui 那一个（与对话图卡共用），这里只决定
 * 「笔记本里的图该怎么取色、垫什么底」：
 *
 * - ```svg：与对话里的手写图同一条烘焙路径（`authoredFigureSource`），底色取**页面**那一层 ——
 *   笔记本里的图直接画在编辑器底色上，不像对话那样坐在一张卡片里。
 * - ```mermaid：笔记本的 mermaid 是 mermaid 自己的 `default` 主题、铺在白底卡片上（见
 *   atomic-editor 的 mermaid-blocks），所以「当前主题」与「浅色」都是屏幕上那张白底图；
 *   「深色」用 mermaid 的 `dark` 主题重渲。它不走对话那套按 ShuviX 主题取色的渲染 —— 那样
 *   「当前主题」导出来就不是屏幕上看到的那张了。
 */
import {
  authoredFigureSource,
  mermaidTitleOf,
  standaloneSvg,
  type FigureExportSource
} from '@shuvix/chat-ui'
import { renderMermaid, type FigureExportRequest, type MermaidTheme } from '@shuvix/atomic-editor'

/**
 * 两种 mermaid 主题的底色：`default` 是笔记本卡片的白底（inline-preview.css 的
 * `.cm-atomic-mermaid-diagram`），`dark` 是 mermaid 深色主题自己的 background。
 */
export const NOTEBOOK_MERMAID_BACKGROUND: Record<MermaidTheme, string> = {
  default: '#ffffff',
  dark: '#333333'
}

export function notebookFigureSource(req: FigureExportRequest): FigureExportSource {
  if (req.kind === 'svg') {
    // figure 里就是屏幕上那份净化过的 <svg>（导出按钮挂在外层 wrap 上，不在这一格里）
    return authoredFigureSource(req.figure.innerHTML, {
      surface: 'page',
      inheritFrom: () => req.figure
    })
  }
  return {
    name: mermaidTitleOf(req.code) ?? 'mermaid',
    build: async ({ scheme, background }) => {
      const theme: MermaidTheme = scheme === 'dark' ? 'dark' : 'default'
      const res = await renderMermaid(req.code, { theme })
      if (!res.svg) throw new Error(res.error ?? 'Mermaid render failed')
      return standaloneSvg(res.svg, {
        themeId: '',
        background: background ? NOTEBOOK_MERMAID_BACKGROUND[theme] : null
      })
    }
  }
}
