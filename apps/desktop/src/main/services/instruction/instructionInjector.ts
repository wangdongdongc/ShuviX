/**
 * InstructionInjector — 项目指令文件（AGENTS.md / CLAUDE.md）解析
 *
 * 迁移到 AgentHarness 后这里只剩「按会话配置选出文件 + 读出内容」这一步：
 * 写入不再经 messageDao，而是由 HarnessSession 落一条 `custom_message` entry
 * （customType='instruction'，display=true）。它同时满足两件事 ——
 * 进入模型上下文（pi 的 convertToLlm 把 custom 转成 user 消息），
 * 且被 projection 投影成带 isInstructionInjection 标记的 UI 消息。
 *
 * 注入时机也随之简化：旧实现要在「新会话创建」和「压缩事务内」各注入一次，
 * 因为压缩会把历史消息整体归档掉；harness 的滚动压缩保留最近上下文，
 * 但被压缩掉的指令仍需重新注入 —— 见 AgentSession.ensureInstructionsInjected 的幂等判断。
 */

import { readFileSync } from 'fs'
import { sessionDao } from '../../dao/sessionDao'
import { scanInstructionFiles } from './instructionFileScanner'
import { createLogger } from '../../logger'
import { resolveInstructionFile } from '@shuvix/chat-protocol/types/instructionFile'

const log = createLogger('InstructionInjector')

export interface ResolvedInstruction {
  filename: string
  /** 已包好前缀的注入正文 */
  content: string
}

/**
 * 根据会话配置扫描候选指令文件，读出内容（**不写任何存储**）。
 * 单选语义：返回至多一个。
 *
 * 注：读配置走 `pick(['settings'])` 而非 `pickSettings`——后者用 json_extract，
 * 无法区分「显式 null（不注入）」和「键缺失（走默认优先级）」。
 */
export function resolveInstructionContent(
  sessionId: string,
  workingDir: string
): ResolvedInstruction | null {
  const configured = sessionDao.pick(sessionId, ['settings'])?.settings?.instructionFile
  const available = scanInstructionFiles(workingDir)
  const selected = resolveInstructionFile(
    configured,
    available.map((f) => f.filename)
  )
  if (!selected) {
    log.info(`session=${sessionId} 未选中任何指令文件，跳过注入`)
    return null
  }

  const entry = available.find((f) => f.filename === selected)
  if (!entry) return null

  let content: string
  try {
    content = readFileSync(entry.absolutePath, 'utf-8').trim()
  } catch (err: unknown) {
    log.warn(
      `读取失败: ${entry.absolutePath} (${err instanceof Error ? err.message : String(err)})`
    )
    return null
  }
  if (!content) {
    log.info(`跳过空文件 ${entry.filename}`)
    return null
  }
  log.info(`解析指令文件 file=${entry.filename} bytes=${content.length}`)
  return {
    filename: entry.filename,
    content: `Project instruction file (${entry.filename}):\n\n${content}`
  }
}
