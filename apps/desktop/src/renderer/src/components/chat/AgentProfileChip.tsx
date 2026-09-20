/**
 * 会话横幅最前面的 agent profile 标记 —— 「这个会话的根 agent 跑在哪个 profile 上、现在什么相位」。
 *
 * 与 agent 运行时绑定而非与会话绑定：monitor 列表里出现 `agentId === sessionId` 的 root
 * entry（根 agent 在首轮消息时才创建）才渲染，新会话看不到它。相位灯与 AgentMonitorPanel
 * 的 PHASE_DOT 同一套语义：非 idle 绿色脉冲，idle 灰色。
 *
 * 整条是按钮：点开右栏 agents tab 并按本会话筛选（rootSessionId 匹配，root 与派生 entry
 * 都入选），筛选可由面板工具栏的 chip 清除。数据来自 agentMonitorStore；轮询订阅在
 * ChatView（本组件是纯渲染 —— 它只在 entry 出现后挂载，自持订阅会让新会话等不到第一次拉取）。
 */
import { useTranslation } from 'react-i18next'
import { useAgentMonitorStore } from '../../stores/agentMonitorStore'
import { useBrowserStore } from '../../stores/browserStore'

export function AgentProfileChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const entry = useAgentMonitorStore((s) =>
    s.entries.find((e) => e.kind === 'root' && e.agentId === sessionId)
  )
  if (!entry) return null

  const handleClick = (): void => {
    const panel = useBrowserStore.getState()
    panel.open()
    panel.setActiveTab('agents')
    useAgentMonitorStore.getState().setSessionFilter(sessionId)
  }

  return (
    <button
      onClick={handleClick}
      title={t('panel.agentChipTitle', { profile: entry.profileName })}
      aria-label={t('panel.agentChipTitle', { profile: entry.profileName })}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs transition-colors hover:brightness-110"
      style={{
        color: 'var(--color-accent)',
        backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
      }}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          entry.phase === 'idle' ? 'bg-text-tertiary/40' : 'bg-emerald-500 animate-pulse'
        }`}
      />
      <span className="truncate max-w-[120px] font-mono">{entry.profileName}</span>
    </button>
  )
}
