/**
 * 系统通知正文契约 —— 主进程写给模型看的「后台完成通知」的信封。
 *
 * 通知（后台任务退出 / 子会话跑完）在 pi 的上下文里只能是一条 user 消息（模型必须看见它），
 * 但用户并没有说过这句话。渲染侧靠两个判据认出它：
 *  1. **侧车**（`SYSTEM_NOTICE_CUSTOM_TYPE`，仅 `resume` 路径能写）—— 主判据；
 *  2. **正文形状**：整段正文只由下列标签块组成 —— 兜底。steer 路径的 user 消息由 pi
 *     自己构造并落盘，宿主插不进侧车，投影若只认侧车，这些通知就会被画成用户气泡。
 *
 * 生产者：桌面 `bgTaskService.formatExitNotice`（`<background-task …>`）、
 * `subSessionRunner.settle`（`<sub-session …>`）与 agent-runtime 的空回复追问
 * （`durable/emptyReply.ts`，`<empty-reply>`）；消费者：agent-runtime 的投影（打 isSystemNotice）
 * 与 chat-ui 的通知摘要解析。三处认同一份标签表，改这里一处。
 */

/**
 * 日期通知的种类（`shuvix.notice` 条目的 `data.kind`）。跨天后第一次用户输入之前写下，正文是
 * `<date-change>Today is …</date-change>`（agent-runtime `renderDateNotice`），不是上面的标签块；
 * 投影按条目种类打 `isSystemNotice`，并把这个种类带进 `UserTextMeta.noticeKind`，渲染侧据此
 * 不把它画成「后台任务已完成」。
 */
export const DATE_NOTICE_KIND = 'date'

/**
 * 空回复追问的标签名，也是它的通知种类（`UserTextMeta.noticeKind`）。
 *
 * 工具跑完之后，模型的回复既没有正文、也没有工具调用（只有思考，或者干脆是空的）时，pi 会把它当成
 * 最终回答结束这次运行 —— 任务看起来像做完了，其实断了。agent-runtime 在这时追加一条这种通知让模型
 * 接着干（每个工具结果之后至多一次）。它和后台完成通知一样是系统写给模型的 user 消息，渲染侧按种类
 * 挑自己的通知行，不画成「后台任务已完成」。
 */
export const EMPTY_REPLY_NOTICE_KIND = 'empty-reply'

/** 通知信封的标签名（不含尖括号） */
export const SYSTEM_NOTICE_TAGS = [
  'background-task',
  // 驱动别的会话那一轮的通知（完成 / 停下来问 / 没发出去）；`sub-session` 是 2026-10-20 之前的写法，旧会话里还有
  'session',
  'sub-session',
  EMPTY_REPLY_NOTICE_KIND
] as const

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

/**
 * 正文是否是空回复追问：完全由通知块组成，且每一块都是 `<empty-reply>`。
 * 投影据此把 `noticeKind` 记成 `EMPTY_REPLY_NOTICE_KIND`；它从不和别的通知拼成一条。
 */
export function isEmptyReplyNoticeText(text: string): boolean {
  if (!isSystemNoticeText(text)) return false
  for (const match of text.matchAll(systemNoticeBlockRe())) {
    if (match[1] !== EMPTY_REPLY_NOTICE_KIND) return false
  }
  return true
}
