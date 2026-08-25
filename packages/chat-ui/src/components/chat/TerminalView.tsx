import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'

/** 提示符里的 cwd：先折 home，再长则只留末两段 —— 终端提示符本来也不显示全路径 */
function shortCwd(cwd: string): string {
  const home = cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
  if (home.length <= 34) return home
  const segs = home.split(/[/\\]/).filter(Boolean)
  return segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : home
}

interface TerminalViewProps {
  command: string
  /** 命令输出（stdout + stderr 已由工具合并） */
  output?: string
  /** 本地执行目录（bash） */
  cwd?: string
  /**
   * 远端主机（ssh exec）—— 优先于 cwd 显示。
   * 远端每次 exec 是独立 shell，没有可跟踪的远端 cwd；真实 ssh 提示符显示的也是主机。
   */
  host?: string
  /** 非 0 时在提示符行右侧标出 —— 输出可能很长，退出码不该只躺在末尾等人滚 */
  exitCode?: number
  running?: boolean
  /**
   * 输出持续增长时自动贴底（后台任务面板用；对话里的历史命令输出是静态的，不传即维持原行为）。
   * 用户手动上滚即脱离贴底，滚回底部自动恢复 —— 与终端一致。
   */
  stickToBottom?: boolean
  /** 输出区最大高度类名覆写（默认 max-h-64） */
  outputMaxHClass?: string
}

/**
 * 终端形态的工具详情 —— 命令和输出是一次交互的两半，拼成一段终端会话来读。
 *
 * 与通用表单形态的区别：不带「参数 / 结果」标签，不给命令套代码块外壳和行号；
 * 提示符行给出 cwd，多行命令的后续行自然对齐在首字符下方（跟真实终端一致）。
 */
export function TerminalView({
  command,
  output,
  cwd,
  host,
  exitCode,
  running,
  stickToBottom = false,
  outputMaxHClass = 'max-h-64'
}: TerminalViewProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const outRef = useRef<HTMLPreElement>(null)
  // 是否处于贴底态 —— 只在 stickToBottom 模式下有意义
  const stuckRef = useRef(true)

  useEffect(() => {
    if (!stickToBottom) return
    const el = outRef.current
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight
  }, [output, stickToBottom])
  const failed = typeof exitCode === 'number' && exitCode !== 0
  const location = host || (cwd ? shortCwd(cwd) : '')

  return (
    <div className="group/term relative rounded-md bg-bg-tertiary/50 font-mono text-[11px] leading-[1.6]">
      {/* 复制命令 —— 悬浮才出，不占提示符行的位置 */}
      <button
        onClick={() => {
          copyToClipboard(command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="absolute top-1 right-1 z-10 p-1 rounded opacity-0 group-hover/term:opacity-100 text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-opacity"
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <Check size={10} className="text-success" /> : <Copy size={10} />}
      </button>

      {/* 提示符行：cwd + ❯ + 命令（多行命令续行自动对齐到命令首字符） */}
      <div className="flex items-start gap-1.5 px-2 pt-1.5 pr-7">
        {location && (
          <span className="flex-shrink-0 max-w-[45%] truncate text-accent/80" title={host || cwd}>
            {location}
          </span>
        )}
        <span className="flex-shrink-0 text-success/70 select-none">❯</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-text-primary">
          {command}
        </span>
        {failed && <span className="flex-shrink-0 text-error/80 select-none">exit {exitCode}</span>}
      </div>

      {/* 输出：紧跟命令，无标签无分隔线 —— 终端里本来就是连着的 */}
      {output ? (
        <pre
          ref={outRef}
          onScroll={
            stickToBottom
              ? (e) => {
                  const el = e.currentTarget
                  stuckRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
                }
              : undefined
          }
          className={`px-2 pt-1 pb-1.5 ${outputMaxHClass} overflow-y-auto overscroll-contain thin-scrollbar whitespace-pre-wrap break-words text-text-secondary`}
        >
          {output}
        </pre>
      ) : running ? (
        <div className="px-2 pt-1 pb-1.5">
          <span className="inline-block w-1.5 h-3 align-[-1px] bg-text-tertiary/60 animate-pulse rounded-sm" />
        </div>
      ) : (
        <div className="pb-1.5" />
      )}
    </div>
  )
}
