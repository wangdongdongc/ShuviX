import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronRight, Cpu, RefreshCw, ScrollText, Wrench } from 'lucide-react'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import { getHostApi } from '@shuvix/chat-ui'

/**
 * AgentInfoPanel —— 会话面板「Agent」标签页（桌面 / 扩展共用）。
 *
 * 只读展示运行时 Agent 对象的实时状态（模型 / 运行状态 / 已装载工具 / systemPrompt）：
 * 数据经 HostApi.agent.getInfo 直接读自后端内存中的 agent.state，与实际下发给 LLM 的内容零漂移。
 *
 * 「打开即建」：Agent 本是懒创建（首次发消息才有），本页以 `ensure: true` 拉取 —— 后端顺带
 * 按会话配置把 Agent 建出来（构造运行时不请求 LLM），所以未发过消息的会话也能看到完整信息。
 * 拉取时机由宿主的 `active` 驱动（每次切到本页即刷新一次快照），面板停在其它工具页时不拉取，
 * 避免仅仅打开 Files 就把 Agent 拉起来。
 */
export interface AgentInfoPanelProps {
  sessionId: string | null
  /** 本页当前是否为面板的激活工具页（false 时不拉取，保留上次快照） */
  active: boolean
}

/** 将 token 数格式化为紧凑显示（如 128k） */
function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * 分区 —— 图标 + 标题 + 右侧附注，靠「发丝分隔线 + 留白」分组，不套盒子。
 *
 * 刻意不用卡片：外层会话面板本身已是一张卡，页内再嵌卡片（分区卡 → 工具行卡 → 代码块）
 * 会叠出三四层边框，窄栏里显得很碎。分区感由标题层级与分隔线承担。
 */
function Section({
  icon,
  title,
  extra,
  children
}: {
  icon: React.ReactNode
  title: string
  extra?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-3 pt-3 border-t border-border-secondary/40 first:mt-0 first:pt-0 first:border-t-0">
      <div className="flex items-center gap-1.5 px-0.5 pb-1">
        <span className="text-text-tertiary">{icon}</span>
        <span className="text-[11px] font-semibold text-text-primary">{title}</span>
        {extra && <span className="ml-auto text-[10px] text-text-tertiary">{extra}</span>}
      </div>
      {children}
    </section>
  )
}

/** 键值对行（面板窄，label 靠左、value 靠右换行） */
function InfoRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-0.5 py-0.5">
      <span className="flex-shrink-0 text-[11px] text-text-tertiary">{label}</span>
      <span className="ml-auto min-w-0 text-right text-[11px] text-text-primary break-all">
        {value}
      </span>
    </div>
  )
}

