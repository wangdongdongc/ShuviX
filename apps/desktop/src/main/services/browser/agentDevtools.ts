/**
 * agent 的 devtool —— 停靠区「Agent」页签的数据：agent 在每一页上的 devtool 调用记录，外加它手里的
 * 网络 / 控制台采集缓冲（见 shared/browserAgentDevtools.ts）。
 *
 * 调用记录由内置 browser MCP server 的旁观钩子（observe）喂进来：参数不合法、被门拦下、被取消的调用也在内，
 * 结果是 agent 实际收到的那段文字。采集缓冲不另存一份 —— 读的时候从 agent 的 CDP 会话里现取（peek，不 attach），
 * 所以用户看到的就是 agent 读得到的。
 *
 * 只记录、只给看：这里没有任何东西会反过来影响 agent（清空只清调用记录，agent 的采集缓冲一条不动）。
 * 内容有变时给浏览器窗口发一个节流过的「变了」（`browser-view:agent-devtools-changed`），窗口自己来取。
 */
import {
  AGENT_DEVTOOLS_TOOLS,
  type AgentDevtoolsCall,
  type AgentDevtoolsSnapshot,
  type AgentDevtoolsTool
} from '../../../shared/browserAgentDevtools'
import { browserCdpManager } from './browserCdpService'
import { agentSessionTitle, getBrowserHostWindow } from './browserViewService'

/** 每一页留多少条调用（超出丢最老的） */
const MAX_CALLS = 200
/** 一条调用的结果最多留多少字（evaluate 能回整页 HTML、read 过的大响应体） */
const MAX_RESULT_CHARS = 20_000
/** 参数 JSON 最多留多少字（evaluate 的长脚本） */
const MAX_PARAMS_CHARS = 8_000
/** 摘要最多多少字 */
const MAX_SUMMARY_CHARS = 160
/** 「变了」最密多久发一次（页面一刷几十个请求，不必每个都推一次） */
const CHANGE_THROTTLE_MS = 150

const TOOLS = new Set<string>(AGENT_DEVTOOLS_TOOLS)

/** tabId（browserViewService 的 UUID）→ 这一页的调用记录（旧 → 新） */
const logs = new Map<string, AgentDevtoolsCall[]>()
let callSeq = 0
/** 已经排上、还没发出去的「变了」 */
const pendingChange = new Map<string, ReturnType<typeof setTimeout>>()

/** 这个工具记不记（devtool 那几个） */
export function isAgentDevtoolsTool(tool: string): tool is AgentDevtoolsTool {
  return TOOLS.has(tool)
}

function clip(text: string, max: number): { text: string; from?: number } {
  return text.length > max ? { text: text.slice(0, max), from: text.length } : { text }
}

