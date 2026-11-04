import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 消息多久没上屏才画骨架。实测切到一条会话到消息可见约 110–150ms（长短会话差别不大）：这时什么都不画，
 * 一画就是闪一下，还要因为下面的最短时长多等
 */
const SKELETON_DELAY_MS = 200
/** 骨架一旦上屏至少留这么久：刚画出来就撤，同样是闪一下 */
const SKELETON_MIN_SHOWN_MS = 250

/** 每一轮：用户气泡之后的几段回答，每段是各行的宽度（%）。比一屏高的窗口也铺得满，多出来的被裁掉 */
const TURNS: number[][][] = [
  [[38], [100, 94, 72], [28, 42, 34], [100, 90, 52]],
  [[44], [100, 96, 58], [100, 92, 97, 46], [100, 88, 68]],
  [[52], [100, 90, 64], [100, 97, 41]],
  [[38], [100, 94, 72], [28, 42, 34], [100, 90, 52]],
  [[44], [100, 96, 58], [100, 92, 97, 46], [100, 88, 68]]
]

/**
 * 会话记录的占位：形状与真消息同一条阅读列（宽度、气泡在右、行距）。从底部往上排 —— 打开一条长会话落在
 * 它的真底（见 Conversation 的 LIST_BOTTOM），消息到达时位置接近。整块一起呼吸，大窗口里逐行错开太闹。
 * 不透明地盖在对话列上（悬浮输入卡片在 DOM 里更靠后，仍压在它上面）：下面的列表可能已经定位好了，
 * 只让里层呼吸，否则消息会透出来。不接鼠标：点击和滚轮都穿给下面的列表，骨架多留的那一会儿不能吞操作
 */
export function ConversationSkeleton(): React.JSX.Element {
  return (
    <div
      data-conversation-skeleton=""
      aria-hidden
      className="absolute inset-0 overflow-hidden flex flex-col justify-end bg-bg-primary pointer-events-none"
      style={{ paddingBottom: 'var(--chat-input-h, 0px)' }}
    >
      <div className="shrink-0 w-full max-w-[784px] mx-auto px-4 pb-10 flex flex-col gap-[52px] animate-pulse motion-reduce:animate-none">
        {TURNS.map((turn, t) => (
          <div key={t} className="flex flex-col gap-6">
            <div className="ml-auto h-[34px] w-[255px] max-w-[85%] rounded-lg bg-accent/10" />
            {turn.map((lines, p) => (
              <div key={p} className="flex flex-col gap-[9px]">
                {lines.map((width, l) => (
                  <div
                    key={l}
                    className="h-[11px] rounded bg-bg-tertiary"
                    style={{ width: `${width}%` }}
                  />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 打开一条会话到内容上屏的这段时间：过了 SKELETON_DELAY_MS 内容还没上屏才画骨架，骨架至少留
 * SKELETON_MIN_SHOWN_MS。由 Conversation 按会话 key 重挂，计时只属于这一条会话；开过一次就不再回来
 * （之后才出现的列表，比如新会话发出第一句话，不算打开）。
 *
 * 数据一到就挂 children，不等骨架撤：列表要几帧才定位好（期间 Virtuoso 自己藏着），放到骨架撤了才挂，
 * 就成了「骨架 → 又一段空白 → 消息」。`awaitsPaint` 的内容要等它调 `onPainted`，其余的挂上就算上屏。
 */
export function ViewLoadGate({
  dataReady,
  awaitsPaint,
  children
}: {
  dataReady: boolean
  awaitsPaint: boolean
  children: (onPainted: () => void) => ReactNode
}): React.JSX.Element {
  /** 骨架上屏的时刻；null = 不在屏上 */
  const [shownAt, setShownAt] = useState<number | null>(null)
  const [painted, setPainted] = useState(false)
  const onPainted = useCallback(() => setPainted(true), [])
  const opened = useRef(false)
  const ready = dataReady && (painted || !awaitsPaint)

  useEffect(() => {
    if (opened.current) return
    if (ready) {
      if (shownAt === null) {
        opened.current = true
        return
      }
      const hide = setTimeout(
        () => {
          opened.current = true
          setShownAt(null)
        },
        Math.max(0, shownAt + SKELETON_MIN_SHOWN_MS - Date.now())
      )
      return () => clearTimeout(hide)
    }
    if (shownAt !== null) return
    const show = setTimeout(() => setShownAt(Date.now()), SKELETON_DELAY_MS)
    return () => clearTimeout(show)
  }, [ready, shownAt])

  return (
    <>
      {dataReady ? children(onPainted) : <div className="flex-1 min-h-0" />}
      {shownAt !== null && <ConversationSkeleton />}
    </>
  )
}
