/**
 * 源串里几处所在的引号环境 —— 脱敏把真值填回命令时据此转义（docs/auto-redaction-design.md §14.2）：模型看不到真值，
 * 没法替它加引号，`"{{…}}"` 里的 `$`、`'{{…}}'` 里的 `'` 都得由宿主处理。
 *
 * 按语法树找：从覆盖那一处的最小节点往上，第一个引号类节点决定环境；先遇到命令替换（`$( )`、反引号）或到顶就是
 * 裸词 —— `"$(printf %s X)"` 里的 X 不在双引号里。
 */
import { MAX_SHELL_SOURCE_LENGTH, withTree } from './parser'
import type { ShellSpan } from './types'

/**
 * - `bare`：裸词（含拼接、赋值的值）
 * - `single`：`'…'`
 * - `double`：`"…"`、`$"…"`
 * - `ansi-c`：`$'…'`
 * - `heredoc`：分隔符没加引号的 heredoc（`$`、反引号、`\` 照样展开）
 * - `literal`：原样（分隔符加了引号的 heredoc、注释）
 */
export type ShellQuoteContext = 'bare' | 'single' | 'double' | 'ansi-c' | 'heredoc' | 'literal'

/** 每个区间所在的引号环境；解析器没就绪、命令超长或有语法错误 → null（调用方退回原样替换） */
export function shellQuoteContexts(
  source: string,
  spans: readonly ShellSpan[]
): ShellQuoteContext[] | null {
  if (source.length > MAX_SHELL_SOURCE_LENGTH) return null
  return withTree(source, (root) => {
    if (root.hasError) return null
    return spans.map((span) => {
      for (
        let node = root.descendantForIndex(span.start, span.end);
        node !== null;
        node = node.parent
      ) {
        switch (node.type) {
          case 'raw_string':
            return 'single'
          case 'ansi_c_string':
            return 'ansi-c'
          case 'string':
          case 'translated_string':
            return 'double'
          case 'comment':
            return 'literal'
          case 'heredoc_body': {
            const start = node.parent?.children.find((c) => c?.type === 'heredoc_start')
            return start !== undefined && start !== null && /['"\\]/.test(start.text)
              ? 'literal'
              : 'heredoc'
          }
          case 'command_substitution':
          case 'process_substitution':
            return 'bare'
        }
      }
      return 'bare'
    })
  })
}
