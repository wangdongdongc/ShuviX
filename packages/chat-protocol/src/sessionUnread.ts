/**
 * 收件箱的已读 / 未读（docs/inbox-read-state-design.md）—— 两端共用的形状与判定。
 *
 * 已读挂在**会话**上：主进程一张表（session_unread），一条未读会话一行，读过就删行。这里只放纯东西：
 * 一行长什么样，以及「一轮跑完要不要把会话标成未读」的判定（宿主给事实，这里不碰数据库、窗口、事件）。
 */

/** 一条未读会话 */
export interface SessionUnread {
  /** 变成未读的时刻（ms）—— 收件箱「新回复」按它排序 */
  since: number
  /**
   * 新内容从哪一刻开始（那一轮开跑的时刻，ms）—— 打开会话时在第一条不早于它的消息前画「新内容」分隔线。
   * 手动标为未读没有可指的新内容，缺省
   */
  anchorAt?: number
  /** 最近一轮以失败结束 */
  failed: boolean
  /** 用户手动标的 */
  manual: boolean
}

/** 判定「一轮跑完要不要标成未读」要的事实 */
export interface TurnEndFacts {
  /** 这一轮怎么结束的（`agent_end.reason`） */
  reason: 'ok' | 'aborted' | 'error'
  /** 结束的是一条会话的根 agent（派生 agent、hook agent 的结束不是） */
  isSessionRoot: boolean
  /** 这条会话不进主窗口的列表（内存会话、Chrome 标签会话）—— 与桌面通知同一条排除 */
  excluded: boolean
  /** 这一轮是别的会话驱动的（父会话派的活、被授权的会话发来的消息）—— 结果是给那个 agent 的（D3） */
  driven: boolean
  /** 那一刻有人正看着这条会话（窗口在前台且展示着它；手机 / 浏览器报了可见且展示着它） */
  inFront: boolean
}

/**
 * 一轮跑完 → 要不要标成未读。自己按停（aborted）不算：人就在跟前（与通知同一条取舍）；
 * 正看着的时候结束，生来已读。
 */
export function turnMakesUnread(facts: TurnEndFacts): boolean {
  if (facts.reason === 'aborted') return false
  if (!facts.isSessionRoot || facts.excluded || facts.driven) return false
  return !facts.inFront
}
