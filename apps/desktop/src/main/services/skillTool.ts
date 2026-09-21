/**
 * Skill 工具 — 按需加载已安装的 Skill 指令集
 * 采用 OpenCode 的 lazy-loading 机制：
 *   - tool description 中嵌入已启用 skill 的名称 + 描述 + 路径索引
 *   - 模型调用时返回完整 SKILL.md 内容 + 目录文件采样列表
 *   - 伴随文件由 agent 使用 Read 工具自行读取
 */

import { resolve } from 'path'
import { Type } from 'typebox'
import type { TObject, TString } from 'typebox'
import { rgFiles } from '../utils/toolUtils/ripgrep'
import { BaseTool } from '@shuvix/agent-runtime'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { SkillToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { skillService } from './skillService'
import { t } from '../i18n'

/**
 * 每个实例现造一份 schema —— **不要**改回模块级常量 + 构造函数就地改写。
 *
 * 把一个模块级常量直接赋给 `readonly parameters`，等于把同一个对象引用交给每一个实例，于是往
 * `parameters.properties.name.description` 里写本次在架名单的示例名，就是写给所有还活着的
 * SkillTool：最后构造的那个会话的示例名会盖掉先前每一个，连「这次一个 skill 都没有」的
 * 实例也照样带着别的会话的示例名。深拷贝不是出路 —— TypeBox 的 schema 带 Symbol 键
 * （`Symbol.for('TypeBox.Kind')`），structuredClone 会把它们丢掉。
 */
const makeSkillParams = (hint: string): TObject<{ name: TString }> =>
  Type.Object({
    name: Type.String({ description: `The name of the skill from available_skills${hint}` })
  })

/** 类型锚点：各实例的 schema 同形，值各造各的 */
type SkillParams = ReturnType<typeof makeSkillParams>

/** skill 工具 */
export class SkillTool extends BaseTool<SkillParams> {
  readonly name = 'skill'
  readonly label = t('tool.skillLabel')
  readonly description: string
  readonly parameters: SkillParams

  private skills: ReturnType<typeof skillService.findEnabled>

  /** 这一次装配到底有没有 skill 可给 —— 注入点据此决定要不要挂上本工具 */
  get hasSkills(): boolean {
    return this.skills.length > 0
  }

  constructor(skillNames: string[], projectPath?: string) {
    super()

    // 上架的只有名单点了名的 skill：档案 `shuvix-tools` 声明的（内置的写作 `skill:builtin:<name>`）
    // 加上会话勾选的。内置 skill 没有「不点名也在架」的特例 —— 哪个 agent 带它，由它的档案 md
    // 说了算（用户不必为了让图画得好先知道有这么个技能再去勾它：基座档案已经替他点了名，界面上
    // 画成已勾、锁住）。
    //
    // 关闭仍然有效：findEnabled 已经把 .config.json 的 disabled / disabledDirs 过滤掉了。
    //
    // **同名用户 skill 不覆盖内置** —— 与 agent/policy/hook/bot 那套 md 家族**不同**，别照那个
    // 直觉读这里：内置恒带 `dirName='builtin'`，globalName 因此恒为 `builtin:<name>`，而用户
    // 全局目录的就是 `<name>`，两者永远不同名，于是并存、各占索引一行。要让内置那份失效，
    // 路径是 .config.json 的 disabled（或整组 disabledDirs），不是放一个同名文件。
    const wanted = new Set(skillNames)
    this.skills = skillService.findEnabled(projectPath).filter((s) => wanted.has(s.name))

    // hint 无条件参与本实例的 schema 构造：空架子就得到空 hint，不会留着别处的示例名
    const examples = this.skills
      .slice(0, 3)
      .map((s) => `'${s.name}'`)
      .join(', ')
    this.parameters = makeSkillParams(examples ? ` (e.g., ${examples}, ...)` : '')

    if (this.skills.length === 0) {
      this.description =
        'Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available.'
    } else {
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

    // 从**这一次装配的名单**里取，而不是 findByName（它走 findAll，不看 .config.json 的
    // disabled / disabledDirs）。否则「关掉」只是把它从索引里摘掉，模型按名调用照样拿到全文 ——
    // 而内置 drawing 的名字写在每个 root agent 的常驻提示里，那条路径是默认可达的，不是理论。
    const skill = this.skills.find((s) => s.name === skillName) ?? null
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
      `Base directory for this skill: ${skill.basePath}`,
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

import { registerBuiltinTool } from './toolRegistry'
registerBuiltinTool({
  name: 'skill',
  group: 'general',
  hidden: true,
  getLabel: () => t('tool.skillLabel'),
  getHint: () => t('tool.skillHint'),
  presentation: {
    icon: 'BookOpen',
    iconColor: '#34d399'
  }
})
