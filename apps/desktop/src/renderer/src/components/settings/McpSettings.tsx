/**
 * MCP 设置页（桌面）—— 子标签：客户端（复用共享 McpClientPanel，绑 window.api.mcp，允许 stdio）
 * + 服务（McpServerPanel，桌面专属：ShuviX 自身作为 MCP server 暴露）。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Server, PlugZap } from 'lucide-react'
import { McpClientPanel } from '@shuvix/app-shell'
import { McpServerPanel } from './McpServerPanel'

type McpSubTab = 'client' | 'server'

/** 子分类导航按钮（与 ProviderSettings / SkillSettings 视觉一致） */
function SubTabButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <span className="shrink-0 inline-flex items-center h-[18px]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">{label}</div>
      </div>
    </button>
  )
}

export function McpSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<McpSubTab>('client')

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧子导航 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          <SubTabButton
            icon={<PlugZap size={14} className="shrink-0 text-text-tertiary" />}
            label={t('settings.mcpSubTabClient')}
            active={subTab === 'client'}
            onClick={() => setSubTab('client')}
          />
          <SubTabButton
            icon={<Server size={14} className="shrink-0 text-text-tertiary" />}
            label={t('settings.mcpSubTabServer')}
            active={subTab === 'server'}
            onClick={() => setSubTab('server')}
          />
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {subTab === 'client' && <McpClientPanel api={window.api.mcp} caps={{ allowStdio: true }} />}
        {subTab === 'server' && <McpServerPanel />}
      </div>
    </div>
  )
}
