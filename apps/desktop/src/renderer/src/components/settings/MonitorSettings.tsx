/**
 * 监视器（桌面设置页）—— 运行时观测的统一去处：智能体 / LLM 请求 / MCP 调用。
 *
 * 子分类走**横向标签条**而不是 MCP/语音那样的第二列：设置窗口默认 820 宽，一级 tab 列
 * 已吃掉 180，再加一列 220 就只剩 240 给正文。横条复用右侧面板的 PanelTabBar，外观一致。
 */
import { useTranslation } from 'react-i18next'
import { FileText, ScrollText, Activity } from 'lucide-react'
import { PanelTabBar } from '@shuvix/app-shell'
import { HttpLogSettings } from './HttpLogSettings'
import { McpServerLogsPanel } from './McpServerLogsPanel'
import { AgentMonitorPanel } from './AgentMonitorPanel'

export type MonitorSubTab = 'agents' | 'httpLogs' | 'mcpCalls'

/** 合法子 tab（供 hash 路由 `#settings/monitor/<sub>` 校验） */
export const MONITOR_SUB_TABS = new Set<string>(['agents', 'httpLogs', 'mcpCalls'])

export function MonitorSettings({
  subTab,
  onSubTabChange
}: {
  subTab: MonitorSubTab
  onSubTabChange: (sub: MonitorSubTab) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelTabBar
        tabs={[
          { key: 'agents', label: t('settings.monitorSubTabAgents'), Icon: Activity },
          { key: 'httpLogs', label: t('settings.monitorSubTabLlm'), Icon: FileText },
          { key: 'mcpCalls', label: t('settings.monitorSubTabMcp'), Icon: ScrollText }
        ]}
        activeKey={subTab}
        onSelect={(key) => onSubTabChange(key as MonitorSubTab)}
        className="px-1 bg-bg-primary"
      />

      <div className="flex-1 min-h-0 flex flex-col">
        {subTab === 'agents' ? (
          <AgentMonitorPanel />
        ) : subTab === 'httpLogs' ? (
          <HttpLogSettings />
        ) : (
          <McpServerLogsPanel />
        )}
      </div>
    </div>
  )
}
