/**
 * 扩展「项目指令文件」后端 —— 顶层扫描 AGENTS.md / CLAUDE.md，供会话配置单选 + 懒注入。
 *
 * 镜像桌面 instructionFileScanner / instructionInjector：非递归、大小写敏感、仅收录实际存在的候选，
 * 且至多注入一个文件（未显式配置时 AGENTS.md 优先、其次 CLAUDE.md；显式 null 表示不注入）。
 * 注入方式与桌面统一（统一创建管线在 createAgent 时 append 进系统提示词）
 * （display=true，进上下文 + 渲染 InstructionBubble），压缩后自动重注入；不再拼进 systemPrompt。
 * 差异仅在底座：FSA/OPFS 工作目录句柄（无 Node fs）。
 */
import {
  INSTRUCTION_FILE_CANDIDATES,
  resolveInstructionFile,
  type InstructionFileEntry
} from '@shuvix/chat-protocol/types/instructionFile'
import { sessionStore } from '../storage/sessionStore'
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
 * 解析会话选中的指令文件（统一创建管线 resolveInstruction 的扩展实现）。
 * 会话配置 settings.instructionFile：undefined = 按优先级自动选，null = 不注入。
 * 与桌面 instructionInjector 同形：返回原文，围栏由 createAgent 统一加；任何读失败/空文件返回 null。
 */
export async function resolveInstructionForSession(
  sessionId: string
): Promise<{ filename: string; content: string } | null> {
  const session = await sessionStore.getById(sessionId)
  const configured = session?.settings?.instructionFile
  if (configured === null) return null
  const handle = await handleForSession(sessionId)
  if (!handle) return null
  const available = await scanInstructionFiles(sessionId)
  const selected = resolveInstructionFile(
    configured,
    available.map((f) => f.filename)
  )
  if (!selected) return null
  try {
    const fh = await handle.getFileHandle(selected)
    const content = (await (await fh.getFile()).text()).trim()
    if (!content) return null
    return { filename: selected, content }
  } catch {
    return null
  }
}
