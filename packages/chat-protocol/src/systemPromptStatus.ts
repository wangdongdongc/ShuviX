/**
 * 会话的系统提示词冻结状态（2026-11-06，用户裁决「历史状态不变」）。
 *
 * 根 agent 的系统提示词在这段对话第一次建 agent 时渲染一次、存进会话，之后重启、升级、回退、fork、芯片上的 X
 * 都不改它 —— 改了就会让不支持中途 system 消息的模型整段重算缓存。来源（agent 档案、CLAUDE.md、项目提示词、
 * 知识库勾选、bot 记忆……）改了，这段对话照旧用冻结的那份；界面用这份状态提醒用户，用户点「重建」才换。
 *
 * 宿主无关（ChatApi 契约的一部分），不依赖任何运行时。
 */

/** 系统提示词的段落 key（与 agent-runtime `prompt/sections.ts` 的 `PROMPT_SECTION_KEY` 同名） */
export type SystemPromptSectionKey =
  | 'persona'
  | 'placeholders'
  | 'agents_md'
  | 'claude_md'
  | 'project_prompt'
  | 'knowledge_bases'
  | 'bot_profile'

/** 来源变了的一段 */
export interface StaleSystemPromptSection {
  key: SystemPromptSectionKey
  /** 两个指令文件段落（`agents_md` / `claude_md`）：读的是哪个文件，如 `CLAUDE.md` */
  file?: string
}

export interface SystemPromptStatus {
  /** 这段对话的系统提示词已经冻结（建过 agent）；没冻结 = 下一次建 agent 按此刻的来源渲染，无可提醒 */
  frozen: boolean
  /** 来源与冻结的版本不同的段落（固定次序）；空 = 一致 */
  stale: StaleSystemPromptSection[]
}

/** 重建的结果：`busy` = 会话正在跑（或被中断），等它停下再重建 */
export type RebuildSystemPromptResult = { success: true } | { success: false; reason: 'busy' }

/** 段落在提醒里的次序（与系统提示词里的次序一致） */
export const SYSTEM_PROMPT_SECTION_ORDER: readonly SystemPromptSectionKey[] = [
  'persona',
  'placeholders',
  'agents_md',
  'claude_md',
  'project_prompt',
  'knowledge_bases',
  'bot_profile'
]

/** 从指令文件段落的围栏里读出文件名（`<project_instructions file="CLAUDE.md">`）；读不出 → undefined */
export function instructionFileOf(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  const match = /<project_instructions\s+file="([^"]+)"/.exec(text)
  return match?.[1]
}
