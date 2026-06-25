import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollText } from 'lucide-react'
import { getChatApi } from '@shuvix/chat-ui'
import { Toggle } from './SettingsPrimitives'
import { SystemPromptSettings } from './SystemPromptSettings'

/** 子分类标识 */
type ContextSubTab = 'systemPrompt'

/**
 * 上下文管理 Tab（桌面/扩展共用）—— 系统提示词等与对话上下文相关的设置。
 *
 * 总开关 general.systemPromptEnabled 经 getChatApi().settings 读写，宿主无关。
 */
export function ContextManagementSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<ContextSubTab>('systemPrompt')
  const [systemPromptEnabled, setSystemPromptEnabled] = useState(true)

  useEffect(() => {
    void getChatApi()
      .settings.get('general.systemPromptEnabled')
      .then((v) => setSystemPromptEnabled(v !== 'false'))
  }, [])

  const handleToggleSystemPrompt = (): void => {
    const next = !systemPromptEnabled
    setSystemPromptEnabled(next)
    void getChatApi().settings.set({
      key: 'general.systemPromptEnabled',
      value: next ? 'true' : 'false'
    })
  }

  const systemPromptActive = subTab === 'systemPrompt'

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧子导航：每个二级 Tab 行末挂总开关（与 Skill/Provider 一致） */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          <button
            onClick={() => setSubTab('systemPrompt')}
            className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
              systemPromptActive
                ? 'bg-accent/10 text-accent'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            } ${!systemPromptEnabled ? 'opacity-60' : ''}`}
          >
            {/* 18px 高度槽位 — 与行末 Toggle 同高，保证按钮总高 30px 与 Skill/Provider 一致 */}
            <span className="shrink-0 inline-flex items-center h-[18px]">
              <ScrollText size={14} className="shrink-0 text-text-tertiary" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate">{t('settings.tabSystemPrompt')}</div>
            </div>
            <span onClick={(e) => e.stopPropagation()} className="shrink-0">
              <Toggle on={systemPromptEnabled} onClick={handleToggleSystemPrompt} />
            </span>
          </button>
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {subTab === 'systemPrompt' && <SystemPromptSettings enabled={systemPromptEnabled} />}
      </div>
    </div>
  )
}
