/**
 * agent md 的提示词块（`shuvix-prompt-blocks`）—— 这个 agent 的系统提示词在正文之后还追加哪几块。
 *
 * 正文是纯文字，不再有 `{{shuvix:*}}` 变量（2026-11-13，用户裁决：变量对用户难懂）。会话相关的内容由宿主
 * 渲染成块、各包在一个 XML 标签里追加在正文后面；档案只用这张固定词表说「要哪几块」。它同时取代了
 * `shuvix-instruction-files`（拆成 `agents_md` / `claude_md` 两项）与 `shuvix-project-awareness`（`project_prompt`）。
 *
 * 规矩：
 *  - **列表是集合，不是顺序**：先后由宿主固定（见 {@link AGENT_PROMPT_BLOCKS} 的次序），写出时也按这个次序。
 *  - **列了不等于一定出现**：宿主仍按条件判断（没有作图技能、不是笔记本会话、工作目录里没有这个文件、
 *    会话没有项目……），不满足时整块不出 —— 提示词不指向 agent 手里没有的东西。
 *  - **两个指令文件各读各的**：都列、都存在就都进提示词；内容完全相同（一个是另一个的链接或副本）只留一份。
 *  - 只属于某个工具的说明不在词表里，跟着工具走：知识库说明跟 `knowledge`，可开启的扩展跟 `tool_search`。
 *
 * 放在 chat-protocol：解析器（agent-runtime）、属性卡片（app-shell）与新建模板（桌面渲染进程）读同一张表。
 */

/** frontmatter 键 */
export const AGENT_PROMPT_BLOCKS_KEY = 'shuvix-prompt-blocks'

/**
 * 词表，也是块在系统提示词里的固定次序。前三项在创建 agent 时渲染、并入人设一起冻结；后三项是各自独立的段落，
 * 按来源比对是否过期。
 */
export const AGENT_PROMPT_BLOCKS = [
  'document',
  'drawing',
  'environment',
  'agents_md',
  'claude_md',
  'project_prompt'
] as const

export type AgentPromptBlock = (typeof AGENT_PROMPT_BLOCKS)[number]

/** 两个指令文件块各自读工作目录下的哪个文件 */
export const INSTRUCTION_FILE_OF_BLOCK = {
  agents_md: 'AGENTS.md',
  claude_md: 'CLAUDE.md'
} as const satisfies Partial<Record<AgentPromptBlock, string>>

export type InstructionFileBlock = keyof typeof INSTRUCTION_FILE_OF_BLOCK

export function isAgentPromptBlock(value: string): value is AgentPromptBlock {
  return (AGENT_PROMPT_BLOCKS as readonly string[]).includes(value)
}

/** 归一：去重、按词表次序排（列表是集合） */
export function orderPromptBlocks(blocks: Iterable<string>): AgentPromptBlock[] {
  const wanted = new Set(blocks)
  return AGENT_PROMPT_BLOCKS.filter((name) => wanted.has(name))
}
