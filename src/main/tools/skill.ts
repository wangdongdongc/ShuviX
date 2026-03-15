/**
 * Skill 工具 — 按需加载已安装的 Skill 指令集
 * 采用 OpenCode 的 lazy-loading 机制：
 *   - tool description 中嵌入已启用 skill 的名称 + 描述 + 路径索引
 *   - 模型调用时返回完整 SKILL.md 内容 + 目录文件采样列表
 *   - 伴随文件由 agent 使用 Read 工具自行读取
 */

import { resolve } from 'path'
import { Type } from '@sinclair/typebox'
import { rgFiles } from './utils/ripgrep'
import { BaseTool } from './types'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { SkillToolDetails } from '../../shared/types/chatMessage'
import { skillService } from '../services/skillService'
import { t } from '../i18n'

const SkillParamsSchema = Type.Object({
  name: Type.String({
    description: 'The name of the skill from available_skills'
  })
})

/** skill 工具 */
export class SkillTool extends BaseTool<typeof SkillParamsSchema> {
  readonly name = 'skill'
  readonly label = t('tool.skillLabel')
  readonly description: string
  readonly parameters = SkillParamsSchema

  private skills: ReturnType<typeof skillService.findEnabled>
  private projectPath?: string

  constructor(enabledSkillNames: string[], projectPath?: string) {
    super()
    this.projectPath = projectPath

    const allSkills = skillService.findEnabled(projectPath)
    this.skills = allSkills.filter((s) => enabledSkillNames.includes(s.name))

    if (this.skills.length === 0) {
      this.description =
        'Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available.'
    } else {
      // 动态生成 name 参数 hint
      const examples = this.skills
        .slice(0, 3)
        .map((s) => `'${s.name}'`)
        .join(', ')
      const hint = examples ? ` (e.g., ${examples}, ...)` : ''
      ;(this.parameters.properties.name as { description: string }).description =
        `The name of the skill from available_skills${hint}`

      const skillListXml = this.skills
        .map(
          (s) =>
            `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>file://${s.basePath}</location>\n  </skill>`
        )
        .join('\n')

      this.description = [
        'Load a specialized skill that provides domain-specific instructions and workflows.',
        '',
        'When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.',
        '',
        'The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.',
        '',
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        '',
        'The following skills provide specialized sets of instructions for particular tasks.',
        'Invoke this tool to load a skill when a task matches one of the available skills listed below:',
        '',
        '<available_skills>',
        skillListXml,
        '</available_skills>'
      ].join('\n')
    }
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 安全检查 — 只读操作，无确定性安全约束 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  /** 使用 ripgrep 递归扫描 skill 目录文件（排除 SKILL.md，最多 10 个） */
  private async scanSkillFiles(basePath: string): Promise<string[]> {
    const limit = 10
    const result: string[] = []
    try {
      for await (const file of rgFiles({ cwd: basePath, hidden: true })) {
        if (file.includes('SKILL.md')) continue
        result.push(resolve(basePath, file))
        if (result.length >= limit) break
      }
    } catch {
      // ignore — rg may fail on missing directories
    }
    return result
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { name: string }
  ): Promise<AgentToolResult<SkillToolDetails>> {
    const skillName = params.name.trim()

    const skill = skillService.findByName(skillName, this.projectPath)
    if (!skill) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Skill "${skillName}" not found. Available skills: ${this.skills.map((s) => s.name).join(', ') || 'none'}`
          }
        ],
        details: { type: 'skill', skillName, error: true }
      }
    }

    const files = await this.scanSkillFiles(skill.basePath)
    const filesXml =
      files.length > 0
        ? `\n<skill_files>\n${files.map((f) => `<file>${f}</file>`).join('\n')}\n</skill_files>`
        : ''

    const output = [
      `<skill_content name="${skill.name}">`,
      `# Skill: ${skill.name}`,
      '',
      skill.content.trim(),
      '',
      `Base directory for this skill: file://${skill.basePath}`,
      'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
      ...(files.length > 0 ? ['Note: file list is sampled.'] : []),
      filesXml,
      '</skill_content>'
    ].join('\n')

    return {
      content: [{ type: 'text' as const, text: output }],
      details: { type: 'skill', skillName: skill.name, dir: skill.basePath }
    }
  }
}
