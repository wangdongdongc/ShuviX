/**
 * shuvix 契约 md 的解析器级校验 —— ChatApi `shuvixMd.validate` 的宿主无关实现
 * （桌面 IPC 处理器与扩展 ChatApi 适配器共用，避免两端各写一份类型分派）。
 *
 * 只做「已有解析器的复用」：agent/policy 调各自真解析器（合法性语义的唯一事实源），
 * 其余类型（chart/wiki-*）返回 unknown —— 它们是宽容读取的展示型契约，没有
 * 「整份拒绝」概念，属性卡不显示校验态。
 *
 * agent 与 policy 的解析器都带 warn 通道，故两者 invalid 时都能给出人读原因
 * （messages 原样回传，UI 逐条显示）。
 */
import type { ShuvixMdValidation } from '@shuvix/chat-protocol/shuvixMdContract'
import { parseAgentDefinitionFile } from './agentProfile/definitionFile'
import { parsePolicyDefinitionFile } from './security/policyFile'

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
  return { status: 'unknown', messages: [] }
}
