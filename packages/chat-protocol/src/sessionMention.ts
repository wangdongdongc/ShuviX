/**
 * 输入框 `@` 会话的候选 —— 用户把另一条会话交给智能体：选中之后消息里带上它的 id 与标题（`[session: id … — "…"]`），
 * 智能体经 `session` 工具按 id 找到它。@ 本身不是授权：与不是自己子会话的会话交互，第一次照样要用户批准
 * （出厂的 ask-on-session-access），「允许并记住」才写进会话权限表。
 */
export interface SessionMentionEntry {
  id: string
  title: string
  /** 所属项目的名字；不属于项目的会话缺省 */
  projectName?: string
  /** 是子会话时它父会话的标题（侧栏里它嵌在谁下面） */
  parentTitle?: string
  /** 用户最近一次在它上面动手的时间（毫秒，候选按它倒序） */
  lastActiveAt: number
}
