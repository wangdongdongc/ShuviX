/**
 * 无人值守的运行（docs/unattended-run-design.md）—— 一轮运行由触发器（或另一轮无人值守的运行）开启时，本来要交给人的
 * 询问不挂起，立刻以工具结果告诉模型。这里是写给模型的那几句话与界面认它们的办法。
 *
 * 每句都以同一个标记开头：界面据此在那一步的行尾画「无人」图标（`isUnattendedResult`），不另存状态 ——
 * 与 `isSystemNoticeText` 同一个思路：按形状认。标记是英文、进模型上下文，不随界面语言变。
 */

export const UNATTENDED_MARK = '[Unattended run]'

/** 一步工具结果是不是「没人在，所以没做 / 没人答」 */
export function isUnattendedResult(text: unknown): boolean {
  // 标记在开头；经 MCP 的工具把失败包了一层前缀（`[MCP Error] …`），所以看开头一小段而不是第一个字符
  return typeof text === 'string' && text.slice(0, MARK_WINDOW).includes(UNATTENDED_MARK)
}

const MARK_WINDOW = 64

/** 权限询问没人能批：`what` 是这次要做的事（命令、路径……，与询问卡片上那一行同源） */
export function unattendedApprovalText(what: string): string {
  return (
    `${UNATTENDED_MARK} Not done: this needs the user's approval, and this run started automatically, so nobody is here to approve it now: ${what}\n` +
    `Do it a way that needs no approval, or skip it, and say in your reply what the user would need to approve.`
  )
}

/** `ask` 没人能答 */
export const UNATTENDED_QUESTION_TEXT =
  `${UNATTENDED_MARK} Nobody is here to answer: this run started automatically. ` +
  `Decide yourself where you safely can and say what you chose; otherwise put the question in your reply, or leave it as a suggestion, for the user to answer later.`

/** 要用户亲手填的值（设置卡片）没人能填 */
export const UNATTENDED_FIELDS_TEXT =
  `${UNATTENDED_MARK} Nothing was changed: this needs values only the user can fill in, and this run started automatically, so nobody is here now. ` +
  `Say in your reply what the user needs to fill in.`
