/**
 * shuvix 契约 md 的解析器级校验 —— ChatApi `shuvixMd.validate` 的宿主无关实现
 * （桌面 IPC 处理器与扩展 ChatApi 适配器共用，避免两端各写一份类型分派）。
 *
 * 只做「已有解析器的复用」：agent/policy/memory 调各自真解析器（合法性语义的唯一事实源），
 * 其余类型（chart/wiki-*）返回 unknown —— 它们是宽容读取的展示型契约，没有
 * 「整份拒绝」概念，属性卡不显示校验态。
 *
 * 三个解析器都带 warn 通道，故 invalid 时都能给出人读原因（messages 原样回传，UI 逐条显示）。
 */
import type { ShuvixMdValidation } from '@shuvix/chat-protocol/shuvixMdContract'
import { parseAgentDefinitionFile } from './agentProfile/definitionFile'
import { splitFrontmatter } from './markdownFrontmatter'
import { parseMemoryFile } from './memory/memoryFile'
import { parsePolicyDefinitionFile } from './security/policyFile'
import { parseWorkflowDefinitionFile } from './workflow/workflowFile'

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
  if (type === 'workflow') {
    // 结构级校验（frontmatter/绑定/CEL/块布局）；脚本**语法**由宿主的脚本引擎在扫描侧
    // 另行 compile —— 本函数保持两端可用（无脚本引擎依赖）。
    //
    // 与 memory 同一处理（理由见下）：属性卡只送 frontmatter 片段，而「恰一个 js workflow
    // 脚本块」是正文的规则 —— 原样送进去，每一份合法工作流都会亮红。仅在没有正文时补一个
    // 占位脚本块，把判定限定在 frontmatter 上；送整份文件的调用方（写后校验）照旧按真实
    // 正文判定，缺脚本块的工作流仍判非法 —— 那种文件扫描侧本来就会跳过。
    const messages: string[] = []
    const hasBody = (splitFrontmatter(text)?.body ?? '').trim() !== ''
    // 占位块的内容必须非空 —— 纯空白脚本按「缺脚本块」拒绝（见 workflowFile 的块提取）
    const parsed = parseWorkflowDefinitionFile(
      hasBody ? text : `${text}\n\`\`\`js workflow\nreturn null\n\`\`\`\n`,
      name,
      (msg) => messages.push(msg)
    )
    return { status: parsed ? 'valid' : 'invalid', messages }
  }
  if (type === 'memory') {
    const messages: string[] = []
    // 属性卡只送 frontmatter（`---\n<yaml>\n---\n`），而「正文为空」是正文的规则、不是
    // frontmatter 的规则 —— 原样送进去，每一份合法记忆都会亮红。故**仅在没有正文时**补一行
    // 占位正文，把判定限定在 frontmatter 上；送整份文件的调用方（写后校验）照旧按真实正文
    // 判定，空正文的记忆仍判非法 —— 那种文件扫描侧本来就会跳过。
    const hasBody = (splitFrontmatter(text)?.body ?? '').trim() !== ''
    const parsed = parseMemoryFile(hasBody ? text : `${text}\n<body>\n`, name, (msg) =>
      messages.push(msg)
    )
    return { status: parsed ? 'valid' : 'invalid', messages }
  }
  return { status: 'unknown', messages: [] }
}
