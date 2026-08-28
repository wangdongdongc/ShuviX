/**
 * AgentNotification —— 宿主无关的「该给用户弹一条通知」描述。
 *
 * 决策（什么时候弹、弹什么、什么时候撤回）在 `@shuvix/agent-runtime` 的 `notification/`
 * 里，两端共用；本文件只定义那层的输出形状，宿主端口照着渲染即可 ——
 * 桌面是 Electron `Notification`，扩展是 `chrome.notifications`。
 *
 * **刻意不含按钮。** 通知内动作的平台上限差异极大（macOS 一个主按钮且要求应用已签名 +
 * `NSUserNotificationAlertStyle: alert`，Chrome 两个，Linux 没有，Windows 要 Electron 40），
 * 所以第一步只做「整条点击 = 打开对应会话」—— 这个动作四个平台都有。
 * 后续加按钮时在这里补一个 `actions` 字段，决策层与端口的分工不用动。
 */

/** 通知类别 —— 决定文案与图标，也决定 key 的构造方式 */
export type AgentNotificationKind =
  /** agent 卡在等用户回答（命令放行 / 选择题 / SSH 凭证） */
  | 'ask'
  /** 一轮运行正常收尾 */
  | 'done'
  /** 一轮运行异常结束（API 报错等） */
  | 'failed'

export interface AgentNotification {
  /**
   * 去重 / 撤回键。
   *
   * 同一 key 再次 `show` 覆盖前一条（两端原生通知都按 id 覆盖），`dismiss(key)` 撤回。
   * 询问用 `ask:<requestId>`（用户在界面里答了就撤回），运行结束用 `run:<sessionId>`
   * （同一会话只留最新一条）。
   */
  key: string
  kind: AgentNotificationKind
  /**
   * 点击后要定位到的会话。
   *
   * 这里**一定是可见会话**：派生 agent 的事件带的是子会话 id，决策层已经把它映射
   * 回根会话，宿主拿到直接切过去即可，不需要自己再查血缘。
   */
  sessionId: string
  title: string
  body: string
  /** ask 通知携带；本期只进日志，后续「允许 / 拒绝」按钮据此回填 InputResponse */
  requestId?: string
}
