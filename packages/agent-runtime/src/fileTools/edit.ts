/**
 * 共享 edit 内核 —— 精确/模糊文本替换（BOM 保留、行尾规范化、多级回退链匹配）。
 * 从桌面 edit.ts 的 executeInternal 内层逐字搬出，fs → 注入的 FileSystemPort，
 * fileTime → 注入的 FileGuards。富文本/沙箱/abort 仍由各宿主在外层编排。
 */
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { EditToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { FileSystemPort, FileGuards } from './port'
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom
} from './editDiff'
import { replaceWithFallback } from './replacers'

export interface EditParams {
  /** 展示用路径 */
  path: string
  oldText: string
  newText: string
}

/**
 * 编辑文件：校验存在 + 读后被改守卫 → 整读 → BOM/行尾处理 → 多级回退匹配替换 →
 * 加写锁写入 → 记录读取时间 → 生成带行号上下文的 diff。
 * readPath 交给 port 解释；displayPath（params.path）用于输出文案与报错。
 */
export async function applyEdit(
  port: FileSystemPort,
  guards: FileGuards,
  readPath: string,
  params: EditParams
): Promise<AgentToolResult<EditToolDetails>> {
  // 检查文件是否存在
  const st = await port.stat(readPath)
  if (!st || !st.isFile) {
    throw new Error(`File not found: ${params.path}`)
  }

  // 校验文件是否在上次读取后被外部修改（edit 必须先读）
  await guards.assertNotModifiedSinceRead(readPath)

  const rawContent = await port.readFile(readPath)

  // BOM 和行尾处理
  const { bom, text: content } = stripBom(rawContent)
  const originalEnding = detectLineEnding(content)
  const normalizedContent = normalizeToLF(content)
  const normalizedOldText = normalizeToLF(params.oldText)
  const normalizedNewText = normalizeToLF(params.newText)

  // 多级回退链匹配 + 替换
  let replaceResult: { content: string; replacerName: string }
  try {
    replaceResult = replaceWithFallback(normalizedContent, normalizedOldText, normalizedNewText)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${params.path}: ${msg}`)
  }

  const newContent = replaceResult.content

  // 验证替换是否有效
  if (normalizedContent === newContent) {
    throw new Error(`No change produced: ${params.path}`)
  }

  const finalContent = bom + restoreLineEndings(newContent, originalEnding)
  await guards.withFileLock(readPath, async () => {
    await port.writeFile(readPath, finalContent)
  })
  // 写入后更新读取时间，避免后续编辑被自己的写入触发警告
  guards.recordRead(readPath)

  const diffResult = generateDiffString(normalizedContent, newContent)
  return {
    content: [{ type: 'text', text: `Successfully edited ${params.path}` }],
    details: {
      type: 'edit',
      diff: diffResult.diff,
      firstChangedLine: diffResult.firstChangedLine
    }
  }
}
