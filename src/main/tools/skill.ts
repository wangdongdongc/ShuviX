/**
 * Skill 工具 — 按需加载已安装的 Skill 指令集
 * 采用 Claude Code 的 lazy-loading 机制：
 *   - tool description 中嵌入已启用 skill 的名称 + 描述索引
 *   - 模型调用时返回完整 SKILL.md 内容
 *   - 支持读取伴随文件：command: "pdf/REFERENCE.md"
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { skillService } from '../services/skillService'
import { t } from '../i18n'

const SkillParamsSchema = Type.Object({
  command: Type.String({
    description: 'The skill name to load, or skill_name/file_path to read a companion file. E.g., "pdf", "brand-guide", "pdf/REFERENCE.md"'
  })
})

/** 创建 skill 工具实例（仅当有已启用 skill 时调用） */
export function createSkillTool(enabledSkillNames: string[]): AgentTool<typeof SkillParamsSchema> {
  // 从文件系统加载已启用且在 enabledSkillNames 中的 skill
  const skills = skillService.findEnabled().filter((s) => enabledSkillNames.includes(s.name))

  // 构建 <available_skills> XML 嵌入 tool description
  const skillListXml = skills
    .map(
      (s) =>
        `<skill>\n  <name>${s.name}</name>\n  <description>${s.description}</description>\n</skill>`
    )
    .join('\n')

  const description = `Execute a skill within the main conversation.

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Load a skill: command: "pdf" — returns the skill's instructions
- Read companion file: command: "pdf/REFERENCE.md" — reads a referenced file within the skill directory
- Examples: command: "pdf", command: "brand-guide", command: "pdf/FORMS.md"

Important:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- When a skill's instructions reference companion files (e.g., "see REFERENCE.md"), use this tool with "skill_name/filename" to read them
</skills_instructions>

<available_skills>
${skillListXml}
</available_skills>`

  return {
    name: 'skill',
    label: t('tool.skillLabel'),
    description,
    parameters: SkillParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { command: string }
    ) => {
      const cmd = params.command.trim()
      const slashIdx = cmd.indexOf('/')

      // 判断是加载 skill 还是读取伴随文件
      if (slashIdx > 0) {
        // command: "pdf/REFERENCE.md" — 读取伴随文件
        const skillName = cmd.slice(0, slashIdx)
        const filePath = cmd.slice(slashIdx + 1)
        const content = skillService.readCompanionFile(skillName, filePath)
        if (content === null) {
          return {
            content: [{ type: 'text' as const, text: `File "${filePath}" not found in skill "${skillName}".` }],
            details: { skillName, file: filePath, error: true }
          }
        }
        return {
          content: [{ type: 'text' as const, text: content }],
          details: { skillName, file: filePath }
        }
      }

      // command: "pdf" — 加载 skill 主内容
      const skill = skillService.findByName(cmd)
      if (!skill) {
        return {
          content: [{ type: 'text' as const, text: `Skill "${cmd}" not found. Available skills: ${skills.map((s) => s.name).join(', ')}` }],
          details: { skillName: cmd, error: true }
        }
      }

      // 返回 skill 内容，附带目录路径提示
      const header = `[Skill: ${skill.name} | Directory: ${skill.basePath}]\n\n`
      return {
        content: [{ type: 'text' as const, text: `${header}${skill.content}` }],
        details: { skillName: skill.name }
      }
    }
  }
}
