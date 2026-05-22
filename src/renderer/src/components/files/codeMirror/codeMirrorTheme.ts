/**
 * CodeMirror 主题桥 —— 把 ShuviX 11 套主题映射到 CM6 EditorView.theme + HighlightStyle
 *
 * 关键思路：CSS 变量驱动。
 *   - EditorView.theme() 写入的 CSS 规则 value 可以是 `var(--xxx)`，浏览器在 paint
 *     时解析；data-theme attr 一改，背景/字体/选区颜色等自动跟随，无需重建 view。
 *   - HighlightStyle 的 token 颜色也用 `var(--cm-tok-*)` 注入，11 套主题在 main.css
 *     里各填一套调色板即可。
 *
 * 唯一例外是 `dark: true | false` flag —— CM6 用它设 .cm-editor 的 color-scheme
 * （影响原生滚动条/光标），这个不能跟 CSS var。调用方在 data-theme 切换时通过
 * Compartment.reconfigure(buildCmTheme()) 重建一次即可。
 */

import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/** 根据 :root 的 color-scheme 解析当前主题是深色还是浅色 */
function isDarkRoot(): boolean {
  return getComputedStyle(document.documentElement).colorScheme.trim().startsWith('dark')
}

export function buildCmTheme(): Extension {
  const base = EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--theme-bg-primary)',
        color: 'var(--theme-text-primary)',
        height: '100%'
      },
      '.cm-scroller': {
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", Consolas, monospace',
        fontSize: '12px',
        lineHeight: '1.5'
      },
      '.cm-content': { caretColor: 'var(--theme-accent)' },
      '.cm-gutters': {
        backgroundColor: 'var(--theme-bg-secondary)',
        color: 'var(--theme-text-tertiary)',
        border: 'none',
        borderRight: '1px solid var(--theme-border-secondary)'
      },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
      // 默认 .cm-selectionBackground 优先级高，必须 !important 让 accent-muted 接管
      '.cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--theme-accent-muted) !important'
      },
      '.cm-cursor': { borderLeftColor: 'var(--theme-accent)' },
      '.cm-panels': {
        backgroundColor: 'var(--theme-bg-secondary)',
        color: 'var(--theme-text-primary)'
      },
      '.cm-panels-bottom': { borderTop: '1px solid var(--theme-border-secondary)' },
      '.cm-searchMatch': {
        backgroundColor: 'var(--theme-accent-muted)',
        outline: '1px solid var(--theme-accent)'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--theme-accent)',
        color: 'var(--theme-bg-primary)'
      },
      '.cm-panel.cm-search input': {
        backgroundColor: 'var(--theme-bg-primary)',
        color: 'var(--theme-text-primary)',
        border: '1px solid var(--theme-border-secondary)',
        borderRadius: '3px',
        padding: '2px 6px',
        fontSize: '11px'
      },
      '.cm-panel.cm-search button': {
        backgroundColor: 'transparent',
        color: 'var(--theme-text-secondary)',
        border: '1px solid var(--theme-border-secondary)',
        borderRadius: '3px',
        cursor: 'pointer'
      }
    },
    { dark: isDarkRoot() }
  )

  // Token 颜色 —— 全部 var()，11 主题在 main.css 各填一套调色板
  const highlight = HighlightStyle.define([
    {
      tag: [t.keyword, t.controlKeyword, t.moduleKeyword],
      color: 'var(--cm-tok-keyword)'
    },
    {
      tag: [t.name, t.propertyName, t.macroName],
      color: 'var(--cm-tok-variable)'
    },
    {
      tag: [t.function(t.variableName), t.labelName],
      color: 'var(--cm-tok-function)'
    },
    {
      tag: [t.color, t.constant(t.name), t.standard(t.name)],
      color: 'var(--cm-tok-constant)'
    },
    {
      tag: [t.typeName, t.className, t.annotation, t.modifier, t.namespace],
      color: 'var(--cm-tok-type)'
    },
    {
      tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp],
      color: 'var(--cm-tok-operator)'
    },
    { tag: [t.meta, t.comment], color: 'var(--cm-tok-comment)', fontStyle: 'italic' },
    { tag: [t.string, t.special(t.string)], color: 'var(--cm-tok-string)' },
    { tag: [t.number, t.bool, t.atom], color: 'var(--cm-tok-number)' },
    { tag: [t.punctuation, t.bracket], color: 'var(--cm-tok-punctuation)' },
    { tag: [t.heading], color: 'var(--cm-tok-keyword)', fontWeight: 'bold' },
    { tag: [t.tagName], color: 'var(--cm-tok-keyword)' },
    { tag: [t.attributeName], color: 'var(--cm-tok-variable)' }
  ])

  return [base, syntaxHighlighting(highlight)]
}
