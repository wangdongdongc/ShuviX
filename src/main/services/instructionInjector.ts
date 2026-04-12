/**
 * InstructionInjector — 项目指令文件（AGENTS.md / CLAUDE.md）注入
 *
 * 仅在两个时机调用：
 * 1. 新会话创建时（sessionService.create）
 * 2. 会话压缩完成后（compactionService.compact）
 *
 * 流程：扫描磁盘候选 ∩ 会话配置 enabledInstructionFiles → 每个文件独立写一条
 * user 消息（metadata.isInstructionInjection），UI 通过 metadata 渲染 SystemNoticeCard。
 */

import { readFileSync } from 'fs'
import { v7 as uuidv7 } from 'uuid'
import { messageDao } from '../dao/messageDao'
import { sessionDao } from '../dao/sessionDao'
import { scanInstructionFiles } from './instructionFileScanner'
import type { Message } from '../types'
import { createLogger } from '../logger'

const log = createLogger('InstructionInjector')

/**
 * 根据会话配置扫描候选指令文件，构造 user 消息对象（**不写库**）。
 * 调用方负责持久化，便于和压缩流程合并到同一个事务里。
 */
export function buildInstructionMessages(sessionId: string, workingDir: string): Message[] {
  const enabled = sessionDao.pickSettings(sessionId, [
    'enabledInstructionFiles'
  ])?.enabledInstructionFiles
  if (!enabled || enabled.length === 0) {
    log.info(`session=${sessionId} 未启用任何指令文件，跳过注入`)
    return []
  }
  log.info(`session=${sessionId} 启用列表: [${enabled.join(', ')}]`)

  const enabledSet = new Set(enabled)
  const available = scanInstructionFiles(workingDir).filter((f) => enabledSet.has(f.filename))
  if (available.length === 0) {
    log.info(`session=${sessionId} 启用列表与磁盘扫描结果交集为空，跳过注入`)
    return []
  }
  log.info(
    `session=${sessionId} 待注入 ${available.length} 个文件: [${available.map((f) => f.filename).join(', ')}]`
  )

  const messages: Message[] = []
  // 同一批次内累加 createdAt 微小偏移，保证多文件之间也有稳定时间序
  const baseTs = Date.now()
  let offset = 0
  for (const entry of available) {
    let content: string
    try {
      content = readFileSync(entry.absolutePath, 'utf-8').trim()
    } catch (err: unknown) {
      log.warn(
        `读取失败: ${entry.absolutePath} (${err instanceof Error ? err.message : String(err)})`
      )
      continue
    }
    if (!content) {
      log.info(`跳过空文件 ${entry.filename}`)
      continue
    }
    log.info(`构造指令消息 file=${entry.filename} bytes=${content.length}`)
    messages.push({
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
      createdAt: baseTs + offset++
    })
  }
  return messages
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
