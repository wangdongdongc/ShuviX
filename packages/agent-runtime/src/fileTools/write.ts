/**
 * 共享 write 内核 —— 读后被改守卫 + 写锁 + 写入（含建父目录，由 port 负责）。
 * 从桌面 write.ts 的 executeInternal 内层逐字搬出，fs → port，fileTime → 注入的 guards。
 */
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { WriteToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { FileSystemPort, FileGuards, WriteAskHook } from './port'
import { capDiffString, generateDiffString, normalizeToLF } from './editDiff'

export interface WriteParams {
  /** 展示用路径 */
  path: string
  content: string
}

/**
 * 写文件：仅当文件曾被读取过时校验「读后被改」（新建无需检查）→ 算 diff → 写入前询问 →
 * 写入 → 记录读取时间。readPath 交给 port 解释；displayPath（params.path）用于输出文案。
 *
 * 守卫 + 写入 + 记录都在 withFileLock 内完成（不只写入加锁），与并发 edit/write 严格互斥：
 * 避免「锁外 assert 通过 → 他人在锁内写入 → 本次再覆盖」的竞态。
 *
 * diff 与 edit 同款（新建文件即全增行），行尾统一按 LF 比较 —— 否则 CRLF 文件会整篇标成改动。
 * 它同时是询问预览和 details 里的那一份，一次算成，两处共用。
 */
export async function applyWrite(
  port: FileSystemPort,
  guards: FileGuards,
  readPath: string,
  params: WriteParams,
  ask?: WriteAskHook
): Promise<AgentToolResult<WriteToolDetails>> {
  return guards.withFileLock(readPath, async () => {
    if (guards.hasReadTime(readPath)) {
      await guards.assertNotModifiedSinceRead(readPath)
    }

    // 旧内容用于 diff：不存在 / 读不动（二进制、权限）都按空文件处理，当作新建
    const st = await port.stat(readPath)
    const isNewFile = !st?.isFile
    let oldContent = ''
    if (!isNewFile) {
      try {
        oldContent = await port.readFile(readPath)
      } catch {
        oldContent = ''
      }
    }
    const diff = capDiffString(
      generateDiffString(normalizeToLF(oldContent), normalizeToLF(params.content)).diff
    )

    // 写入前询问 —— 同样在锁内，理由见 applyEdit
    if (ask) {
      await ask({ path: params.path, diff, isNewFile })

      // 询问期间外部改动的兜底（文件锁挡不住本进程之外）：预览基于旧内容，作废重来
      if (guards.hasReadTime(readPath)) {
        await guards.assertNotModifiedSinceRead(readPath)
      } else {
        // 没读过的文件（含新建）没有 mtime 基线可比，拿询问前那次 stat 当基线 —— 否则
        // 「新建、整份全增」的预览批下去之后，期间被别人建出来的内容会被静默覆盖。
        const now = await port.stat(readPath)
        const changed = isNewFile
          ? !!now
          : !now || now.mtimeMs !== st?.mtimeMs || now.size !== st?.size
        if (changed) {
          throw new Error(
            `${params.path} changed while waiting for your answer; re-read it and try again`
          )
        }
      }
    }

    await port.writeFile(readPath, params.content)
    // 写入后更新读取时间
    guards.recordRead(readPath)
    return {
      content: [{ type: 'text', text: `Wrote ${params.content.length} bytes to ${params.path}` }],
      details: { type: 'write', diff, isNewFile }
    }
  })
}