/** 单个工具行 —— 点击展开与发给 LLM 一致的 description + 参数名（展开内容靠左侧竖线归属，不套盒） */
function ToolRow({
  tool,
  paramsLabel
}: {
  tool: AgentRuntimeInfo['tools'][number]
  paramsLabel: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1 px-0.5 py-1 rounded text-left hover:bg-bg-hover/50 transition-colors"
      >
        <ChevronRight
          size={11}
          className={`flex-shrink-0 text-text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="text-[11px] font-mono text-text-primary">{tool.name}</span>
        <span className="min-w-0 truncate text-[10px] text-text-tertiary">{tool.label}</span>
      </button>
      {expanded && (
        <div className="ml-[9px] pl-2 border-l border-border-secondary/60 space-y-1 pb-1">
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-text-secondary">
            {tool.description}
          </pre>
          {tool.parameters.length > 0 && (
            <div className="text-[10px] text-text-tertiary">
              {paramsLabel}{' '}
              <span className="font-mono text-text-secondary">{tool.parameters.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function AgentInfoPanel({ sessionId, active }: AgentInfoPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  // 刷新计数：点刷新按钮 +1（切会话 / 切到本页由 requestKey 的另两维覆盖）
  const [reloadNonce, setReloadNonce] = useState(0)
  // 本次请求的身份：会话 + 刷新计数；未激活为 null（不拉取）
  const requestKey = active && sessionId ? `${sessionId}#${reloadNonce}` : null
  // 快照连同它对应的 requestKey 一起存 —— 键不匹配即「本次请求尚未返回」，
  // 无需在 effect 里同步 setState 清空（那会触发级联渲染，也被 lint 拦）
  const [snapshot, setSnapshot] = useState<{ key: string; info: AgentRuntimeInfo | null } | null>(
    null
  )
  // undefined = 加载中（含首次创建 Agent）；null = 取不到（会话不存在 / 创建失败）
  const info = snapshot && snapshot.key === requestKey ? snapshot.info : undefined
  const loading = requestKey !== null && info === undefined

  useEffect(() => {
    if (!requestKey || !sessionId) return
    let alive = true
    const host = getHostApi()
    const pending = host
      ? // ensure：Agent 未创建时按会话配置就地创建（不请求 LLM），使本页无需先发消息即可用
        host.agent.getInfo(sessionId, { ensure: true })
      : Promise.resolve(null)
    pending
      .then((result) => {
        if (alive) setSnapshot({ key: requestKey, info: result })
      })
      .catch(() => {
        if (alive) setSnapshot({ key: requestKey, info: null })
      })
    return () => {
      alive = false
    }
  }, [requestKey, sessionId])

  const handleRefresh = useCallback(() => setReloadNonce((n) => n + 1), [])

  return (
    <div className="h-full flex flex-col bg-bg-secondary">
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-2 h-7 border-b border-border-secondary/30">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary truncate">
          {t('agentInfo.title')}
        </span>
        <button
          onClick={handleRefresh}
          disabled={!sessionId || loading}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex-shrink-0"
          title={t('agentInfo.refresh')}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* thin-scrollbar：本页整块都靠这里滚（系统提示词全文铺开），滚动条压到细+淡、hover 才略显 */}
      <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar px-2 py-2">
        {info === undefined ? (
          <div className="py-8 text-center text-[11px] text-text-tertiary">
            {t('agentInfo.loading')}
          </div>
        ) : info === null ? (
          <div className="py-8 text-center text-[11px] text-text-tertiary">
            {t('agentInfo.unavailable')}
          </div>
        ) : (
          <>
            {/* 模型 */}
            <Section icon={<Cpu size={12} />} title={t('agentInfo.model')}>
              <InfoRow
                label={t('agentInfo.modelId')}
                value={
                  <span className="font-mono">
                    {info.model.provider}/{info.model.id}
                  </span>
                }
              />
              {info.model.name !== info.model.id && (
                <InfoRow label={t('agentInfo.modelName')} value={info.model.name} />
              )}
              <InfoRow label={t('agentInfo.api')} value={info.model.api} />
              <InfoRow
                label={t('agentInfo.contextWindow')}
                value={`${formatTokens(info.model.contextWindow)} tokens`}
              />
              <InfoRow
                label={t('agentInfo.maxTokens')}
                value={`${formatTokens(info.model.maxTokens)} tokens`}
              />
              <InfoRow label={t('agentInfo.inputModes')} value={info.model.input.join(' + ')} />
            </Section>

            {/* 运行状态 */}
            <Section icon={<Activity size={12} />} title={t('agentInfo.runtime')}>
              <InfoRow
                label={t('agentInfo.status')}
                value={
                  info.isStreaming ? (
                    <span className="text-accent">{t('agentInfo.streaming')}</span>
                  ) : (
                    t('agentInfo.idle')
                  )
                }
              />
              <InfoRow
                label={t('agentInfo.thinkingLevel')}
                value={
                  info.model.reasoning
                    ? info.thinkingLevel
                    : `${info.thinkingLevel} (${t('agentInfo.reasoningUnsupported')})`
                }
              />
              <InfoRow label={t('agentInfo.messageCount')} value={String(info.messageCount)} />
            </Section>

            {/* 已装载工具 —— 读自 agent.state.tools */}
            <Section
              icon={<Wrench size={12} />}
              title={t('agentInfo.tools')}
              extra={t('agentInfo.toolCount', { count: info.tools.length })}
            >
              {info.tools.length === 0 ? (
                <div className="py-2 text-center text-[10px] text-text-tertiary">
                  {t('agentInfo.noTools')}
                </div>
              ) : (
                <div>
                  {info.tools.map((tool) => (
                    <ToolRow key={tool.name} tool={tool} paramsLabel={t('agentInfo.params')} />
                  ))}
                </div>
              )}
            </Section>

            {/* 系统提示词 —— 与实际下发给 LLM 的完全一致。放在最末、不限高也不套盒，全文铺开：
                它通常是本页最长的一块，嵌套滚动区会把面板变成「滚动条套滚动条」，
                改由面板自身滚动到底即可读完 */}
            <Section
              icon={<ScrollText size={12} />}
              title={t('agentInfo.systemPrompt')}
              extra={t('agentInfo.charCount', { count: info.systemPrompt.length })}
            >
              <pre className="whitespace-pre-wrap break-words px-0.5 font-mono text-[10px] leading-relaxed text-text-secondary">
                {info.systemPrompt || t('agentInfo.emptySystemPrompt')}
              </pre>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