function oneLine(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  const more = text.trim().includes('\n') ? ' …' : ''
  const line = first + more
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…` : line
}

/** 调用的一行摘要：用户一眼看出 agent 这次在干什么 */
export function summaryOf(tool: AgentDevtoolsTool, args: Record<string, unknown>): string {
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const has = (k: string): boolean => args[k] !== undefined && args[k] !== null && args[k] !== ''
  switch (tool) {
    case 'evaluate':
      return oneLine(str('expression'))
    case 'cdp':
      return str('method')
    case 'events': {
      const parts = [str('event') || '*']
      if (has('sinceSeq')) parts.push(`sinceSeq ${String(args.sinceSeq)}`)
      if (has('limit')) parts.push(`limit ${String(args.limit)}`)
      return parts.join(' · ')
    }
    case 'network':
    case 'console':
      return has('limit') ? `limit ${String(args.limit)}` : ''
  }
}

/** 参数（不含 tabId）→ 缩进好的 JSON */
function paramsOf(args: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'tabId'))
  if (Object.keys(rest).length === 0) return ''
  let json: string
  try {
    json = JSON.stringify(rest, null, 2) ?? ''
  } catch {
    json = '[unserializable]'
  }
  const { text, from } = clip(json, MAX_PARAMS_CHARS)
  return from ? `${text}\n… (${from} chars)` : text
}

/** 告诉浏览器窗口这一页的内容变了（节流；窗口没开就不发） */
function scheduleChange(tabId: string): void {
  if (pendingChange.has(tabId)) return
  pendingChange.set(
    tabId,
    setTimeout(() => {
      pendingChange.delete(tabId)
      const win = getBrowserHostWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send('browser-view:agent-devtools-changed', {
        tabId,
        callCount: logs.get(tabId)?.length ?? 0
      })
    }, CHANGE_THROTTLE_MS)
  )
}

/**
 * 记一次调用的开始；回「落定时调一下」的函数。tabId 是 browserViewService 的 UUID（宿主已经把 agent
 * 的短号换过来）。
 */
export function recordAgentDevtoolsCall(
  tabId: string,
  sessionId: string,
  tool: AgentDevtoolsTool,
  args: Record<string, unknown>
): (outcome: { ok: boolean; text: string; aborted?: boolean }) => void {
  const call: AgentDevtoolsCall = {
    id: ++callSeq,
    tool,
    sessionId,
    sessionTitle: '',
    startedAt: Date.now(),
    summary: summaryOf(tool, args),
    params: paramsOf(args)
  }
  let log = logs.get(tabId)
  if (!log) {
    log = []
    logs.set(tabId, log)
  }
  log.push(call)
  if (log.length > MAX_CALLS) log.shift()
  scheduleChange(tabId)

  return (outcome) => {
    call.durationMs = Date.now() - call.startedAt
    call.ok = outcome.ok
    if (outcome.aborted) call.aborted = true
    const { text, from } = clip(outcome.text, MAX_RESULT_CHARS)
    call.result = text
    if (from) call.resultTruncatedFrom = from
    // 这一页已经关了（调用跑到一半 tab 没了）：记录随 tab 一起没了，不再通知
    if (logs.get(tabId)?.includes(call)) scheduleChange(tabId)
  }
}

/** agent 的采集缓冲变了（browserCdpService 接 CdpAttachManager 的 onCaptureChange） */
export function noteAgentCaptureChange(tabId: string): void {
  scheduleChange(tabId)
}

/** 这一页记了几次调用（提示条上的计数） */
export function agentDevtoolsCallCount(tabId: string): number {
  return logs.get(tabId)?.length ?? 0
}

/** 停靠区「Agent」页签的全部内容（采集缓冲现取，不 attach） */
export function agentDevtoolsSnapshot(tabId: string): AgentDevtoolsSnapshot {
  const titles = new Map<string, string>()
  const titleOf = (sessionId: string): string => {
    let title = titles.get(sessionId)
    if (title === undefined) {
      title = agentSessionTitle(sessionId)
      titles.set(sessionId, title)
    }
    return title
  }
  const calls = (logs.get(tabId) ?? []).map((c) => ({ ...c, sessionTitle: titleOf(c.sessionId) }))
  const session = browserCdpManager.peek(tabId)
  if (!session) {
    return {
      calls,
      attached: false,
      capturing: { network: false, console: false },
      network: [],
      console: []
    }
  }
  return {
    calls,
    attached: true,
    capturing: session.capturing,
    network: session.getNetworkRequests().map((e) => ({
      id: e.id,
      url: e.url,
      method: e.method,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.mimeType !== undefined ? { mimeType: e.mimeType } : {}),
      completed: e.completed,
      failed: e.failed,
      ...(e.size !== undefined ? { size: e.size } : {})
    })),
    console: session.getConsoleMessages().map((e) => ({ ...e }))
  }
}

/** 用户清空这一页的调用记录（agent 的采集缓冲不动 —— 那是 agent 的） */
export function clearAgentDevtoolsCalls(tabId: string): void {
  if (!logs.delete(tabId)) return
  scheduleChange(tabId)
}

/** tab 关掉了：记录一起丢掉 */
export function forgetAgentDevtools(tabId: string): void {
  logs.delete(tabId)
  const timer = pendingChange.get(tabId)
  if (timer) clearTimeout(timer)
  pendingChange.delete(tabId)
}

/** app 退出 / 测试复位 */
export function resetAgentDevtools(): void {
  for (const timer of pendingChange.values()) clearTimeout(timer)
  pendingChange.clear()
  logs.clear()
}
