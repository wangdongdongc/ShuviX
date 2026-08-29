/**
 * 智能体监控面板（监视器 tab 的子页）—— 进程内还活着的全部 agent 运行时。
 *
 * 定位是**资源占用诊断**，不是"谁在跑"。派生 agent 跑完并不销毁（面板要支持继续追问），
 * 桌面端关闭会话时又不级联清理，于是一批早已 idle、却仍完整持有 harness 与内存会话树的
 * agent 会一直堆到进程退出。这个页就是用来把它们指出来的：相位灯区分"在跑"与"赖着"、
 * 「孤儿」徽章标出根会话都没了的、上下文占用条回答"它占着多大一块"。刻意不显示 token
 * 花费与跨 agent 合计 —— 那是成本视角，这页只看单个 agent 占着什么。
 *
 * 列表取数**不含任何遍历**：注册中心的快照全是字段读与事件影子，上下文占用直接来自 pi 判定
 * 自动压缩的那个数。所以每秒轮询的代价与 agent 的历史长度无关。
 *
 * 展开一条才拉「详情」（`AgentDetail`）—— 系统提示词全文、工具定义、模型细节，
 * 全部读自内存里的运行时对象，与实际下发给 LLM 的零漂移（这半边原先住在会话面板的
 * Agent 页，那页已撤；此处是它唯一的去处，故连派生 agent 也一并覆盖）。它要重建一次
 * 上下文，绝不能并进每秒轮询的列表。
 *
 * 沿用 MCP 调用日志的单列流 + 就地展开（手风琴），没有第二个可滚动区。
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Loader2, CornerDownRight, ChevronRight } from 'lucide-react'
import type { AgentMonitorEntry, AgentMonitorPhase } from '@shuvix/chat-protocol/types/agentMonitor'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'

/** 轮询间隔：相位/活动时间要看着是活的，又不值得铺跨窗口事件推送（设置页是独立窗口） */
const POLL_MS = 1000

