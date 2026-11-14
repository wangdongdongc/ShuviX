/**
 * agent md 的提示词块词表（`shuvix-prompt-blocks`，2026-11-13）：
 *   APB-1 orderPromptBlocks 是集合运算：去重、按词表次序、只认词表里的原名、每次交回新数组
 *   APB-2 词表本身（次序即提示词里的次序）、键名与 isAgentPromptBlock
 *   APB-3 指令文件对照表与系统提示词状态的契约一致（同名的段落 key、同样的先后、围栏里读得出同一个文件名）
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_BLOCKS,
  AGENT_PROMPT_BLOCKS_KEY,
  INSTRUCTION_FILE_OF_BLOCK,
  isAgentPromptBlock,
  orderPromptBlocks
} from './agentPromptBlocks'
import { instructionFileOf, SYSTEM_PROMPT_SECTION_ORDER } from './systemPromptStatus'

describe('agent prompt blocks vocabulary', () => {
  it('APB-1 orderPromptBlocks is a set operation: duplicates collapse, vocabulary order, any iterable, exact names only, a fresh array each call', () => {
    expect(orderPromptBlocks(['project_prompt', 'environment', 'environment', 'document'])).toEqual(
      ['document', 'environment', 'project_prompt']
    )
    expect(orderPromptBlocks(new Set(['claude_md', 'agents_md']))).toEqual([
      'agents_md',
      'claude_md'
    ])
    // 精确匹配：大小写归一是解析器的事；`extensions` 不在词表里（它跟着 tool_search 走）
    expect(orderPromptBlocks(['Environment', 'agents-md', 'extensions', ''])).toEqual([])
    expect(orderPromptBlocks([])).toEqual([])

    // 交回的是新数组：改它不动词表，也不是上一次交回的那个
    const all = orderPromptBlocks(AGENT_PROMPT_BLOCKS)
    expect(all).toEqual([...AGENT_PROMPT_BLOCKS])
    expect(all).not.toBe(AGENT_PROMPT_BLOCKS)
    expect(orderPromptBlocks(AGENT_PROMPT_BLOCKS)).not.toBe(all)
    all.pop()
    all.reverse()
    expect(AGENT_PROMPT_BLOCKS).toHaveLength(6)
    expect(orderPromptBlocks(AGENT_PROMPT_BLOCKS)).toEqual([...AGENT_PROMPT_BLOCKS])
  })

  it('APB-2 the vocabulary is exactly six names in prompt order, with its frontmatter key and guard', () => {
    expect(AGENT_PROMPT_BLOCKS).toEqual([
      'document',
      'drawing',
      'environment',
      'agents_md',
      'claude_md',
      'project_prompt'
    ])
    expect(AGENT_PROMPT_BLOCKS_KEY).toBe('shuvix-prompt-blocks')
    for (const name of AGENT_PROMPT_BLOCKS) expect(isAgentPromptBlock(name), name).toBe(true)
    for (const name of [
      'extensions',
      'Environment',
      '',
      'constructor',
      'toString',
      'knowledge_bases'
    ]) {
      expect(isAgentPromptBlock(name), JSON.stringify(name)).toBe(false)
    }
  })

  it('APB-3 the instruction-file table agrees with the status contract: same keys, same order, and the fence names the same file', () => {
    expect(INSTRUCTION_FILE_OF_BLOCK).toEqual({ agents_md: 'AGENTS.md', claude_md: 'CLAUDE.md' })
    const blocks: readonly string[] = AGENT_PROMPT_BLOCKS
    const sections: readonly string[] = SYSTEM_PROMPT_SECTION_ORDER
    for (const [block, file] of Object.entries(INSTRUCTION_FILE_OF_BLOCK)) {
      expect(blocks, block).toContain(block)
      expect(sections, block).toContain(block)
      // 状态里带的文件名就是围栏上写的那个
      expect(
        instructionFileOf(`<project_instructions file="${file}">\nx\n</project_instructions>`),
        block
      ).toBe(file)
    }
    for (const list of [blocks, sections]) {
      expect(list.indexOf('agents_md')).toBeGreaterThanOrEqual(0)
      expect(list.indexOf('agents_md')).toBeLessThan(list.indexOf('claude_md'))
      expect(list.indexOf('claude_md')).toBeLessThan(list.indexOf('project_prompt'))
    }
  })
})
