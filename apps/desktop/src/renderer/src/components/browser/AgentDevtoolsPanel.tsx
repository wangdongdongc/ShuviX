import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Check, ChevronRight, Loader2, X } from 'lucide-react'
import type {
  AgentConsoleRow,
  AgentDevtoolsCall,
  AgentDevtoolsSnapshot,
  AgentNetworkRow
} from '../../../../shared/browserAgentDevtools'
import { sessionDotColor } from './sessionColor'

type View = 'calls' | 'network' | 'console'

/**
 * 停靠区的「Agent」页签 —— agent 的 devtool（2026-10-21 用户裁定：原生 DevTools 留着，旁边另加一个）：
 *
 *  - 调用：agent 在这一页上的每次 evaluate / network / console / cdp / events —— 时间、会话、摘要、耗时、成败；
 *    点开看完整参数与 agent 收到的那段文字（与对话里的工具结果是同一段）。像 DevTools 的 Protocol Monitor，
 *    只是记的是 agent 这个调试客户端。
 *  - 网络 / 控制台：agent 手里的采集缓冲原样（agent 调 network / console 读到的就是这一份），包括原生 DevTools
 *    打开之前的请求 —— 原生 Network 面板只记打开之后的。
 *
 * 数据在主进程（agentDevtools.ts）；内容一变主进程发一个节流过的「变了」，这里再取一次。只看不改：
 * 清空只清调用记录，agent 的采集一条不动。
 */
