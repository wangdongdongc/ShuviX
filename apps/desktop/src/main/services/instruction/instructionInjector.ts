/**
 * InstructionInjector — 项目指令文件解析（桌面实现）
 *
 * 「读哪些文件」由 agent 档案的 `shuvix-instruction-files` 清单给出（顺序即优先级），
 * 本模块只负责「按清单在工作目录里找第一个存在且非空的 + 读出内容」。内容由统一创建
 * 管线（createAgent）直接 append 到系统提示词（先指令文件、后项目提示词），不落任何消息。
 * 系统提示词不参与滚动压缩，无需重注入；Agent 在首条消息时才创建，
 * 「发送第一条消息前调整配置」语义保持；切换会话档案经 invalidateAgent 重建生效。
 *
 * 曾经这里还要读会话设置里的单选（settings.instructionFile）与一张内置候选名表 ——
 * 两者都随「选取逻辑搬进 agent md」一并去掉了：档案给什么就读什么，本模块无自有候选。
 * （历史会话树中旧机制留下的 custom_message(instruction) 条目仍由 projection 正常渲染。）
 */

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../../logger'

const log = createLogger('InstructionInjector')

export interface ResolvedInstruction {
  /** 命中的清单条目（原样的相对路径，供围栏的 file= 标注与日志显示） */
  filename: string
  /** 指令文件原文（不含任何前缀/围栏——注入侧 createAgent 统一加 `<project_instructions>`） */
  content: string
}

/**
 * 按档案清单解析要注入的项目指令文件，读出内容（**不写任何存储**）。
 * 单选语义：返回至多一个 —— 清单里第一个存在、可读且非空的条目。
 *
 * 条目已由 agent md 解析器归一为工作目录内的相对路径（拒收绝对路径与 `..`），
 * 故此处直接 join 即可；读失败/非文件/空文件都只是「这条不算命中」，继续看下一条。
 */
export function resolveInstructionContent(
  workingDir: string,
  candidates: readonly string[]
): ResolvedInstruction | null {
  if (!workingDir || candidates.length === 0) return null

  for (const name of candidates) {
    const absolutePath = join(workingDir, name)
    try {
      if (!statSync(absolutePath).isFile()) continue
    } catch {
      continue // 不存在 → 看下一个候选
    }
    let content: string
    try {
      content = readFileSync(absolutePath, 'utf-8').trim()
    } catch (err: unknown) {
      log.warn(`读取失败: ${absolutePath} (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    if (!content) {
      log.info(`跳过空文件 ${name}`)
      continue
    }
    log.info(`解析指令文件 file=${name} bytes=${content.length}`)
    return { filename: name, content }
  }

  log.info(`${workingDir} 下未命中清单 [${candidates.join(', ')}]，跳过注入`)
  return null
}
