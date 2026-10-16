import { useEffect, useState } from 'react'
import { Globe, Settings, TriangleAlert } from 'lucide-react'
import { internalPageOfTab, type BrowserTabInfo } from '../../stores/browserTabsStore'
import { INTERCEPTING_DOT_COLOR, sessionDotColor } from './sessionColor'

/** agent 动作一下之后，圆点脉动多久 */
const AGENT_PULSE_MS = 2000

/**
 * `at`（刚到的一次动作提示）之后 ms 毫秒内为 true，到点自己翻回 false。
 * 渲染里不读时钟：到点的计时器把「这一次已经过期」记下来，下一次动作带着新的 at 重新开始。
 */
function useRecent(at: number | undefined, ms: number): boolean {
  const [expired, setExpired] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!at) return
    const timer = setTimeout(() => setExpired(at), Math.max(0, at + ms - Date.now()))
    return () => clearTimeout(timer)
  }, [at, ms])
  return !!at && expired !== at
}

/**
 * 标签的图标位：加载中转圈、崩了换警示图标，否则站点图标（取不到回落地球）。
 *
 * 右下角的圆点 = 这页此刻接着 agent（CDP 已接入）：颜色是最近在这页上动作的那个会话的颜色
 * （与用户 Chrome 里那条会话的标签组同色），开了请求拦截时换成琥珀色；agent 刚动作过的两秒里脉动。
 * 标签条、平铺墙的卡片头共用它。
 */
export function TabFavicon({
  tab,
  size = 14
}: {
  tab: BrowserTabInfo
  size?: number
}): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  const pulsing = useRecent(tab.agentActiveAt, AGENT_PULSE_MS)
  const icon = internalPageOfTab(tab) ? (
    <Settings size={size} className="text-text-secondary" />
  ) : tab.loadError?.crashed ? (
    <TriangleAlert size={size} className="text-amber-500" />
  ) : tab.isLoading ? (
    <span
      className="block rounded-full border-[1.5px] border-accent border-t-transparent animate-spin"
      style={{ width: size - 2, height: size - 2, margin: 1 }}
    />
  ) : tab.favicon && failed !== tab.favicon ? (
    <img
      src={tab.favicon}
      alt=""
      draggable={false}
      style={{ width: size, height: size }}
      onError={() => setFailed(tab.favicon ?? null)}
    />
  ) : (
    <Globe size={size} className="text-text-tertiary" />
  )

  const dotColor = tab.cdpIntercepting
    ? INTERCEPTING_DOT_COLOR
    : tab.agentSessionId
      ? sessionDotColor(tab.agentSessionId)
      : 'var(--color-text-tertiary)'

  return (
    <span
      className="relative inline-flex flex-shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      {icon}
      {(tab.cdpAttached || tab.cdpIntercepting) && (
        <span
          data-agent-dot={tab.agentSessionId ?? ''}
          data-agent-pulsing={pulsing ? 'true' : undefined}
          className={`absolute -right-[3px] -bottom-[2px] h-[7px] w-[7px] rounded-full ring-[1.5px] ring-bg-primary ${
            pulsing ? 'animate-pulse' : ''
          }`}
          style={{ background: dotColor }}
        />
      )}
    </span>
  )
}
