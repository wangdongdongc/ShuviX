/**
 * 笔记本里一张图 → 导出面板认的图源。面板是 chat-ui 那一个（与对话图卡共用），这里只决定
 * 「笔记本里的图垫什么底、叫什么名字」：
 *
 * ```svg 与 ```mermaid 都是 token 着色的图（mermaid 由 pele 渲染，颜色经 themes.css 的 `.pele`
 * 接到主题 token 上），所以两者走对话里手写图的同一条烘焙路径（`authoredFigureSource`），底色取
 * **页面**那一层 —— 笔记本里的图直接画在编辑器底色上，不像对话那样坐在一张卡片里。
 */
import {
  authoredFigureSource,
  figureLabelOf,
  mermaidTitleOf,
  type FigureExportSource
} from '@shuvix/chat-ui'
import type { FigureExportRequest } from '@shuvix/atomic-editor'

export function notebookFigureSource(req: FigureExportRequest): FigureExportSource {
  // figure 里就是屏幕上那份净化过的 <svg>（导出按钮挂在外层 wrap 上，不在这一格里）
  const markup = req.figure.innerHTML
  return authoredFigureSource(markup, {
    // mermaid 的名字：源码里写的标题 → 图自己的名字（accTitle）→ 「mermaid」，与对话图卡同一条；
    // ```svg 交给 authoredFigureSource 读图自己的名字
    name:
      req.kind === 'mermaid'
        ? (mermaidTitleOf(req.code) ?? figureLabelOf(markup) ?? 'mermaid')
        : null,
    surface: 'page',
    inheritFrom: () => req.figure
  })
}
