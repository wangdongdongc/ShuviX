/**
 * 共享 write 内核 —— 读后被改守卫 + 写锁 + 写入（含建父目录，由 port 负责）。
 * 从桌面 write.ts 的 executeInternal 内层逐字搬出，fs → port，fileTime → 注入的 guards。
 */
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { FileSystemPort, FileGuards } from './port'

export interface WriteParams {
  /** 展示用路径 */
  path: string
  content: string
}

/**
 * 写文件：仅当文件曾被读取过时校验「读后被改」（新建无需检查）→ 写入 → 记录读取时间。
 * readPath 交给 port 解释；displayPath（params.path）用于输出文案。
 *
 * 守卫 + 写入 + 记录都在 withFileLock 内完成（不只写入加锁），与并发 edit/write 严格互斥：
 * 避免「锁外 assert 通过 → 他人在锁内写入 → 本次再覆盖」的竞态。
 */
export async function applyWrite(
  port: FileSystemPort,
  guards: FileGuards,
  readPath: string,
  params: WriteParams
): Promise<AgentToolResult<undefined>> {
  return guards.withFileLock(readPath, async () => {
    if (guards.hasReadTime(readPath)) {
      await guards.assertNotModifiedSinceRead(readPath)
    }
    await port.writeFile(readPath, params.content)
    // 写入后更新读取时间
    guards.recordRead(readPath)
    return {
      content: [{ type: 'text', text: `Wrote ${params.content.length} bytes to ${params.path}` }],
      details: undefined
    }
  })
}
