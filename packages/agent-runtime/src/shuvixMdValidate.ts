/**
 * shuvix 契约 md 的解析器级校验 —— ChatApi `shuvixMd.validate` 的宿主无关实现
 * （桌面 IPC 处理器与扩展 ChatApi 适配器共用，避免两端各写一份类型分派）。
 *
 * 只做「已有解析器的复用」：agent/policy/bot/hook 调各自真解析器（合法性语义的唯一事实源），
 * 其余类型（chart）返回 unknown —— 它们是宽容读取的展示型契约，没有
 * 「整份拒绝」概念，属性卡不显示校验态。
 *
 * 各解析器都带 warn 通道，故 invalid 时都能给出人读原因（messages 原样回传，UI 逐条显示）。
 */
import type { ShuvixMdValidation } from '@shuvix/chat-protocol/shuvixMdContract'
import { parseAgentDefinitionFile } from './agentProfile/definitionFile'
import { parseBotDefinitionFile } from './bot/botFile'
import { parsePolicyDefinitionFile } from './security/policyFile'
import { parseHookDefinitionFile } from './hook/hookFile'

export function validateShuvixMdText(
  type: string,
  text: string,
  name = 'file'
): ShuvixMdValidation {
  if (type === 'agent') {
    const messages: string[] = []
    const parsed = parseAgentDefinitionFile(text, name, (msg) => messages.push(msg))
    return { status: parsed ? 'valid' : 'invalid', messages }
  }
  if (type === 'policy') {
    const messages: string[] = []
    const parsed = parsePolicyDefinitionFile(text, name, (msg) => messages.push(msg))
    return { status: parsed ? 'valid' : 'invalid', messages }
  }
  if (type === 'bot') {
    // bot 的正文没有任何形状要求（空正文是新建出来的常态，由 bot 自己往里写），原样解析即可。
    // v1 残留的管线块是软提示：
    // 状态仍是 valid，messages 带着那句话，卡片据此亮琥珀
    const messages: string[] = []
    const parsed = parseBotDefinitionFile(text, name, (msg) => messages.push(msg))
    return { status: parsed ? 'valid' : 'invalid', messages }
  }
  if (type === 'hook') {
    // hook 的合法性全在 frontmatter（标记 / agent / 绑定 / CEL），正文是派发给 agent 的任务文本、
    // 可以为空 —— 所以属性卡送来的 frontmatter 片段原样判定即可，不需要占位正文。
    // 未知埋点是软提示（绑定惰性化）：状态仍是 valid，messages 带着那句话，卡片据此亮琥珀
    const messages: string[] = []
    const parsed = parseHookDefinitionFile(text, name, (msg) => messages.push(msg))
    return { status: parsed ? 'valid' : 'invalid', messages }
  }
  return { status: 'unknown', messages: [] }
}
