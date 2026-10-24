/**
 * 触发源（实验）—— 产生全局埋点事件的东西，是一项系统设置（设置 → 触发源）。今天只有一种类型：timer，内置一个
 * 开箱即开的实例，每分钟触发一次 `timer.fired`。以后加文件监视、webhook 之类，是在这里多一种 `kind`。
 */
export interface TriggerSourceStatus {
  /** 实例 id（事件与来源记录里的 `sourceId`；内置 timer：`timer:builtin:minute`） */
  id: string
  kind: 'timer'
  /** 随应用内置（不能删，只能关） */
  builtin: boolean
  enabled: boolean
  /** 本次运行里上一次触发的时刻（ISO）；还没触发过 → 缺省 */
  lastFiredAt?: string
  /** 订阅它的 bot 绑定 */
  subscribers: Array<{ bot: string; displayName: string; when?: string }>
}
