/**
 * 系统提示词冻结状态的契约（2026-11-06）：提醒里段落的次序，以及从指令文件段落的围栏里读出文件名。
 *
 *   CP-1 instructionFileOf：null / undefined / '' / 没有围栏 / 别的标签 → undefined；
 *        `<project_instructions file="…">` → 文件名（围栏前后有别的文本、属性前多个空白、换行也认）；
 *        file 属性为空、不带引号、或不是紧跟在标签名后的第一个属性 → undefined（只认宿主自己写的那种围栏）
 *   CP-2 SYSTEM_PROMPT_SECTION_ORDER 是六个段落 key，按系统提示词里的次序（人设、占位符、指令文件、项目提示词、
 *        知识库、bot），不重复
 */
import { describe, expect, it } from 'vitest'
import { instructionFileOf, SYSTEM_PROMPT_SECTION_ORDER } from './systemPromptStatus'

/** 与 agent-runtime `prompt/fences.ts` 的 `fenceInstructionFile` 同一形状（chat-protocol 是叶子包，不引它） */
const fence = (file: string, content = 'Use pnpm.'): string =>
  `<project_instructions file="${file}">\n${content}\n</project_instructions>`

describe('instructionFileOf', () => {
  it.each<[string, string | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['plain text without a fence', 'Use pnpm. file="AGENTS.md"'],
    ['another tag', '<project_prompt file="AGENTS.md">\nx\n</project_prompt>'],
    ['an empty file attribute', '<project_instructions file="">\nx\n</project_instructions>'],
    [
      'an unquoted file attribute',
      '<project_instructions file=AGENTS.md>\nx\n</project_instructions>'
    ],
    [
      'file not the first attribute',
      '<project_instructions kind="x" file="AGENTS.md">\nx\n</project_instructions>'
    ]
  ])('CP-1 %s → undefined', (_label, input) => {
    expect(instructionFileOf(input)).toBeUndefined()
  })

  it('CP-1 the host fence gives the file name', () => {
    expect(instructionFileOf(fence('AGENTS.md'))).toBe('AGENTS.md')
    expect(instructionFileOf(fence('CLAUDE.md', 'a\n\nb'))).toBe('CLAUDE.md')
    // 子目录里的指令文件：路径原样
    expect(instructionFileOf(fence('docs/AGENTS.md'))).toBe('docs/AGENTS.md')
  })

  it('CP-1 text around the fence, extra whitespace before the attribute and later attributes are tolerated', () => {
    expect(instructionFileOf(`Persona first.\n\n${fence('CLAUDE.md')}\n\ntail`)).toBe('CLAUDE.md')
    expect(
      instructionFileOf('<project_instructions   file="AGENTS.md">\nx\n</project_instructions>')
    ).toBe('AGENTS.md')
    expect(
      instructionFileOf('<project_instructions\nfile="AGENTS.md">\nx\n</project_instructions>')
    ).toBe('AGENTS.md')
    expect(
      instructionFileOf(
        '<project_instructions file="AGENTS.md" extra="1">\nx\n</project_instructions>'
      )
    ).toBe('AGENTS.md')
  })

  it('CP-1 two fences: the first one wins', () => {
    expect(instructionFileOf(`${fence('AGENTS.md')}\n\n${fence('CLAUDE.md')}`)).toBe('AGENTS.md')
  })
})

describe('SYSTEM_PROMPT_SECTION_ORDER', () => {
  it('CP-2 lists the seven section keys once each, in system-prompt order', () => {
    expect(SYSTEM_PROMPT_SECTION_ORDER).toEqual([
      'persona',
      'placeholders',
      'agents_md',
      'claude_md',
      'project_prompt',
      'knowledge_bases',
      'bot_profile'
    ])
    expect(new Set(SYSTEM_PROMPT_SECTION_ORDER).size).toBe(SYSTEM_PROMPT_SECTION_ORDER.length)
  })
})
