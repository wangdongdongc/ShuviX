/**
 * 扩展「项目指令文件」后端 —— 按 agent 档案 `shuvix-instruction-files` 的清单解析。
 *
 * 镜像桌面 instructionInjector：清单顺序即优先级，取第一个存在且非空的读出来，至多一个；
 * 返回原文，围栏由统一创建管线（createAgent）统一加，内容 append 进系统提示词。
 * 差异仅在底座：FSA/OPFS 目录句柄（无 Node fs），故相对路径要逐级下钻取子目录句柄。
 *
 * 本模块没有自己的候选名表 —— 「读哪些文件」全由档案决定（会话设置里那个单选下拉
 * 已随之取消）。条目已由 agent md 解析器归一为工作目录内的相对路径（拒收绝对路径与
 * `..`），这里直接按 `/` 拆段即可。
 */
import { handleForSession } from './filesRuntime'

/** 按相对路径逐级下钻取文件句柄；任一段不存在返回 null */
async function fileHandleAt(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<FileSystemFileHandle | null> {
  const parts = relativePath.split('/')
  const filename = parts.pop()
  if (!filename) return null
  let dir = root
  try {
    for (const segment of parts) dir = await dir.getDirectoryHandle(segment)
    return await dir.getFileHandle(filename)
  } catch {
    return null
  }
}

/**
 * 解析要注入的项目指令文件（统一创建管线 resolveInstruction 的扩展实现）。
 * 与桌面 instructionInjector 同形：清单里第一个存在且非空的胜出，任何读失败/空文件
 * 只是「这条不算命中」，继续看下一条；全部落空返回 null。
 */
export async function resolveInstructionForSession(
  sessionId: string,
  candidates: readonly string[]
): Promise<{ filename: string; content: string } | null> {
  if (candidates.length === 0) return null
  const handle = await handleForSession(sessionId)
  if (!handle) return null

  for (const name of candidates) {
    const fh = await fileHandleAt(handle, name)
    if (!fh) continue
    try {
      const content = (await (await fh.getFile()).text()).trim()
      if (content) return { filename: name, content }
    } catch {
      // 读失败 → 看下一个候选
    }
  }
  return null
}
