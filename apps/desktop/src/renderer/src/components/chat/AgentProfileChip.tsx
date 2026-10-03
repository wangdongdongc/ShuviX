/**
 * 会话横幅最前面的 agent 标记 —— 「这个会话的根 agent 是谁、现在什么相位」。
 *
 * 与 agent 运行时绑定而非与会话绑定：monitor 列表里出现 `agentId === sessionId` 的 root
 * entry（根 agent 在首轮消息时才创建）才渲染，新会话看不到它。名字是档案 md 的显示名
 * （`shuvix-displayName`，没写回落档案名），档案名放在悬停提示里。相位灯与 AgentMonitorPanel
 * 的 PHASE_DOT 同一套语义：非 idle 绿色脉冲，idle 灰色。
 *
 * 两个按钮并排（按钮不能套按钮）：
 *  - 主体：点开右栏 agents tab 并按本会话筛选（rootSessionId 匹配，root 与派生 entry 都入选），
 *    筛选可由面板工具栏的 chip 清除；
 *  - X：销毁这个运行时（`agent.destroy`）。会话与历史都在，模型与扩展能力勾选随之解锁，下一条
 *    消息按那时的选择重建 —— 这是「换模型 / 换扩展能力」的唯一入口。正在跑的 run 会被中止，
 *    与回退、清空同一口径。
 *
 * 数据来自 agentMonitorStore；轮询订阅在 ChatView（本组件是纯渲染 —— 它只在 entry 出现后挂载，
 * 自持订阅会让新会话等不到第一次拉取）。销毁后立即重拉一次，标记不必等下一个轮询周期才消失。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { refreshAgentMonitor, useAgentMonitorStore } from '../../stores/agentMonitorStore'
import { useBrowserStore } from '../../stores/browserStore'

export function AgentProfileChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const entry = useAgentMonitorStore((s) =>
    s.entries.find((e) => e.kind === 'root' && e.agentId === sessionId)
  )
  const [destroying, setDestroying] = useState(false)
  if (!entry) return null

  const handleOpenPanel = (): void => {
    const panel = useBrowserStore.getState()
    panel.open()
    panel.setActiveTab('agents')
    useAgentMonitorStore.getState().setSessionFilter(sessionId)
  }

  const handleDestroy = async (): Promise<void> => {
    if (destroying) return
    setDestroying(true)
    try {
      await window.api.agent.destroy(sessionId)
    } catch (err) {
      // 销毁没成：运行时还在，标记照旧（下面这次重拉会如实反映），X 恢复可点
      console.warn('[AgentProfileChip] destroy failed', err)
    }
    // 重拉不会抛（失败保留旧快照）；落定之前 X 一直禁用，免得重拉回来之前又能点一次
    await refreshAgentMonitor()
    setDestroying(false)
  }

  const name = entry.displayName || entry.profileName
  const openTitle = t('panel.agentChipTitle', { name, profile: entry.profileName })
  const destroyTitle = t('panel.agentChipDestroy')

  return (
    <span
      data-agent-chip={entry.profileName}
      className="inline-flex items-center rounded-full text-xs"
      style={{
        color: 'var(--color-accent)',
        backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
      }}
    >
      <button
        onClick={handleOpenPanel}
        title={openTitle}
        aria-label={openTitle}
        className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full transition-colors hover:brightness-110"
      >
        <span
          data-agent-chip-phase
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            entry.phase === 'idle' ? 'bg-text-tertiary/40' : 'bg-emerald-500 animate-pulse'
          }`}
        />
        <span data-agent-chip-name className="truncate max-w-[120px]">
          {name}
        </span>
      </button>
      <button
        data-agent-chip-destroy
        onClick={() => void handleDestroy()}
        disabled={destroying}
        title={destroyTitle}
        aria-label={destroyTitle}
        className="mr-1 rounded hover:bg-current/20 transition-colors p-0.5 disabled:opacity-40 disabled:cursor-default"
      >
        <X size={10} />
      </button>
    </span>
  )
}
