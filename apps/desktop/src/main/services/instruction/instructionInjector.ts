/**
 * InstructionInjector — 项目指令文件（AGENTS.md / CLAUDE.md）解析
 *
 * 只负责「按会话配置选出文件 + 读出内容」：内容由统一创建管线（createAgent）
 * 直接 append 到系统提示词（先指令文件、后项目提示词），不落任何消息。
 * 系统提示词不参与滚动压缩，无需重注入；Agent 在首条消息时才创建，
 * 「发送第一条消息前调整配置」语义保持；中途切换指令文件经 invalidateAgent 重建生效。
 * （历史会话树中旧机制留下的 custom_message(instruction) 条目仍由 projection 正常渲染。）
 */

import { readFileSync } from 'fs'
import { sessionDao } from '../../dao/sessionDao'
import { scanInstructionFiles } from './instructionFileScanner'
import { createLogger } from '../../logger'
import { resolveInstructionFile } from '@shuvix/chat-protocol/types/instructionFile'

const log = createLogger('InstructionInjector')

export interface ResolvedInstruction {
  filename: string
  /** 指令文件原文（不含任何前缀/围栏——注入侧 createAgent 统一加 `<project_instructions>`） */
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
  return { filename: entry.filename, content }
}
