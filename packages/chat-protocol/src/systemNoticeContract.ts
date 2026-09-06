/**
 * 系统通知正文契约 —— 主进程写给模型看的「后台完成通知」的信封。
 *
 * 通知（后台任务退出 / 子会话跑完）在 pi 的上下文里只能是一条 user 消息（模型必须看见它），
 * 但用户并没有说过这句话。渲染侧靠两个判据认出它：
 *  1. **侧车**（`SYSTEM_NOTICE_CUSTOM_TYPE`，仅 `resume` 路径能写）—— 主判据；
 *  2. **正文形状**：整段正文只由下列标签块组成 —— 兜底。steer / nextTurn 路径的 user 消息由 pi
 *     自己构造并落盘，宿主插不进侧车，投影若只认侧车，这些通知就会被画成用户气泡。
 *
 * 生产者：桌面 `bgTaskService.formatExitNotice`（`<background-task …>`）与
 * `subSessionRunner.settle`（`<sub-session …>`）；消费者：agent-runtime 的投影（打 isSystemNotice）
 * 与 chat-ui 的通知摘要解析。三处认同一份标签表，改这里一处。
 */

/** 通知信封的标签名（不含尖括号） */
export const SYSTEM_NOTICE_TAGS = ['background-task', 'sub-session'] as const

/** 匹配一个完整的通知块 `<tag …>…</tag>`（带 g 标志，每次调用给一个新实例，免得 lastIndex 串场） */
export function systemNoticeBlockRe(): RegExp {
  return new RegExp(`<(${SYSTEM_NOTICE_TAGS.join('|')})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, 'g')
}

/**
 * 正文是否**完全**由通知块组成（块之间允许空白）。
 * 用户自己粘一段这种标签进来的概率可以忽略，后果也只是被画成通知行而不是气泡。
 */
export function isSystemNoticeText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('<')) return false
  const rest = trimmed.replace(systemNoticeBlockRe(), '').trim()
  return rest.length === 0 && trimmed.length > 0
}
