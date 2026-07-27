/**
 * CodeView — FilePreview 中 text/非-markdown 文件的渲染器
 *
 * 实现：裸 CodeMirror 6 read-only viewer。
 *
 * 设计要点：
 *   - **read-only**：`EditorState.readOnly` 阻止文档修改；`EditorView.editable=false`
 *     去掉 contenteditable，避免 IME 误触。`tabindex=0` 让查找面板可聚焦。
 *   - **Compartment 热切换**：wrap / 行号 / 语言 / 主题 都用 Compartment 包裹，
 *     toggle 通过 `dispatch(reconfigure)` 完成，不重建 EditorView、不丢滚动位置。
 *   - **懒加载语言**：扩展名 → 动态 import()，结果缓存。reqId ref 防快速切文件
 *     时旧 promise 异步覆盖新文件的语言。
 *   - **主题桥**：背景/字体/token 颜色全部从 `var(--theme-*)` 和 `var(--cm-tok-*)`
 *     CSS 变量取，浏览器 paint 时解析。data-theme 切换无需重建；唯一需要
 *     reconfigure 的是 CM 的 `dark: bool` flag（设 color-scheme），由 MutationObserver
 *     检测 data-theme attr 变化触发。
 *   - **Ctrl-F / Cmd-F 搜索**：searchKeymap 内置；面板样式在 codeMirrorTheme.ts 主题化。
 */

import { useEffect, useMemo, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers as cmLineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { loadLanguage } from './languageLoader'
import { buildCmTheme } from './codeMirrorTheme'

interface CodeViewProps {
  content: string
  ext: string
  wrap: boolean
  lineNumbers: boolean
  /**
   * 内嵌模式最大高度（CSS 长度）：编辑器随内容自然长高，超出后内部滚动。
   * 不传则维持撑满父容器（h-full，FilePreview 全屏预览用法）。
   */
  maxHeight?: string
}

export function CodeView({
  content,
  ext,
  wrap,
  lineNumbers,
  maxHeight
}: CodeViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 防御快速切文件：每次 content/ext 变更 ++，loadLanguage 回调时比对是否仍是当前请求
  const reqIdRef = useRef(0)

  // 每个 Compartment 对应一组可热切换的 extension —— 必须在组件生命周期内稳定
  const themeC = useMemo(() => new Compartment(), [])
  const wrapC = useMemo(() => new Compartment(), [])
  const gutterC = useMemo(() => new Compartment(), [])
  const languageC = useMemo(() => new Compartment(), [])

  // 构造一组完整的 extensions —— mount 初次 + content/ext 切换重建 doc 时都用
  // 闭包捕获当前 wrap/lineNumbers 状态，所以切换 toggle 时是单独 dispatch 而不是重建
  const buildExtensions = (): readonly import('@codemirror/state').Extension[] => [
    themeC.of(buildCmTheme({ maxHeight })),
    gutterC.of(lineNumbers ? cmLineNumbers() : []),
    wrapC.of(wrap ? EditorView.lineWrapping : []),
    languageC.of([]),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0' }),
    highlightSelectionMatches(),
    drawSelection(),
    keymap.of([...defaultKeymap, ...searchKeymap])
  ]

  // 首次 mount：建 EditorView
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions: buildExtensions() }),
      parent: hostRef.current
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 仅 mount 一次；后续 content / ext / wrap / lineNumbers 通过下面的 effect 增量更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // content / ext 切换：换 doc + 异步换语言
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const my = ++reqIdRef.current
    view.setState(EditorState.create({ doc: content, extensions: buildExtensions() }))
    void loadLanguage(ext).then((lang) => {
      if (my !== reqIdRef.current || !viewRef.current) return
      viewRef.current.dispatch({ effects: languageC.reconfigure(lang ?? []) })
    })
    // buildExtensions 闭包捕获 wrap/lineNumbers，依赖列表只放 content/ext 即可；
    // 其他 toggle 走专门的 effect 而非重建 doc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, ext])

  // 切行号：reconfigure gutter compartment
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: gutterC.reconfigure(lineNumbers ? cmLineNumbers() : [])
    })
  }, [lineNumbers, gutterC])

  // 切 wrap：reconfigure wrap compartment（CM6 内部保留 viewport 锚点字符位置）
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapC.reconfigure(wrap ? EditorView.lineWrapping : [])
    })
  }, [wrap, wrapC])

  // 主题桥：data-theme attr 变更时重建 cm 主题（只为 `dark: bool` flag；
  // 背景/token 颜色靠 CSS 变量自动 paint，根本不需要 reconfigure）
  useEffect(() => {
    const obs = new MutationObserver(() => {
      viewRef.current?.dispatch({ effects: themeC.reconfigure(buildCmTheme({ maxHeight })) })
    })
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => obs.disconnect()
  }, [themeC])

  return <div ref={hostRef} className={maxHeight ? 'w-full' : 'h-full w-full'} />
}
