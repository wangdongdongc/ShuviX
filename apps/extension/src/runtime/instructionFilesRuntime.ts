/**
 * 扩展「项目指令文件」后端 —— 顶层扫描 AGENTS.md / CLAUDE.md，供会话配置勾选 + 注入系统提示。
 *
 * 镜像桌面 instructionFileScanner / instructionInjector：非递归、大小写敏感、仅收录实际存在的候选。
 * 差异：底座是 FSA/OPFS 工作目录句柄（无 Node fs），且内容追加到 systemPrompt（扩展把操作上下文
 * 一并装配进系统提示），而非桌面那样以独立 user 消息懒注入。默认全不启用（空 enabled = 不注入）。
 */
import {
  INSTRUCTION_FILE_CANDIDATES,
  type InstructionFileEntry
} from '@shuvix/chat-protocol/types/instructionFile'
import { handleForSession } from './filesRuntime'

/** 扫描会话工作目录顶层的指令文件候选（存在即收录，附原始大小写名 + 字节数）。 */
export async function scanInstructionFiles(sessionId: string): Promise<InstructionFileEntry[]> {
  const handle = await handleForSession(sessionId)
  if (!handle) return []
  const out: InstructionFileEntry[] = []
  for (const name of INSTRUCTION_FILE_CANDIDATES) {
    try {
      const fh = await handle.getFileHandle(name)
      const file = await fh.getFile()
      out.push({ filename: name, absolutePath: `${handle.name}/${name}`, size: file.size })
    } catch {
      // 不存在 → 跳过
    }
  }
  return out
}

/**
 * 读取「已启用」指令文件内容，组装为追加到系统提示的文本段（内容模板对齐桌面 instructionInjector）。
 * 仅收录顶层候选中实际存在且被启用者；任何读失败静默跳过。无可用内容时返回空串。
 */
export async function buildInstructionPromptSection(
  sessionId: string,
  enabled: string[]
): Promise<string> {
  if (enabled.length === 0) return ''
  const handle = await handleForSession(sessionId)
  if (!handle) return ''
  const sections: string[] = []
  for (const name of INSTRUCTION_FILE_CANDIDATES) {
    if (!enabled.includes(name)) continue
    try {
      const fh = await handle.getFileHandle(name)
      const file = await fh.getFile()
      const content = await file.text()
      if (content.trim()) sections.push(`Project instruction file (${name}):\n\n${content}`)
    } catch {
      // 缺失/读失败 → 跳过
    }
  }
  return sections.join('\n\n')
}