/** 相位灯配色：只有 idle 是"静止"，其余都在占用 CPU/网络 */
const PHASE_DOT: Record<AgentMonitorPhase, string> = {
  idle: 'bg-text-tertiary/40',
  turn: 'bg-emerald-500',
  compaction: 'bg-amber-500',
  branch_summary: 'bg-sky-500'
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * 相对时间的文案键 + 数值：诊断时关心的是"多久没动静了"，绝对时刻反而要心算。
 * 只返回参数、由调用处 t() —— 免得把 i18next 的 TFunction 类型签进工具函数。
 */
function sinceParts(ts: number): { key: string; n: number } {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return { key: 'settings.agentMonitorSinceSec', n: sec }
  if (sec < 3600) return { key: 'settings.agentMonitorSinceMin', n: Math.floor(sec / 60) }
  return { key: 'settings.agentMonitorSinceHour', n: Math.floor(sec / 3600) }
}

export function AgentMonitorPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentMonitorEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 详情不参与轮询（贵），故手动刷新时用它把展开中的那条也重新拉一次
  const [detailNonce, setDetailNonce] = useState(0)

  /**
   * 轮询。取数与定时器都收在 effect 内，并自持一个取消位 —— 拉取是异步 IPC，
   * 组件卸载（切子 tab / 关设置窗）时可能还有一次在途请求，回来时若照常 setState
   * 就是对已卸载组件写状态。
   */
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      const rows = await window.api.agent.monitorList()
      if (cancelled) return
      setAgents(rows)
      setLoading(false)
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  /** 手动刷新（与轮询同源，只是立刻取一次；展开中的详情一并重拉） */
  const refresh = useCallback(async () => {
    setDetailNonce((n) => n + 1)
    setAgents(await window.api.agent.monitorList())
  }, [])

  /** 点同一条 = 收起（手风琴：同时只展开一条） */
  const handleRowClick = (agentId: string): void => {
    setExpandedId((prev) => (prev === agentId ? null : agentId))
  }

  const idleCount = agents.filter((a) => a.phase === 'idle').length

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏：总览 + 测量全部 + 刷新 */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-secondary">
        <span className="text-[10px] text-text-tertiary tabular-nums truncate">
          {t('settings.agentMonitorSummary', { total: agents.length, idle: idleCount })}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            onClick={() => void refresh()}
            title={t('common.refresh')}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* 单列流 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading')}</span>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-[11px] text-text-tertiary text-center py-10">
            {t('settings.agentMonitorEmpty')}
          </div>
        ) : (
          <div className="divide-y divide-border-secondary/30">
            {agents.map((a) => (
              <div key={a.agentId}>
                <button
                  onClick={() => handleRowClick(a.agentId)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-[11px] hover:bg-bg-hover/40 transition-colors ${
                    expandedId === a.agentId ? 'bg-bg-hover/40' : ''
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${PHASE_DOT[a.phase]} ${
                      a.phase === 'idle' ? '' : 'animate-pulse'
                    }`}
                  />
                  {/* 派生 agent 用箭头 + 缩进标记血缘：列表按血缘分组排序（父在上、子紧随），
                      所以箭头指的就是紧邻的上一行；再按 depth 递进缩进，是为了把"上一行派出的"
                      与"和上一行同父的兄弟"分开 —— 两者都是派生 agent，只差一层。 */}
                  {a.kind === 'spawned' && (
                    <CornerDownRight
                      size={11}
                      className="text-text-tertiary/60 shrink-0"
                      style={{ marginLeft: (a.depth - 1) * 12 }}
                    />
                  )}
                  <span className="text-text-primary truncate max-w-[11rem] shrink-0 text-left">
                    {a.kind === 'root' ? a.rootSessionTitle || a.displayName : a.displayName}
                  </span>
                  {!a.rootSessionExists && (
                    <span className="shrink-0 px-1 py-px rounded bg-error/10 text-error text-[9px]">
                      {t('settings.agentMonitorOrphan')}
                    </span>
                  )}
                  <span className="font-mono text-text-tertiary truncate flex-1 text-left text-[10px]">
                    {a.model.id || '—'}
                  </span>
                  <ContextGauge tokens={a.contextTokens} window={a.model.contextWindow} />
                  <span className="text-text-tertiary text-[10px] w-20 text-right shrink-0 tabular-nums">
                    {t(sinceParts(a.lastActivityAt).key, { n: sinceParts(a.lastActivityAt).n })}
                  </span>
                </button>

                {expandedId === a.agentId && <AgentDetail entry={a} nonce={detailNonce} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 上下文占用条。数值本身（provider 真实用量）比"多少字节"更贴近用户关心的问题 ——
 * 离自动压缩还有多远。阈值配色对齐 pi 的判定：超过 contextWindow 减去 16k 保留区就要压缩了。
 */
function ContextGauge({
  tokens,
  window: ctxWindow
}: {
  tokens: number
  window: number
}): React.JSX.Element {
  if (tokens <= 0 || ctxWindow <= 0) {
    return <span className="w-20 shrink-0" />
  }
  const ratio = Math.min(1, tokens / ctxWindow)
  const near = tokens > ctxWindow - 16_000
  return (
    <span className="flex items-center gap-1.5 w-20 shrink-0 justify-end">
      <span className="relative h-1 w-8 rounded-full bg-bg-tertiary overflow-hidden">
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${near ? 'bg-amber-500' : 'bg-accent/60'}`}
          style={{ width: `${Math.max(2, ratio * 100)}%` }}
        />
      </span>
      <span className="text-text-secondary text-[10px] tabular-nums">{formatCount(tokens)}</span>
    </span>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="text-text-tertiary shrink-0">{label}</span>
      <span className="text-text-secondary truncate">{children}</span>
    </div>
  )
}

/**
 * 展开的条目：列表侧的廉价快照 + 一次性拉来的运行时详情（系统提示词 / 工具定义 / 模型细节）。
 *
 * 详情只在展开时挂载才拉取，收起即卸载 —— 它要重建一次上下文，进不了每秒轮询的列表。
 * `nonce` 由工具栏刷新按钮驱动（展开期间不自动更新：系统提示词本就不常变）。
 *
 * 字段刻意不与折叠行重复：行里已有相位灯、会话标题、模型 id、上下文占用条，所以这里
 * 只补它们说不出的那部分（相位名 + 在跑的工具、模型全名/协议、精确占用与窗口…），
 * 「所属会话」也只对派生 agent 出现 —— 根 agent 的行标题本就是会话标题。
 */
function AgentDetail({
  entry: a,
  nonce
}: {
  entry: AgentMonitorEntry
  nonce: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [promptOpen, setPromptOpen] = useState(false)
  // 本次请求的身份。快照连同它一起存 —— 键不匹配即「本次请求尚未返回」，
  // 无需在 effect 里同步 setState 清空（那会触发级联渲染，也被 lint 拦）
  const requestKey = `${a.agentId}#${nonce}`
  const [snapshot, setSnapshot] = useState<{ key: string; info: AgentRuntimeInfo | null } | null>(
    null
  )
  // undefined = 加载中；null = 取不到（轮询与点击之间 agent 恰好被销毁）
  const info = snapshot?.key === requestKey ? snapshot.info : undefined

  useEffect(() => {
    let cancelled = false
    window.api.agent
      .monitorDetail(a.agentId)
      .then((res) => {
        if (!cancelled) setSnapshot({ key: requestKey, info: res })
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ key: requestKey, info: null })
      })
    return () => {
      cancelled = true
    }
  }, [a.agentId, requestKey])

  /** 详情未到位的占位（详情字段照常占格，避免数据落地时整块跳动） */
  const pending = info === undefined ? '…' : '—'

  return (
    <div className="px-4 py-3 bg-bg-tertiary/15 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[10px]">
      <Field label={t('settings.agentMonitorFieldProfile')}>
        <span className="font-mono">{a.profileName}</span>
        <span className="text-text-tertiary ml-1">
          {a.kind === 'root'
            ? t('settings.agentMonitorKindRoot')
            : t('settings.agentMonitorKindSpawned', { depth: a.depth })}
        </span>
      </Field>
      <Field label={t('settings.agentMonitorFieldPhase')}>
        {t(`settings.agentMonitorPhase_${a.phase}`)}
        {a.activeToolName && <span className="font-mono text-accent ml-1">{a.activeToolName}</span>}
      </Field>
      {/* 模型与提供商分开列：两者都可能被用户命名成相似的串（自定义提供商叫
          "kimi-coding"、模型叫 "kimi-for-coding-highspeed"），挤在一个
          「模型」标签下会读成自相矛盾。模型 id 与行内显示的保持同一个值，
          人类可读名只在与 id 不同时补在括号里（多数模型两者相同，另起一行是纯噪音）。 */}
      <Field label={t('settings.agentMonitorFieldModel')}>
        <span className="font-mono">{a.model.id || '—'}</span>
        {info && info.model.name !== info.model.id && (
          <span className="text-text-tertiary ml-1">（{info.model.name}）</span>
        )}
      </Field>
      <Field label={t('settings.agentMonitorFieldProvider')}>
        {a.model.provider || '—'}
        <span className="text-text-tertiary ml-1">· {info ? info.model.api : pending}</span>
      </Field>
      <Field label={t('settings.agentMonitorFieldThinking')}>{a.thinkingLevel}</Field>
      <Field label={t('settings.agentMonitorFieldMaxTokens')}>
        {info ? formatCount(info.model.maxTokens) : pending}
      </Field>
      <Field label={t('settings.agentMonitorFieldInput')}>
        {info ? info.model.input.join(' + ') : pending}
      </Field>
      <Field label={t('settings.agentMonitorFieldTools')}>
        {a.activeToolCount} / {a.toolCount}
      </Field>
      <Field label={t('settings.agentMonitorFieldContext')}>
        {a.contextTokens > 0
          ? t('settings.agentMonitorContext', {
              tokens: formatCount(a.contextTokens),
              window: formatCount(a.model.contextWindow),
              percent: Math.round((a.contextTokens / a.model.contextWindow) * 100)
            })
          : t('settings.agentMonitorContextNone')}
      </Field>
      <Field label={t('settings.agentMonitorFieldMessages')}>
        {info ? info.messageCount : pending}
      </Field>
      <Field label={t('settings.agentMonitorFieldQueue')}>
        {a.queue.steer} / {a.queue.followUp} / {a.queue.nextTurn}
      </Field>
      <Field label={t('settings.agentMonitorFieldCounters')}>
        {t('settings.agentMonitorCounters', {
          turns: a.counters.turns,
          tools: a.counters.toolCalls,
          requests: a.counters.providerRequests
        })}
      </Field>
      <Field label={t('settings.agentMonitorFieldStarted')}>
        {new Date(a.startedAt).toLocaleString()}
      </Field>
      {/* 所属会话只对派生 agent 有信息量：根 agent 的行标题就是会话标题，孤儿也已由行内徽章说明 */}
      {a.kind === 'spawned' && (
        <Field label={t('settings.agentMonitorFieldSession')}>
          {a.rootSessionExists ? (
            a.rootSessionTitle || a.rootSessionId
          ) : (
            <span className="text-error">{t('settings.agentMonitorOrphanHint')}</span>
          )}
        </Field>
      )}

      {info === null ? (
        <div className="col-span-2 mt-2 pt-2 border-t border-border-secondary/40 text-text-tertiary">
          {t('settings.agentMonitorDetailUnavailable')}
        </div>
      ) : (
        <>
          {/* 已装载工具 —— 展开一条即看到与实际发给 LLM 一致的 description + 参数名 */}
          <div className="col-span-2 mt-2 pt-2 border-t border-border-secondary/40">
            <div className="pb-1 font-semibold text-text-secondary">
              {t('settings.agentMonitorToolsSection', { count: info?.tools.length ?? a.toolCount })}
            </div>
            {!info ? (
              <div className="flex items-center gap-1.5 text-text-tertiary">
                <Loader2 size={11} className="animate-spin" />
                {t('common.loading')}
              </div>
            ) : info.tools.length === 0 ? (
              <div className="text-text-tertiary">{t('settings.agentMonitorNoTools')}</div>
            ) : (
              info.tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)
            )}
          </div>

          {/* 系统提示词 —— 默认折叠：它常有上万字符，展开的条目在单列流里会把后面的条目推到天边 */}
          <div className="col-span-2 mt-2 pt-2 border-t border-border-secondary/40">
            <button
              disabled={!info}
              onClick={() => setPromptOpen((v) => !v)}
              className="flex items-center gap-1 w-full py-0.5 text-left hover:text-text-primary transition-colors"
            >
              <ChevronRight
                size={11}
                className={`shrink-0 text-text-tertiary transition-transform ${promptOpen ? 'rotate-90' : ''}`}
              />
              <span className="font-semibold text-text-secondary">
                {t('settings.agentMonitorSystemPrompt')}
              </span>
              <span className="ml-auto text-text-tertiary tabular-nums">
                {info
                  ? t('settings.agentMonitorSystemPromptChars', { count: info.systemPrompt.length })
                  : pending}
              </span>
            </button>
            {promptOpen && info && (
              <pre className="mt-1 ml-[9px] pl-2 border-l border-border-secondary/60 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-text-secondary">
                {info.systemPrompt || t('settings.agentMonitorEmptySystemPrompt')}
              </pre>
            )}
          </div>
        </>
      )}

      <div className="col-span-2 pt-2 font-mono text-[9px] text-text-tertiary/70 break-all">
        {a.agentId}
        {a.kind === 'spawned' && ` ← ${a.rootSessionId}`}
      </div>
    </div>
  )
}

/** 单个工具行 —— 点击展开与发给 LLM 一致的 description + 参数名（靠左侧竖线归属，不套盒） */
function ToolRow({ tool }: { tool: AgentRuntimeInfo['tools'][number] }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1 py-0.5 rounded text-left hover:bg-bg-hover/50 transition-colors"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-mono text-text-primary">{tool.name}</span>
        <span className="min-w-0 truncate text-text-tertiary">{tool.label}</span>
      </button>
      {expanded && (
        <div className="ml-[9px] pl-2 border-l border-border-secondary/60 space-y-1 pb-1">
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-text-secondary">
            {tool.description}
          </pre>
          {tool.parameters.length > 0 && (
            <div className="text-text-tertiary">
              {t('settings.agentMonitorToolParams')}{' '}
              <span className="font-mono text-text-secondary">{tool.parameters.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