export function AgentDevtoolsPanel({ tabId }: { tabId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<View>('calls')
  const [snap, setSnap] = useState<AgentDevtoolsSnapshot | null>(null)
  /** 调用只看这个会话的（空 = 全部） */
  const [session, setSession] = useState('')
  const calls = useMemo(() => snap?.calls ?? [], [snap])
  /** 记录里出现过的会话（多于一个才给筛选） */
  const sessions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of calls) if (!seen.has(c.sessionId)) seen.set(c.sessionId, c.sessionTitle)
    return [...seen]
  }, [calls])
  const shown = session ? calls.filter((c) => c.sessionId === session) : calls

  useEffect(() => {
    let alive = true
    const api = window.api.browserView
    const load = (): void => {
      void api
        .agentDevtools(tabId)
        .then((s) => {
          if (alive) setSnap(s)
        })
        .catch(() => undefined)
    }
    load()
    const off = api.onAgentDevtoolsChanged(({ tabId: changed }) => {
      if (changed === tabId) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [tabId])

  const viewBtn = (v: View, label: string, count: number): React.JSX.Element => (
    <button
      onClick={() => setView(v)}
      className={`px-2 py-0.5 rounded-md text-[12px] transition-colors ${
        view === v
          ? 'bg-bg-hover text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover/50'
      }`}
      aria-pressed={view === v}
      data-agent-devtools-view={v}
    >
      {label}
      <span className="ml-1 text-text-tertiary tabular-nums">{count}</span>
    </button>
  )

  return (
    <div className="flex flex-col h-full min-h-0" data-agent-devtools={tabId}>
      <div className="flex-shrink-0 flex items-center gap-1 h-8 px-2 border-b border-border-secondary/40">
        {viewBtn('calls', t('browser.devtools.agent.calls'), calls.length)}
        {viewBtn('network', t('browser.devtools.agent.network'), snap?.network.length ?? 0)}
        {viewBtn('console', t('browser.devtools.agent.console'), snap?.console.length ?? 0)}
        <div className="flex-1" />
        {view === 'calls' && sessions.length > 1 && (
          <select
            value={session}
            onChange={(e) => setSession(e.target.value)}
            className="h-5 px-1 rounded-md bg-bg-secondary border border-border-secondary/60 text-[11px] text-text-primary"
            data-agent-devtools-session-filter
          >
            <option value="">{t('browser.devtools.agent.allSessions')}</option>
            {sessions.map(([id, title]) => (
              <option key={id} value={id}>
                {title || id}
              </option>
            ))}
          </select>
        )}
        {view === 'calls' && (
          <button
            onClick={() => void window.api.browserView.clearAgentDevtools(tabId)}
            disabled={calls.length === 0}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            title={t('browser.devtools.agent.clear')}
            data-agent-devtools-clear
          >
            <Ban size={12} />
            {t('browser.devtools.agent.clear')}
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {view === 'calls' ? (
          <CallsView calls={shown} />
        ) : view === 'network' ? (
          <NetworkView snap={snap} />
        ) : (
          <ConsoleView snap={snap} />
        )}
      </div>
    </div>
  )
}

// ─── 共用 ────────────────────────────────────────────────────────────────

const mono = 'font-mono text-[11.5px]'

/** HH:MM:SS.mmm（诊断时要看清先后，到毫秒） */
function clockOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function durationOf(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

function bytesOf(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 滚动容器：新内容来了（dep 变了）且原本就停在底部，就跟着滚到底（DevTools 控制台的做法）；用户往上翻着就不动。
 * 其余属性（className、data-*）原样给那个 div。
 */
function StickyScroll({
  dep,
  children,
  ...rest
}: {
  dep: unknown
  children: React.ReactNode
} & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return (
    <div
      {...rest}
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
      }}
    >
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="h-full flex items-center justify-center px-6 text-center text-[12px] text-text-tertiary">
      <p className="max-w-[560px]">{children}</p>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex-shrink-0 px-3 py-1 text-[11px] text-text-tertiary border-b border-border-secondary/30">
      {children}
    </div>
  )
}

// ─── 调用 ────────────────────────────────────────────────────────────────

function CallsView({ calls }: { calls: AgentDevtoolsCall[] }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  const toggle = (id: number): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (calls.length === 0) return <Empty>{t('browser.devtools.agent.noCalls')}</Empty>
  return (
    <StickyScroll
      dep={calls.length}
      className="h-full min-h-0 overflow-auto"
      data-agent-devtools-calls
    >
      {calls.map((call) => (
        <CallRow
          key={call.id}
          call={call}
          open={expanded.has(call.id)}
          onToggle={() => toggle(call.id)}
        />
      ))}
    </StickyScroll>
  )
}

function CallRow({
  call,
  open,
  onToggle
}: {
  call: AgentDevtoolsCall
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const running = call.ok === undefined
  const status = running ? 'running' : call.aborted ? 'aborted' : call.ok ? 'ok' : 'failed'
  return (
    <div
      className="border-b border-border-secondary/25"
      data-agent-call={call.id}
      data-tool={call.tool}
      data-status={status}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={`w-full flex items-center gap-2 h-6 px-2 text-left hover:bg-bg-hover/40 ${
          status === 'failed' ? 'bg-red-500/5' : ''
        }`}
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 text-text-tertiary transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className={`flex-shrink-0 text-text-tertiary tabular-nums ${mono}`}>
          {clockOf(call.startedAt)}
        </span>
        <span
          className="flex-shrink-0 h-2 w-2 rounded-full"
          style={{ background: sessionDotColor(call.sessionId) }}
          title={call.sessionTitle || call.sessionId}
        />
        <span className={`flex-shrink-0 w-[62px] text-accent ${mono}`}>{call.tool}</span>
        <span className={`flex-1 min-w-0 truncate text-text-primary ${mono}`} title={call.summary}>
          {call.summary}
        </span>
        <span className={`flex-shrink-0 text-text-tertiary tabular-nums ${mono}`}>
          {call.durationMs !== undefined ? durationOf(call.durationMs) : ''}
        </span>
        <span className="flex-shrink-0 w-4 flex justify-center">
          {status === 'running' ? (
            <Loader2
              size={12}
              className="animate-spin text-text-tertiary"
              aria-label={t('browser.devtools.agent.running')}
            />
          ) : status === 'ok' ? (
            <Check size={12} className="text-emerald-500" />
          ) : (
            <X
              size={12}
              className={status === 'failed' ? 'text-red-500' : 'text-text-tertiary'}
              aria-label={
                status === 'failed'
                  ? t('browser.devtools.agent.failed')
                  : t('browser.devtools.agent.aborted')
              }
            />
          )}
        </span>
      </button>
      {open && (
        <div className="px-7 pb-2 pt-0.5 space-y-2" data-agent-call-detail>
          <Section title={t('browser.devtools.agent.params')}>
            {call.params || t('browser.devtools.agent.noParams')}
          </Section>
          {!running && (
            <Section
              title={
                status === 'failed'
                  ? `${t('browser.devtools.agent.result')} · ${t('browser.devtools.agent.failed')}`
                  : status === 'aborted'
                    ? `${t('browser.devtools.agent.result')} · ${t('browser.devtools.agent.aborted')}`
                    : t('browser.devtools.agent.result')
              }
              tone={status === 'failed' ? 'error' : undefined}
            >
              {call.result || t('browser.devtools.agent.noResult')}
              {call.resultTruncatedFrom !== undefined &&
                `\n${t('browser.devtools.agent.truncated', { count: call.resultTruncatedFrom })}`}
            </Section>
          )}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  tone,
  children
}: {
  title: string
  tone?: 'error'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[11px] text-text-tertiary mb-0.5">{title}</div>
      <pre
        className={`max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded-md px-2 py-1.5 bg-bg-secondary ${mono} ${
          tone === 'error' ? 'text-red-500' : 'text-text-primary'
        }`}
      >
        {children}
      </pre>
    </div>
  )
}

// ─── 网络 ────────────────────────────────────────────────────────────────

function NetworkView({ snap }: { snap: AgentDevtoolsSnapshot | null }): React.JSX.Element {
  const { t } = useTranslation()
  const rows = snap?.network ?? []
  if (!snap?.attached) return <Empty>{t('browser.devtools.agent.notAttached')}</Empty>
  if (!snap.capturing.network && rows.length === 0) {
    return <Empty>{t('browser.devtools.agent.networkOff')}</Empty>
  }
  const th = 'sticky top-0 bg-bg-primary px-2 h-6 text-left font-normal text-text-tertiary'
  return (
    <div className="flex flex-col h-full min-h-0">
      <Note>{t('browser.devtools.agent.networkNote')}</Note>
      {rows.length === 0 ? (
        <Empty>{t('browser.devtools.agent.noRequests')}</Empty>
      ) : (
        <StickyScroll dep={rows.length} className="flex-1 min-h-0 overflow-auto" data-agent-network>
          <table className="w-full table-fixed text-[11.5px]">
            <colgroup>
              <col className="w-[110px]" />
              <col className="w-[64px]" />
              <col className="w-[64px]" />
              <col />
              <col className="w-[150px]" />
              <col className="w-[72px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border-secondary/40">
                <th className={th}>{t('browser.devtools.agent.col.requestId')}</th>
                <th className={th}>{t('browser.devtools.agent.col.status')}</th>
                <th className={th}>{t('browser.devtools.agent.col.method')}</th>
                <th className={th}>{t('browser.devtools.agent.col.url')}</th>
                <th className={th}>{t('browser.devtools.agent.col.type')}</th>
                <th className={`${th} text-right`}>{t('browser.devtools.agent.col.size')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <NetworkLine key={r.id} row={r} />
              ))}
            </tbody>
          </table>
        </StickyScroll>
      )}
    </div>
  )
}

function NetworkLine({ row }: { row: AgentNetworkRow }): React.JSX.Element {
  const bad = row.failed || (row.status !== undefined && row.status >= 400)
  const td = `px-2 h-6 truncate ${mono}`
  return (
    <tr
      className={`border-b border-border-secondary/20 ${bad ? 'text-red-500' : 'text-text-primary'}`}
      data-agent-request={row.id}
    >
      <td className={`${td} text-text-tertiary`} title={row.id}>
        {row.id}
      </td>
      <td className={td}>{row.failed ? '✕' : (row.status ?? '…')}</td>
      <td className={td}>{row.method}</td>
      <td className={td} title={row.url}>
        {row.url}
      </td>
      <td className={`${td} text-text-secondary`} title={row.mimeType}>
        {row.mimeType ?? ''}
      </td>
      <td className={`${td} text-right text-text-secondary tabular-nums`}>
        {row.size !== undefined ? bytesOf(row.size) : ''}
      </td>
    </tr>
  )
}

// ─── 控制台 ──────────────────────────────────────────────────────────────

const LEVEL_TONE: Record<string, string> = {
  error: 'text-red-500 bg-red-500/5',
  assert: 'text-red-500 bg-red-500/5',
  warning: 'text-amber-500 bg-amber-500/5',
  warn: 'text-amber-500 bg-amber-500/5',
  debug: 'text-text-secondary',
  verbose: 'text-text-secondary'
}

function ConsoleView({ snap }: { snap: AgentDevtoolsSnapshot | null }): React.JSX.Element {
  const { t } = useTranslation()
  const rows = snap?.console ?? []
  if (!snap?.attached) return <Empty>{t('browser.devtools.agent.notAttached')}</Empty>
  if (!snap.capturing.console && rows.length === 0) {
    return <Empty>{t('browser.devtools.agent.consoleOff')}</Empty>
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <Note>{t('browser.devtools.agent.consoleNote')}</Note>
      {rows.length === 0 ? (
        <Empty>{t('browser.devtools.agent.noMessages')}</Empty>
      ) : (
        <StickyScroll dep={rows.length} className="flex-1 min-h-0 overflow-auto" data-agent-console>
          {rows.map((r) => (
            <ConsoleLine key={r.id} row={r} />
          ))}
        </StickyScroll>
      )}
    </div>
  )
}

function ConsoleLine({ row }: { row: AgentConsoleRow }): React.JSX.Element {
  const tone = LEVEL_TONE[row.type] ?? 'text-text-primary'
  const source = row.url
    ? `${row.url.split('/').pop() || row.url}${row.lineNumber !== undefined ? `:${row.lineNumber + 1}` : ''}`
    : ''
  return (
    <div
      className={`flex items-start gap-2 px-2 py-0.5 border-b border-border-secondary/20 ${tone}`}
      data-agent-console-line={row.type}
    >
      <span className={`flex-shrink-0 text-text-tertiary tabular-nums ${mono}`}>
        {clockOf(row.timestamp)}
      </span>
      <span className={`flex-1 min-w-0 whitespace-pre-wrap break-all ${mono}`}>{row.text}</span>
      {source && (
        <span
          className={`flex-shrink-0 max-w-[240px] truncate text-text-tertiary ${mono}`}
          title={row.url}
        >
          {source}
        </span>
      )}
    </div>
  )
}
