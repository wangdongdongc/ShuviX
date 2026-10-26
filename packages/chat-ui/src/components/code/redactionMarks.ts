/**
 * CodeMirror 里的自动脱敏标记（docs/auto-redaction-design.md §2.3）：工具卡片的代码字段（edit 的新旧文本、write 的
 * 内容）存的是占位符，这里把每个占位符换成一个小部件，显示真值并带标记（与 RedactedMark 同样的样子）。文档本身
 * 不动 —— 只读视图，复制按钮另外把占位符换回真值。真值查到了，调用方换一份新的扩展（Compartment 重配）重画。
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

/** 一处占位符怎么显示：真值（没查到 / 解不开就没有）与类别的人读名 */
export type RedactionResolver = (placeholder: string) => {
  value?: string
  label: string
  category: string
}

class RedactionWidget extends WidgetType {
  constructor(
    readonly placeholder: string,
    readonly value: string | undefined,
    readonly label: string,
    readonly category: string
  ) {
    super()
  }

  eq(other: RedactionWidget): boolean {
    return (
      other.placeholder === this.placeholder &&
      other.value === this.value &&
      other.label === this.label
    )
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.dataset.redaction = this.category
    span.title = this.label
    if (this.value !== undefined) {
      span.className = 'cm-redaction-mark'
      span.textContent = this.value
    } else {
      span.className = 'cm-redaction-chip'
      span.dataset.redactionMissing = ''
      span.textContent = this.label
    }
    return span
  }
}

const redactionTheme = EditorView.baseTheme({
  '.cm-redaction-mark': {
    borderRadius: '3px',
    background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
    textDecoration:
      'underline dotted color-mix(in srgb, var(--color-warning, #f59e0b) 60%, transparent)',
    textUnderlineOffset: '2px'
  },
  '.cm-redaction-chip': {
    borderRadius: '3px',
    padding: '0 4px',
    fontSize: '0.85em',
    color: 'var(--color-warning, #f59e0b)',
    background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent)'
  }
})

export function redactionMarks(resolve: RedactionResolver): Extension {
  const decorator = new MatchDecorator({
    regexp: new RegExp(PLACEHOLDER_PATTERN, 'g'),
    decoration: (match) => {
      const shown = resolve(match[0])
      return Decoration.replace({
        widget: new RedactionWidget(match[0], shown.value, shown.label, shown.category)
      })
    }
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
