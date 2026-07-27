/**
 * 扩展「项目指令文件」后端 —— 顶层扫描 AGENTS.md / CLAUDE.md，供会话配置单选 + 注入系统提示。
 *
 * 镜像桌面 instructionFileScanner / instructionInjector：非递归、大小写敏感、仅收录实际存在的候选，
 * 且至多注入一个文件（未显式配置时 AGENTS.md 优先、其次 CLAUDE.md；显式 null 表示不注入）。
 * 差异：底座是 FSA/OPFS 工作目录句柄（无 Node fs），且内容追加到 systemPrompt（扩展把操作上下文
 * 一并装配进系统提示），而非桌面那样以独立 user 消息懒注入。
 */
import {
  INSTRUCTION_FILE_CANDIDATES,
  resolveInstructionFile,
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
 * 读取会话选中的指令文件内容，组装为追加到系统提示的文本段（内容模板对齐桌面 instructionInjector）。
 * @param configured 会话配置 settings.instructionFile：undefined = 按优先级自动选，null = 不注入
 * 任何读失败静默跳过；无可用内容时返回空串。
 */
export async function buildInstructionPromptSection(
  sessionId: string,
  configured: string | null | undefined
): Promise<string> {
  if (configured === null) return ''
  const handle = await handleForSession(sessionId)
  if (!handle) return ''
  const available = await scanInstructionFiles(sessionId)
  const selected = resolveInstructionFile(
    configured,
    available.map((f) => f.filename)
  )
  if (!selected) return ''
  try {
    const fh = await handle.getFileHandle(selected)
    const content = await (await fh.getFile()).text()
    return content.trim() ? `Project instruction file (${selected}):\n\n${content}` : ''
  } catch {
    return ''
  }
}
