import { EditorView, keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'

/**
 * 笔记本右键菜单的 markdown 编辑命令 —— 直接操作 CM6 文档（纯 markdown 源）。
 * actionId 形如 'fmt.bold' / 'para.h2' / 'insert.table'。
 */

/** 包裹主选区（加粗/倾斜等行内格式）；空选区则插入标记并把光标放中间 */
function wrap(view: EditorView, before: string, after: string = before): void {
  const sel = view.state.selection.main
  const text = view.state.sliceDoc(sel.from, sel.to)
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: before + text + after },
    selection: text
      ? { anchor: sel.from + before.length, head: sel.from + before.length + text.length }
      : { anchor: sel.from + before.length },
    scrollIntoView: true
  })
  view.focus()
}

/** 去掉选区文本中的行内格式标记 */
function clearInlineFormat(view: EditorView): void {
  const sel = view.state.selection.main
  if (sel.empty) return
  const text = view.state.sliceDoc(sel.from, sel.to).replace(/(\*\*|__|~~|==|`|\*|_)/g, '')
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from, head: sel.from + text.length },
    scrollIntoView: true
  })
  view.focus()
}

/** 逐行变换（标题/列表/引用）：对选区覆盖的每一行套用 fn(行文本, 行序号) */
function transformLines(view: EditorView, fn: (lineText: string, index: number) => string): void {
  const { state } = view
  const sel = state.selection.main
  const startLine = state.doc.lineAt(sel.from).number
  const endLine = state.doc.lineAt(sel.to).number
  const changes: { from: number; to: number; insert: string }[] = []
  let index = 0
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n)
    const next = fn(line.text, index++)
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }
  if (changes.length) view.dispatch({ changes, scrollIntoView: true })
  view.focus()
}

/** 去掉行首的块级标记（标题/引用/列表/任务），用于切换块类型时避免叠加 */
function stripBlockPrefix(text: string): string {
  return text.replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/, '')
}

/** 仅去掉行首的列表/任务标记（保留标题等其他场景） */
function stripListPrefix(text: string): string {
  return text.replace(/^\s*([-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/, '')
}

/** 在光标处插入块内容；若选区非空则替换，cursorBack 表示插入后光标回退的字符数 */
function insertBlock(view: EditorView, text: string, cursorBack = 0): void {
  const sel = view.state.selection.main
  const pos = sel.from + text.length - cursorBack
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: pos },
    scrollIntoView: true
  })
  view.focus()
}

const TABLE = '\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n'
const CODE_BLOCK = '\n```\n\n```\n'

/** 执行一个右键菜单命令 */
export function runMarkdownCommand(view: EditorView, id: string): void {
  // 文本格式
  if (id === 'fmt.bold') return wrap(view, '**')
  if (id === 'fmt.italic') return wrap(view, '*')
  if (id === 'fmt.strike') return wrap(view, '~~')
  if (id === 'fmt.highlight') return wrap(view, '==')
  if (id === 'fmt.code') return wrap(view, '`')
  if (id === 'fmt.clear') return clearInlineFormat(view)

  // 段落设置
  if (id === 'para.ul') return transformLines(view, (t) => `- ${stripListPrefix(t)}`)
  if (id === 'para.ol') return transformLines(view, (t, i) => `${i + 1}. ${stripListPrefix(t)}`)
  if (id === 'para.task') return transformLines(view, (t) => `- [ ] ${stripListPrefix(t)}`)
  if (id === 'para.body') return transformLines(view, (t) => stripBlockPrefix(t))
  if (id === 'para.quote') return transformLines(view, (t) => `> ${t}`)
  const heading = id.match(/^para\.h([1-6])$/)
  if (heading) {
    const level = Number(heading[1])
    return transformLines(view, (t) => `${'#'.repeat(level)} ${stripBlockPrefix(t)}`)
  }

  // 插入
  if (id === 'insert.table') return insertBlock(view, TABLE, 5) // 光标落在第一个单元格
  if (id === 'insert.hr') return insertBlock(view, '\n---\n')
  if (id === 'insert.code') return insertBlock(view, CODE_BLOCK, 4) // 光标落在围栏中间
}

/** 把一个命令包成 CM6 keymap 处理器 */
function bind(id: string): (view: EditorView) => boolean {
  return (view) => {
    runMarkdownCommand(view, id)
    return true
  }
}

/**
 * markdown 通用快捷键（与 Typora / GitHub 等约定对齐，避开 CM 默认的撤销/全选等）。
 * 通过编辑器 extensions 注入；Prec.high 保证优先于内置 keymap。
 */
export const markdownKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Mod-b', run: bind('fmt.bold') },
    { key: 'Mod-i', run: bind('fmt.italic') },
    { key: 'Mod-e', run: bind('fmt.code') },
    { key: 'Mod-Shift-x', run: bind('fmt.strike') },
    { key: 'Mod-Shift-h', run: bind('fmt.highlight') },
    { key: 'Mod-1', run: bind('para.h1') },
    { key: 'Mod-2', run: bind('para.h2') },
    { key: 'Mod-3', run: bind('para.h3') },
    { key: 'Mod-4', run: bind('para.h4') },
    { key: 'Mod-5', run: bind('para.h5') },
    { key: 'Mod-6', run: bind('para.h6') },
    { key: 'Mod-0', run: bind('para.body') }
  ])
)
