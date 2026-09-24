/**
 * 智能体监控面板（主窗口右侧面板 RightPanel 的「智能体」tab）—— 进程内还活着的全部 agent 运行时。
 *
 * 定位是**资源占用诊断**，不是"谁在跑"。派生 agent 跑完并不销毁（面板要支持继续追问），
 * 桌面端关闭会话时又不级联清理，于是一批早已 idle、却仍完整持有 harness 与内存会话树的
 * agent 会一直堆到进程退出。这个页就是用来把它们指出来的：相位灯区分"在跑"与"赖着"、
 * 「孤儿」徽章标出根会话都没了的、上下文占用条回答"它占着多大一块"，缓存命中率回答
 * "那一块里多少是复用的"。刻意不显示 token 花费与跨 agent 合计 —— 那是成本视角，这页只看
 * 单个 agent 占着什么；命中率是比例不是花费，所以它的原料（累计 token）也不上屏。
 *
 * 列表取数**不含任何遍历**：注册中心的快照全是字段读与事件影子，上下文占用直接来自 pi 判定
 * 自动压缩的那个数。所以每秒轮询的代价与 agent 的历史长度无关。
 *
 * 列表数据来自 `agentMonitorStore`（全局引用计数轮询：横幅上的 profile 标记也消费同一份
 * 快照，同一时刻只有一个 1s 轮询器）。本面板仅在 `active === true` 时订阅 —— RightPanel
 * 常驻挂载所有 tab，不可见时不占轮询份额。工具栏支持按会话筛选（`sessionFilter`，面板级
 * 不持久化）：只显示 rootSessionId 匹配的条目，root 与派生 agent 都入选。
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
import { RefreshCw, Loader2, CornerDownRight, ChevronRight, X, DatabaseZap } from 'lucide-react'
import type {
  AgentMonitorCacheUsage,
  AgentMonitorEntry,
  AgentMonitorPhase
} from '@shuvix/chat-protocol/types/agentMonitor'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import { cacheHitRate } from '@shuvix/chat-protocol/utils/cacheHitRate'
import {
  refreshAgentMonitor,
  subscribeAgentMonitor,
  useAgentMonitorStore
} from '../../stores/agentMonitorStore'

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

export function AgentMonitorPanel({ active }: { active: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const entries = useAgentMonitorStore((s) => s.entries)
  const loading = useAgentMonitorStore((s) => s.loading)
  const sessionFilter = useAgentMonitorStore((s) => s.sessionFilter)
  const setSessionFilter = useAgentMonitorStore((s) => s.setSessionFilter)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 详情不参与轮询（贵），故手动刷新时用它把展开中的那条也重新拉一次
  const [detailNonce, setDetailNonce] = useState(0)

  /** 仅 tab 激活时占一份轮询份额（引用计数：横幅标记可能同时持有一份，不会双份 IPC） */
  useEffect(() => {
    if (!active) return
    return subscribeAgentMonitor()
  }, [active])

  /** 手动刷新（与轮询同源，只是立刻取一次；展开中的详情一并重拉） */
  const refresh = useCallback(async () => {
    setDetailNonce((n) => n + 1)
    await refreshAgentMonitor()
  }, [])

  /** 点同一条 = 收起（手风琴：同时只展开一条） */
  const handleRowClick = (agentId: string): void => {
    setExpandedId((prev) => (prev === agentId ? null : agentId))
  }

  // 会话筛选：rootSessionId 匹配即入选（root 与派生 agent 都算）
  const visible = sessionFilter ? entries.filter((e) => e.rootSessionId === sessionFilter) : entries
  const idleCount = visible.filter((a) => a.phase === 'idle').length
  // 筛选 chip 的标签：优先会话标题，取不到（条目已消失）用 id 截断
  const filterLabel = sessionFilter
    ? entries.find((e) => e.rootSessionId === sessionFilter)?.rootSessionTitle ||
      `${sessionFilter.slice(0, 8)}…`
    : null

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏：总览 + 会话筛选 chip + 刷新 */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-secondary">
        <span className="text-[10px] text-text-tertiary tabular-nums truncate">
          {t('settings.agentMonitorSummary', { total: visible.length, idle: idleCount })}
        </span>
        {sessionFilter && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full bg-accent/10 text-accent text-[10px] shrink-0">
            <span className="truncate max-w-[10rem]">
              {t('panel.agentFilterPrefix')}
              {filterLabel}
            </span>
            <button
              onClick={() => setSessionFilter(null)}
              title={t('panel.agentFilterClear')}
              className="rounded hover:bg-current/20 transition-colors p-0.5"
            >
              <X size={9} />
            </button>
          </span>
        )}
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

      {/* 单列流。面板宽度可拖（320–960px），行与详情按**这个容器**的宽度排版（容器查询），
          不按窗口：窄时一行拆两行、详情改单列；够宽时行回到一行一条的表格式（≥ @xl），
          详情回到两栏（≥ @lg）—— 行多一列定宽的命中率，所以比详情晚一档才并成一行 */}
      <div className="@container flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading')}</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="text-[11px] text-text-tertiary text-center py-10">
            {sessionFilter ? t('panel.agentFilterEmpty') : t('settings.agentMonitorEmpty')}
          </div>
        ) : (
          <div className="divide-y divide-border-secondary/30">
            {visible.map((a) => (
              <div key={a.agentId}>
                {/* 窄：两列网格 —— 左列是相位灯 + 血缘箭头，右列上行「标题 · 徽章 … 时间」、
                    下行「模型 … 占用条 · 命中率」，下行因此天然与标题左对齐（含派生缩进）。
                    宽（@xl）：按钮改 flex，三个分组 span 变 `contents` 退出布局，子元素并成
                    一行，时间靠 order 排到末尾 —— 同一份 DOM，两种排版。
                    标题与模型都可收缩（min-w-0 + truncate），任何宽度下都不会撑出横向滚动。 */}
                <button
                  onClick={() => handleRowClick(a.agentId)}
                  className={`w-full grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 px-3 py-1.5 @xl:flex @xl:gap-3 @xl:px-4 @xl:py-2 text-[11px] hover:bg-bg-hover/40 transition-colors ${
                    expandedId === a.agentId ? 'bg-bg-hover/40' : ''
                  }`}
                >
                  <span className="flex items-center gap-2 @xl:contents">
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
                  </span>
                  <span className="flex items-center gap-2 min-w-0 @xl:contents">
                    <span className="text-text-primary truncate min-w-0 text-left @xl:max-w-[11rem]">
                      {a.kind === 'root' ? a.rootSessionTitle || a.displayName : a.displayName}
                    </span>
                    {!a.rootSessionExists && (
                      <span className="shrink-0 px-1 py-px rounded bg-error/10 text-error text-[9px]">
                        {t('settings.agentMonitorOrphan')}
                      </span>
                    )}
                    <span className="ml-auto text-text-tertiary text-[10px] text-right shrink-0 tabular-nums @xl:order-last @xl:ml-0 @xl:w-20">
                      {t(sinceParts(a.lastActivityAt).key, { n: sinceParts(a.lastActivityAt).n })}
                    </span>
                  </span>
                  <span className="col-start-2 flex items-center gap-2 min-w-0 @xl:contents">
                    <span className="font-mono text-text-tertiary truncate min-w-0 flex-1 text-left text-[10px]">
                      {a.model.id || '—'}
                    </span>
                    <ContextGauge tokens={a.contextTokens} window={a.model.contextWindow} />
                    <CacheHitCell cache={a.cache} />
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
  // 定宽 w-20 只在单行排版（@xl）里要 —— 那时它是一列，靠定宽上下对齐；
  // 窄时它在第二行末尾、按内容宽，空占位也就不再白占一块
  if (tokens <= 0 || ctxWindow <= 0) {
    return <span className="shrink-0 @xl:w-20" />
  }
  const ratio = Math.min(1, tokens / ctxWindow)
  const near = tokens > ctxWindow - 16_000
  return (
    <span className="flex items-center gap-1.5 shrink-0 justify-end @xl:w-20">
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

/** 命中率的百分数文本：行里取整（列窄），详情里保留一位小数 */
function formatRate(rate: number, digits: 0 | 1): string {
  return (rate * 100).toFixed(digits)
}

/**
 * 行里的缓存命中率（自登记起累计）。三种状态要分开画，因为它们回答的是不同的事：
 *  - 还没有完成的调用 → 空占位（与占用条一样，没有数据就不画）；
 *  - 有调用、provider 却从没报过缓存 → 「—」：「上报了 0」与「不上报」在 usage 里都读作 0，
 *    这里不能替它说成 0%，悬停说明两种可能；
 *  - 报过 → 百分数，悬停说明口径。
 * 图标而不是文字标签：日文「キャッシュ」放进定宽列会溢出，完整名称在悬停与详情里。
 */
function CacheHitCell({ cache }: { cache: AgentMonitorCacheUsage }): React.JSX.Element {
  const { t } = useTranslation()
  if (cache.calls === 0) return <span className="shrink-0 @xl:w-12" />
  const rate = cache.reported ? cacheHitRate(cache) : null
  return (
    <span
      title={rate === null ? t('panel.agentCacheUnreportedTitle') : t('panel.agentCacheHitTitle')}
      className="flex items-center gap-1 shrink-0 justify-end text-text-secondary text-[10px] tabular-nums @xl:w-12"
    >
      <DatabaseZap size={10} className="text-text-tertiary shrink-0" />
      {rate === null ? '—' : `${formatRate(rate, 0)}%`}
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
    <div className="px-3 py-3 bg-bg-tertiary/15 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[10px] @xl:px-4 @lg:grid-cols-2">
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
      <CacheHitFields cache={a.cache} />
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
        <div className="col-span-full mt-2 pt-2 border-t border-border-secondary/40 text-text-tertiary">
          {t('settings.agentMonitorDetailUnavailable')}
        </div>
      ) : (
        <>
          {/* 已装载工具 —— 展开一条即看到与实际发给 LLM 一致的 description + 参数名 */}
          <div className="col-span-full mt-2 pt-2 border-t border-border-secondary/40">
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
          <div className="col-span-full mt-2 pt-2 border-t border-border-secondary/40">
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

      <div className="col-span-full pt-2 font-mono text-[9px] text-text-tertiary/70 break-all">
        {a.agentId}
        {a.kind === 'spawned' && ` ← ${a.rootSessionId}`}
      </div>
    </div>
  )
}

/**
 * 详情里的两格命中率：累计（附计入的调用次数）与最近一次。
 * 「—」规则与行里一致：provider 从没报过缓存时两格都说「未上报」，不说 0%。
 */
function CacheHitFields({ cache }: { cache: AgentMonitorCacheUsage }): React.JSX.Element {
  const { t } = useTranslation()
  const unknown =
    cache.calls === 0
      ? t('settings.agentMonitorCacheNone')
      : !cache.reported
        ? t('settings.agentMonitorCacheUnreported')
        : null
  const total = cacheHitRate(cache)
  const last = cache.last ? cacheHitRate(cache.last) : null
  return (
    <>
      <Field label={t('settings.agentMonitorFieldCacheHit')}>
        <span data-cache-hit="total">
          {unknown ??
            (total === null
              ? '—'
              : t('settings.agentMonitorCacheHit', {
                  percent: formatRate(total, 1),
                  calls: cache.calls
                }))}
        </span>
      </Field>
      <Field label={t('settings.agentMonitorFieldCacheLast')}>
        <span data-cache-hit="last">
          {unknown ?? (last === null ? '—' : `${formatRate(last, 1)}%`)}
        </span>
      </Field>
    </>
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
        {/* 名字按内容宽、只在一行都放不下时才截；label 只拿剩下的（basis 0） */}
        <span className="min-w-0 truncate font-mono text-text-primary">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-text-tertiary">{tool.label}</span>
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
