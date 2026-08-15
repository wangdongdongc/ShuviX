import { useMemo } from 'react'
import { DETAIL_MAX_H } from './detailViewport'

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'separator'
  oldLineNum?: number
  newLineNum?: number
  content: string
}

/** Parse the custom diff string from generateDiffString() */
function parseDiffString(diff: string): DiffLine[] {
  const lines = diff.split('\n')
  const result: DiffLine[] = []

  // 上下文行在 generateDiffString() 里只印了旧侧行号（格式所限，新侧没进串），
  // 直接两栏共用会让增删不等的 hunk 之后所有新侧行号偏移 —— 这里按 delta 复原：
  // delta = 新行号 − 旧行号，随 + / − 累积；上下文行与 `...` 省略两侧同步推进，不改变它。
  let delta = 0

  for (const line of lines) {
    if (!line) continue

    // Separator: `  ...` (leading space + padded spaces + ...)
    if (/^ +\.\.\./.test(line)) {
      result.push({ type: 'separator', content: '...' })
      continue
    }

    const prefix = line[0]
    const rest = line.slice(1)

    // Extract line number and content: `lineNum content`
    const match = rest.match(/^(\s*\d+)\s(.*)/)
    if (!match) {
      // Fallback — just show the line
      result.push({ type: 'context', content: line })
      continue
    }

    const lineNum = parseInt(match[1].trim(), 10)
    const content = match[2] ?? ''

    if (prefix === '+') {
      // 只吃掉新侧一行 —— 印的就是新行号
      result.push({ type: 'add', newLineNum: lineNum, content })
      delta++
    } else if (prefix === '-') {
      // 只吃掉旧侧一行 —— 印的就是旧行号
      result.push({ type: 'remove', oldLineNum: lineNum, content })
      delta--
    } else {
      // Context line — 印的是旧行号，新侧按累积偏移换算
      result.push({ type: 'context', oldLineNum: lineNum, newLineNum: lineNum + delta, content })
    }
  }

  return result
}

const bgColors = {
  add: 'bg-green-500/10',
  remove: 'bg-red-500/10',
  context: '',
  separator: ''
}

// light-dark(浅色主题用深色文字, 深色主题用浅色文字) —— 各主题 root 已声明 color-scheme，
// 保证 diff 文字在浅色行底色（bg-*-500/10）上也有足够对比度。
const gutterColors = {
  add: 'bg-green-500/20 text-[light-dark(#15803d,#4ade80)]',
  remove: 'bg-red-500/20 text-[light-dark(#b91c1c,#f87171)]',
  context: 'text-text-tertiary',
  separator: 'text-text-tertiary'
}

const textColors = {
  add: 'text-[light-dark(#15803d,#86efac)]',
  remove: 'text-[light-dark(#b91c1c,#fca5a5)]',
  context: 'text-text-secondary',
  separator: 'text-text-tertiary italic'
}

interface DiffViewerProps {
  diff: string
  /** 纵向限高 —— diff 是这块区域唯一的滚动主，外层不再套第二层限高 */
  maxHeight?: string
}

export function DiffViewer({ diff, maxHeight = DETAIL_MAX_H }: DiffViewerProps): React.JSX.Element {
  const parsed = useMemo(() => parseDiffString(diff), [diff])

  return (
    <div className="rounded border border-border-secondary/50 overflow-hidden text-[11px] font-mono leading-[18px]">
      {/* 纵向限高在此，横向留给长行（diff 不换行：软换行会打乱行号与 +/- 的对齐） */}
      <div className="overflow-auto overscroll-contain thin-scrollbar" style={{ maxHeight }}>
        <table className="w-full border-collapse">
          <tbody>
            {parsed.map((line, i) => {
              if (line.type === 'separator') {
                return (
                  <tr key={i} className="bg-bg-tertiary/30">
                    <td className="w-[1px] whitespace-nowrap px-1 text-right text-text-tertiary select-none border-r border-border-secondary/30">
                      ...
                    </td>
                    <td className="w-[1px] whitespace-nowrap px-1 text-right text-text-tertiary select-none border-r border-border-secondary/30">
                      ...
                    </td>
                    <td className="px-2 text-text-tertiary italic">
                      <span className="select-none">{'  '}</span>
                    </td>
                  </tr>
                )
              }

              const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '

              return (
                <tr key={i} className={bgColors[line.type]}>
                  <td
                    className={`w-[1px] whitespace-nowrap px-1 text-right select-none border-r border-border-secondary/30 ${gutterColors[line.type]}`}
                  >
                    {line.oldLineNum ?? ''}
                  </td>
                  <td
                    className={`w-[1px] whitespace-nowrap px-1 text-right select-none border-r border-border-secondary/30 ${gutterColors[line.type]}`}
                  >
                    {line.newLineNum ?? ''}
                  </td>
                  <td className={`px-2 whitespace-pre ${textColors[line.type]}`}>
                    <span className="select-none opacity-60">{prefix} </span>
                    {line.content}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
