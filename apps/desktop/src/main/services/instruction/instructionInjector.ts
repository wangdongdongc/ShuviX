/**
 * InstructionInjector — 项目指令文件（AGENTS.md / CLAUDE.md）注入
 *
 * 仅在两个时机调用：
 * 1. 新会话创建时（sessionService.create）
 * 2. 会话压缩归档时（session 工具 compact 动作，tools/session.ts —— build 形态并入其原子事务）
 *
 * 流程：扫描磁盘候选 → 按会话配置 settings.instructionFile 单选出至多一个文件（未配置时
 * AGENTS.md 优先、其次 CLAUDE.md）→ 写一条 user 消息（metadata.isInstructionInjection），
 * UI 通过 metadata 渲染 SystemNoticeCard。
 */

import { readFileSync } from 'fs'
import { v7 as uuidv7 } from 'uuid'
import { messageDao } from '../../dao/messageDao'
import { sessionDao } from '../../dao/sessionDao'
import { scanInstructionFiles } from './instructionFileScanner'
import type { Message } from '../../types'
import { createLogger } from '../../logger'
import { resolveInstructionFile } from '@shuvix/chat-protocol/types/instructionFile'

const log = createLogger('InstructionInjector')

/**
 * 根据会话配置扫描候选指令文件，构造 user 消息对象（**不写库**）。
 * 单选语义：返回 0 或 1 条消息（数组形态保留，便于调用方统一批量落库）。
 * 调用方负责持久化，便于和压缩流程合并到同一个事务里。
 *
 * 注：读配置走 `pick(['settings'])` 而非 `pickSettings`——后者用 json_extract，
 * 无法区分「显式 null（不注入）」和「键缺失（走默认优先级）」。
 */
export function buildInstructionMessages(sessionId: string, workingDir: string): Message[] {
  const configured = sessionDao.pick(sessionId, ['settings'])?.settings?.instructionFile
  const available = scanInstructionFiles(workingDir)
  const selected = resolveInstructionFile(
    configured,
    available.map((f) => f.filename)
  )
  if (!selected) {
    log.info(`session=${sessionId} 未选中任何指令文件，跳过注入`)
    return []
  }

  const entry = available.find((f) => f.filename === selected)
  if (!entry) return []

  let content: string
  try {
    content = readFileSync(entry.absolutePath, 'utf-8').trim()
  } catch (err: unknown) {
    log.warn(
      `读取失败: ${entry.absolutePath} (${err instanceof Error ? err.message : String(err)})`
    )
    return []
  }
  if (!content) {
    log.info(`跳过空文件 ${entry.filename}`)
    return []
  }
  log.info(`构造指令消息 file=${entry.filename} bytes=${content.length}`)
  return [
    {
      id: uuidv7(),
      sessionId,
      role: 'user',
      type: 'text',
      content: `Project instruction file (${entry.filename}):\n\n${content}`,
      metadata: {
        isInstructionInjection: true,
        instructionFilename: entry.filename
      },
      model: '',
      createdAt: Date.now()
    }
  ]
}

/**
 * 根据会话配置扫描并注入指令文件，每个文件作为一条独立 user 消息。
 * 这是 build + 写库的便捷封装，用于新会话场景（不需要事务）。
 */
export function injectInstructionMessages(sessionId: string, workingDir: string): Message[] {
  const messages = buildInstructionMessages(sessionId, workingDir)
  for (const msg of messages) {
    messageDao.insert(msg)
    log.info(
      `已写入指令消息 session=${sessionId} file=${msg.metadata?.instructionFilename} msgId=${msg.id}`
    )
  }
  if (messages.length > 0) {
    sessionDao.touch(sessionId)
    log.info(`session=${sessionId} 共注入 ${messages.length} 条指令消息`)
  }
  return messages
}
