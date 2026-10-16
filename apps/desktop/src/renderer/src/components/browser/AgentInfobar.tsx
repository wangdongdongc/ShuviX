import { useTranslation } from 'react-i18next'
import { selectedTab, useBrowserTabsStore } from '../../stores/browserTabsStore'
import { INTERCEPTING_DOT_COLOR, sessionDotColor } from './sessionColor'

/**
 * 提示条 —— 选中的那一页正接着 agent 时，工具条下面一行：「〈会话〉正在使用此页面 · 查看对话」。
 *
 * Chrome 的「正受到自动测试软件的控制」那一条的位置。桌面的 CDP 接入跨轮持久、没有原生横幅，标签上的圆点
 * 之外这是用户看得见「这页在 agent 手里」的地方；开了请求拦截时换成警示的说法（页面内容可能被改写）。
 * 「查看对话」把主窗口拉到前面并切到那个会话 —— 是用户自己点的，不违反「agent 不打扰用户」。
 */
export function AgentInfobar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const tab = useBrowserTabsStore(selectedTab)
  if (!tab || !(tab.cdpAttached || tab.cdpIntercepting)) return null

  const session = tab.agentSessionTitle?.trim()
  const key = tab.cdpIntercepting
    ? session
      ? 'browser.infobar.intercepting'
      : 'browser.infobar.interceptingUnknown'
    : session
      ? 'browser.infobar.using'
      : 'browser.infobar.usingUnknown'
  const dot = tab.cdpIntercepting
    ? INTERCEPTING_DOT_COLOR
    : tab.agentSessionId
      ? sessionDotColor(tab.agentSessionId)
      : 'var(--color-text-tertiary)'

  return (
    <div
      className={`flex-shrink-0 flex items-center gap-2 h-8 px-3 border-b text-[12px] ${
        tab.cdpIntercepting
          ? 'bg-amber-500/10 border-amber-500/30 text-text-primary'
          : 'bg-bg-secondary border-border-secondary/40 text-text-secondary'
      }`}
      data-agent-infobar={tab.agentSessionId ?? ''}
      data-intercepting={tab.cdpIntercepting ? 'true' : undefined}
    >
      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: dot }} />
      <span className="flex-1 min-w-0 truncate">{t(key, { session })}</span>
      {tab.agentSessionId && (
        <button
          onClick={() => void window.api.browserView.openSession(tab.agentSessionId!)}
          className="flex-shrink-0 px-2 py-0.5 rounded-md border border-border-secondary/70 text-text-primary hover:bg-bg-hover/60 transition-colors"
          data-agent-infobar-open
        >
          {t('browser.infobar.openSession')}
        </button>
      )}
    </div>
  )
}
