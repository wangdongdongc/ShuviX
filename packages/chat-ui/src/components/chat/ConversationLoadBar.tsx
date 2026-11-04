import { useCallback, useEffect, useState, type ReactNode } from 'react'

/**
 * 进度条挂上之后多久才露面，与 base.css 的 conversation-load-reveal 一致（露面由 CSS 管，这里只用来判断
 * 「还没露面就好了」）。它不挡内容，出现得勤一点没有代价，只避开几乎瞬间就好的情况。
 * 实测点开会话到消息可见：短会话 115–150ms，内容多的（代码块、表格）200–260ms，所以多数打开都看得到
 */
const LOAD_BAR_DELAY_MS = 100
/** 淡出时长，与 ConversationLoadBar 的 duration-150 一致 */
const LOAD_BAR_FADE_MS = 150

/**
 * 加载历史时贴在对话区顶上的 2px 细线，一段线从左滑到右。不挡内容也不接鼠标：消息一好就可见，不用等它走。
 * 从前这里是整屏骨架，要盖住内容、又要留够最短时长，已经好了的消息还被挡着，用起来感觉加载变长了。
 *
 * 露面和滑动都交给 CSS 动画（base.css 的 conversation-load-segment）：内容多的会话渲染时主线程会被占住一两百毫秒，
 * JS 定时器要等它结束才触发，那时消息也快好了，等得最久的打开反而看不到进度条。合成线程上的动画不受影响
 */
function ConversationLoadBar({ leaving }: { leaving: boolean }): React.JSX.Element {
  return (
    <div
      data-conversation-load-bar=""
      aria-hidden
      className={`absolute inset-x-0 top-0 h-[2px] overflow-hidden pointer-events-none transition-opacity duration-150${leaving ? ' opacity-0' : ''}`}
    >
      <div className="conversation-load-segment h-full w-[30%] bg-accent" />
    </div>
  )
}

/**
 * 打开一条会话、历史还没上屏的这段时间：进度条从第一刻就挂上（CSS 让它晚一点露面），上屏就撤。
 * 还没露面就好了的直接摘掉，已经露面的淡出。进度条只属于加载历史：`awaitsHistory` 一开始就为假（没有历史要等）
 * 就不挂，多慢都不挂。由 Conversation 按会话 key 重挂，只属于这一次打开，摘掉就不再回来（之后才出现的列表，
 * 比如新会话发出第一句话，不算打开）。
 *
 * 数据一到就挂 children：列表要几帧才定位好（期间自己藏着），定位好了由它调 `onPainted` 告知。
 */
export function ViewLoadGate({
  dataReady,
  awaitsHistory,
  children
}: {
  dataReady: boolean
  awaitsHistory: boolean
  children: (onPainted: () => void) => ReactNode
}): React.JSX.Element {
  const [barUp, setBarUp] = useState(awaitsHistory)
  const [mountedAt] = useState(() => Date.now())
  const [painted, setPainted] = useState(false)
  const onPainted = useCallback(() => setPainted(true), [])
  const ready = painted || !awaitsHistory

  useEffect(() => {
    if (!barUp || !ready) return
    const shown = Date.now() - mountedAt >= LOAD_BAR_DELAY_MS
    const gone = setTimeout(() => setBarUp(false), shown ? LOAD_BAR_FADE_MS : 0)
    return () => clearTimeout(gone)
  }, [ready, barUp, mountedAt])

  return (
    <>
      {dataReady ? children(onPainted) : <div className="flex-1 min-h-0" />}
      {barUp && <ConversationLoadBar leaving={ready} />}
    </>
  )
}
