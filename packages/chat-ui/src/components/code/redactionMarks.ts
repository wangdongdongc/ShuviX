/**
 * CodeMirror 里的自动脱敏占位符（docs/auto-redaction-design.md §2.3）：工具卡片的代码字段（edit 的新旧文本、write 的
 * 内容）存的是占位符，这里按模型收到的样子显示，与 RedactedMark 一致 —— 模型收到真值的显示成普通文字的真值；收到占位符
 * 的显示占位符原文，指到 / 点一下浮出真值（redactionPopover，与聊天里同一个浮层）。文档本身不动：只读视图，复制按钮
 * 另外换回真值。查到新的真值时，调用方换一份新的扩展（Compartment 重配）重画。
 */
import type { Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { PLACEHOLDER_PATTERN } from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import {
  releaseRedactionAnchor,
  scheduleHideRedaction,
  showRedaction,
  toggleRedaction,
  type RedactionReveal
} from '../chat/redactionPopover'

/** 一处占位符怎么显示：类别、模型收到的是不是真值、真值，以及浮层内容 */
export type RedactionResolver = (placeholder: string) => {
  category: string
  disclosed: boolean
  value?: string
  reveal: RedactionReveal
}

class RedactionWidget extends WidgetType {
  constructor(
    readonly placeholder: string,
    readonly shown: ReturnType<RedactionResolver>
  ) {
    super()
  }

  eq(other: RedactionWidget): boolean {
    return (
      other.placeholder === this.placeholder &&
      other.shown.disclosed === this.shown.disclosed &&
      other.shown.value === this.shown.value &&
      other.shown.reveal.label === this.shown.reveal.label &&
      other.shown.reveal.note === this.shown.reveal.note
    )
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.dataset.redaction = this.shown.category
    if (this.shown.disclosed && this.shown.value !== undefined) {
      // 模型收到的就是真值：照原样
      span.dataset.redactionSent = ''
      span.textContent = this.shown.value
      return span
    }
    span.dataset.redactionPlaceholder = ''
    span.className = 'cm-redaction-placeholder'
    span.textContent = this.placeholder
    span.tabIndex = 0
    span.setAttribute('role', 'button')
    const reveal = this.shown.reveal
    span.addEventListener('mouseenter', () => showRedaction(span, reveal))
    span.addEventListener('mouseleave', () => scheduleHideRedaction(span))
    span.addEventListener('focus', () => showRedaction(span, reveal))
    span.addEventListener('blur', () => scheduleHideRedaction(span))
    span.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      toggleRedaction(span, reveal)
    })
    return span
  }

  destroy(dom: HTMLElement): void {
    releaseRedactionAnchor(dom)
  }

  ignoreEvent(): boolean {
    return true
  }
}

const redactionTheme = EditorView.baseTheme({
  '.cm-redaction-placeholder': {
    cursor: 'help',
    borderRadius: '4px',
    padding: '0 3px',
    background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent)'
  }
})

export function redactionMarks(resolve: RedactionResolver): Extension {
  const decorator = new MatchDecorator({
    regexp: new RegExp(PLACEHOLDER_PATTERN, 'g'),
    decoration: (match) =>
      Decoration.replace({ widget: new RedactionWidget(match[0], resolve(match[0])) })
  })
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view)
      }
      update(update: ViewUpdate): void {
        this.decorations = decorator.updateDeco(update, this.decorations)
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) =>
        EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none)
    }
  )
  return [plugin, redactionTheme]
}
