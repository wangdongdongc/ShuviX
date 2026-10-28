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
import type { ToolResult } from '@shuvix/agent-runtime'
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

/**
 * 货架从哪儿来：
 *  - `'enabled'`（创建 agent 时）：侧栏里启用着的**全部**技能（含根会话项目的 `.claude/skills`），去掉
 *    SKILL.md 写了 `disable-model-invocation: true` 的 —— 那种只能由用户 `/名字` 调用。与 Claude Code /
 *    Codex 同一用法：档案不逐个点名，会话也不勾选（2026-10-28）；
 *  - `{ known }`（重开会话、按锁重建时）：锁记着的照收，停用与否不论 —— 锁住的 agent 工具不变（与 MCP
 *    同一条规则：侧栏的开关只作用于之后新建的 agent，要现在生效就销毁 agent）；只有磁盘上已经没了的才从
 *    索引里掉出去。
 */
export type SkillShelf = 'enabled' | { readonly known: readonly string[] }

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

  /** 这一次上架的 skill（全局名，索引里的次序）—— 锁定 agent 时记进锁，重开时按它重建同一个货架 */
  get skillNames(): string[] {
    return this.skills.map((s) => s.name)
  }

  constructor(shelf: SkillShelf, projectPath?: string) {
    super()

    // 内置技能与用户的一视同仁：启用着就上架（用户自带一份作图技能、不想要内置那份时，在侧栏把内置的
    // 关掉）。关闭仍然有效：findEnabled 已经把 .config.json 的 disabled / disabledDirs 过滤掉了。
    //
    // **同名用户 skill 不覆盖内置** —— 与 agent/policy/hook/bot 那套 md 家族**不同**，别照那个
    // 直觉读这里：内置恒带 `dirName='builtin'`，globalName 因此恒为 `builtin:<name>`，而用户
    // 全局目录的就是 `<name>`，两者永远不同名，于是并存、各占索引一行。要让内置那份失效，
    // 路径是 .config.json 的 disabled（或整组 disabledDirs），不是放一个同名文件。
    if (shelf === 'enabled') {
      this.skills = skillService.findModelInvocable(projectPath)
    } else {
      const wanted = new Set(shelf.known)
      this.skills = skillService.findAll(projectPath).filter((s) => wanted.has(s.name))
    }

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
        'Load a skill — instructions, workflows and bundled resources for one kind of task — when the task matches one listed below. Its content comes back in a `<skill_content name="...">` block.',
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
  ): Promise<ToolResult<SkillToolDetails>> {
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
// 不再 hidden：档案 `shuvix-tools` 写 `skill` 才带技能工具（2026-10-28），agent md 属性卡的工具选择器
// 得列出它。没有 factory —— 它按 agent 装（agentHost），不是会话级的内置工具
registerBuiltinTool({
  name: 'skill',
  group: 'general',
  getLabel: () => t('tool.skillLabel'),
  getHint: () => t('tool.skillHint'),
  presentation: {
    icon: 'BookOpen',
    iconColor: '#34d399'
  }
})
