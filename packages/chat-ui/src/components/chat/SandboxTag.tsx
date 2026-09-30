/**
 * shell 命令工具卡上的两处沙箱信息 —— 只在展开的终端视图里露面，不上摘要行：
 *
 *  - 提示符行上的标记：这条命令是圈在沙箱里跑的、越了界（完全访问），还是根本没有沙箱（附原因）；
 *  - 终端下方的「实际执行的命令」：点开才向宿主要那份记录（沙箱包装、shell 参数、额外环境变量），
 *    可以整段复制进终端复现 —— 沙箱规则连同路径参数有 8 KB 上下，所以它不随 details 下发。
 *
 * 数据：标记读工具结果 details 的 `sandbox`（有值 = 这条命令真的起了进程，宿主也就留了记录）；
 * 记录经 HostApi 取，渠道端（Chrome 侧边栏）没有 HostApi，整块不渲染。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Copy } from 'lucide-react'
import type { ShellSandboxState } from '@shuvix/chat-protocol/types/chatMessage'
import { getHostApi } from '../../api/chatApi'
import { copyToClipboard } from '../../utils/clipboard'
import { DETAIL_PRE_CLASS } from './detailViewport'

const BADGE_CLASS: Record<ShellSandboxState, string> = {
  confined: 'bg-success/10 text-success',
  escalated: 'bg-error/15 text-error',
  // 有后端却这次没套上：和平时不一样，值得多看一眼
  unavailable: 'bg-warning/15 text-warning',
  // 设置里关了 / 这台机器本来就没有：每条命令都一样，不抢眼
  disabled: 'bg-bg-hover text-text-tertiary',
  unsupported: 'bg-bg-hover text-text-tertiary'
}

/** 提示符行上的沙箱标记；悬停说明为什么是这样 */
export function SandboxBadge({ state }: { state: ShellSandboxState }): React.JSX.Element {
  const { t } = useTranslation()
  const label =
    state === 'confined'
      ? t('toolCall.sandbox.confined')
      : state === 'escalated'
        ? t('toolCall.fullAccessTag')
        : t('toolCall.sandbox.unconfined')
  return (
    <span
      className={`flex-shrink-0 self-center px-1 rounded font-sans text-[10px] leading-[1.5] select-none ${BADGE_CLASS[state]}`}
      title={t(`toolCall.sandbox.${state}Hint`)}
      data-sandbox={state}
    >
      {label}
    </span>
  )
}

type Loaded = { status: 'idle' } | { status: 'loading' } | { status: 'done'; text: string | null }

/** 「实际执行的命令」—— 折叠的一行，点开才读 */
export function InvocationView({
  sessionId,
  toolCallId
}: {
  sessionId: string
  toolCallId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'idle' })
  const [copied, setCopied] = useState(false)
  const host = getHostApi()
  if (!host) return null

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next || loaded.status !== 'idle') return
    setLoaded({ status: 'loading' })
    host.bgTask
      .readInvocation({ sessionId, toolCallId })
      .then((text) => setLoaded({ status: 'done', text }))
      .catch(() => setLoaded({ status: 'done', text: null }))
  }

  const text = loaded.status === 'done' ? loaded.text : null

  return (
    <div data-invocation-view="">
      <button
        onClick={toggle}
        className="flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
        aria-expanded={open}
      >
        <ChevronRight size={10} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {t('toolCall.invocation.show')}
      </button>
      {open && (
        <div className="relative group/inv mt-0.5">
          {loaded.status === 'loading' || loaded.status === 'idle' ? (
            <div className="text-[10px] text-text-tertiary px-2">
              {t('toolCall.invocation.loading')}
            </div>
          ) : text === null ? (
            <div className="text-[10px] text-text-tertiary px-2">
              {t('toolCall.invocation.missing')}
            </div>
          ) : (
            <>
              <button
                onClick={() => {
                  copyToClipboard(text)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                className="absolute top-1 right-1 z-10 p-1 rounded opacity-0 group-hover/inv:opacity-100 text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-opacity"
                title={copied ? 'Copied' : 'Copy'}
              >
                {copied ? <Check size={10} className="text-success" /> : <Copy size={10} />}
              </button>
              <pre className={`${DETAIL_PRE_CLASS} font-mono pr-7`} data-invocation-text="">
                {text}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
