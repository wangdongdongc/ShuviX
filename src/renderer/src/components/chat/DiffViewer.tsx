import { useRef, useEffect, useMemo, useState } from 'react'

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
      result.push({ type: 'add', newLineNum: lineNum, content })
    } else if (prefix === '-') {
      result.push({ type: 'remove', oldLineNum: lineNum, content })
    } else {
      // Context line — same line number for both sides
      result.push({ type: 'context', oldLineNum: lineNum, newLineNum: lineNum, content })
    }
  }

  return result
}

/** Pair up removed/added lines for side-by-side view */
interface SideBySideLine {
  left: { lineNum?: number; content: string; type: 'remove' | 'context' | 'empty' | 'separator' }
  right: { lineNum?: number; content: string; type: 'add' | 'context' | 'empty' | 'separator' }
}

function buildSideBySide(parsed: DiffLine[]): SideBySideLine[] {
  const rows: SideBySideLine[] = []
  let i = 0

  while (i < parsed.length) {
    const line = parsed[i]

    if (line.type === 'separator') {
      rows.push({
        left: { content: '...', type: 'separator' },
        right: { content: '...', type: 'separator' }
      })
      i++
      continue
    }

    if (line.type === 'context') {
      rows.push({
        left: { lineNum: line.oldLineNum, content: line.content, type: 'context' },
        right: { lineNum: line.newLineNum, content: line.content, type: 'context' }
      })
      i++
      continue
    }

    // Collect consecutive remove/add blocks and pair them
    if (line.type === 'remove') {
      const removes: DiffLine[] = []
      while (i < parsed.length && parsed[i].type === 'remove') {
        removes.push(parsed[i])
        i++
      }
      const adds: DiffLine[] = []
      while (i < parsed.length && parsed[i].type === 'add') {
        adds.push(parsed[i])
        i++
      }

      const maxLen = Math.max(removes.length, adds.length)
      for (let j = 0; j < maxLen; j++) {
        const rm = removes[j]
        const ad = adds[j]
        rows.push({
          left: rm
            ? { lineNum: rm.oldLineNum, content: rm.content, type: 'remove' }
            : { content: '', type: 'empty' },
          right: ad
            ? { lineNum: ad.newLineNum, content: ad.content, type: 'add' }
            : { content: '', type: 'empty' }
        })
      }
      continue
    }

    if (line.type === 'add') {
      rows.push({
        left: { content: '', type: 'empty' },
        right: { lineNum: line.newLineNum, content: line.content, type: 'add' }
      })
      i++
      continue
    }

    i++
  }

  return rows
}

const bgColors = {
  add: 'bg-green-500/10',
  remove: 'bg-red-500/10',
  context: '',
  empty: 'bg-bg-tertiary/30',
  separator: ''
}

const gutterColors = {
  add: 'bg-green-500/20 text-green-400',
  remove: 'bg-red-500/20 text-red-400',
  context: 'text-text-tertiary',
  empty: 'bg-bg-tertiary/30',
  separator: 'text-text-tertiary'
}

const textColors = {
  add: 'text-green-300',
  remove: 'text-red-300',
  context: 'text-text-secondary',
  empty: '',
  separator: 'text-text-tertiary italic'
}

interface DiffViewerProps {
  diff: string
}

export function DiffViewer({ diff }: DiffViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width)
      }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const parsed = useMemo(() => parseDiffString(diff), [diff])
  const sideBySide = useMemo(() => buildSideBySide(parsed), [parsed])

  const isSplit = width > 500

  return (
    <div ref={containerRef}>
      <div className="rounded border border-border-secondary/50 overflow-hidden text-[11px] font-mono leading-[18px]">
        <div className="overflow-auto max-h-[400px]">
          {isSplit ? <SplitView rows={sideBySide} /> : <UnifiedView lines={parsed} />}
        </div>
      </div>
    </div>
  )
}

function UnifiedView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {lines.map((line, i) => {
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
  )
}

function SplitView({ rows }: { rows: SideBySideLine[] }): React.JSX.Element {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {/* Left side (old) */}
            <td
              className={`w-[1px] whitespace-nowrap px-1 text-right select-none border-r border-border-secondary/30 ${gutterColors[row.left.type]}`}
            >
              {row.left.lineNum ?? ''}
            </td>
            <td
              className={`w-1/2 px-2 whitespace-pre overflow-hidden text-ellipsis ${bgColors[row.left.type]} ${textColors[row.left.type]} border-r border-border-secondary/30`}
            >
              {row.left.type === 'separator' ? (
                <span className="text-text-tertiary italic">...</span>
              ) : row.left.type === 'remove' ? (
                <>
                  <span className="select-none opacity-60">- </span>
                  {row.left.content}
                </>
              ) : row.left.type !== 'empty' ? (
                <>
                  <span className="select-none opacity-60">{'  '}</span>
                  {row.left.content}
                </>
              ) : null}
            </td>

            {/* Right side (new) */}
            <td
              className={`w-[1px] whitespace-nowrap px-1 text-right select-none border-r border-border-secondary/30 ${gutterColors[row.right.type]}`}
            >
              {row.right.lineNum ?? ''}
            </td>
            <td
              className={`w-1/2 px-2 whitespace-pre overflow-hidden text-ellipsis ${bgColors[row.right.type]} ${textColors[row.right.type]}`}
            >
              {row.right.type === 'separator' ? (
                <span className="text-text-tertiary italic">...</span>
              ) : row.right.type === 'add' ? (
                <>
                  <span className="select-none opacity-60">+ </span>
                  {row.right.content}
                </>
              ) : row.right.type !== 'empty' ? (
                <>
                  <span className="select-none opacity-60">{'  '}</span>
                  {row.right.content}
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
