/**
 * CommandService — 从项目 .claude/commands/ 发现并展开斜杠命令
 * 命名约定：commands/review.md → /review，commands/opsx/explore.md → /opsx:explore
 * 模板中 $ARGUMENTS 占位符替换为用户输入的参数
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import type { SlashCommand } from '../../shared/types/slashCommand'
import { skillService } from './skillService'
import { pluginRegistry } from './pluginRegistry'
import { createLogger } from '../logger'

const log = createLogger('CommandService')

class CommandService {
  /**
   * 扫描 <projectPath>/.claude/commands/ 发现所有斜杠命令
   * 只支持一层嵌套（与 Claude Code 一致）
   */
  discoverCommands(projectPath: string): SlashCommand[] {
    const commandsDir = join(projectPath, '.claude', 'commands')
    if (!existsSync(commandsDir)) return []

    const commands: SlashCommand[] = []

    try {
      const entries = readdirSync(commandsDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue

        if (entry.isFile() && entry.name.endsWith('.md')) {
          // 顶层文件：review.md → commandId = "review"
          const commandId = basename(entry.name, '.md')
          const filePath = join(commandsDir, entry.name)
          const cmd = this.loadCommand(commandId, filePath)
          if (cmd) commands.push(cmd)
        } else if (entry.isDirectory()) {
          // 子目录：opsx/explore.md → commandId = "opsx:explore"
          const subDir = join(commandsDir, entry.name)
          try {
            const subEntries = readdirSync(subDir, { withFileTypes: true })
            for (const subEntry of subEntries) {
              if (
                subEntry.isFile() &&
                subEntry.name.endsWith('.md') &&
                !subEntry.name.startsWith('.')
              ) {
                const commandId = `${entry.name}:${basename(subEntry.name, '.md')}`
                const filePath = join(subDir, subEntry.name)
                const cmd = this.loadCommand(commandId, filePath)
                if (cmd) commands.push(cmd)
              }
            }
          } catch (e) {
            log.warn(`读取命令子目录失败: ${subDir}`, e)
          }
        }
      }
    } catch (e) {
      log.warn(`读取命令目录失败: ${commandsDir}`, e)
    }

    return commands.sort((a, b) => a.commandId.localeCompare(b.commandId))
  }

  /** 展开命令模板：替换 $ARGUMENTS 占位符，若模板中无占位符则追加到末尾 */
  expandCommand(command: SlashCommand, args: string): string {
    if (command.template.includes('$ARGUMENTS')) {
      return command.template.replaceAll('$ARGUMENTS', args)
    }
    // 模板中无 $ARGUMENTS 占位符，将用户参数追加到末尾
    if (args) {
      return `${command.template}\n\n${args}`
    }
    return command.template
  }

  /**
   * 匹配并展开：从用户输入中解析命令，查找并展开
   * 输入格式："/opsx:explore 分析一下" → commandId="opsx:explore", args="分析一下"
   * 返回 null 表示未匹配到任何命令
   */
  matchAndExpand(
    workingDir: string | null,
    text: string,
    enabledTools?: string[]
  ): {
    commandId: string
    commandName: string
    args: string
    expandedText: string
    originalText: string
  } | null {
    if (!text.startsWith('/')) return null

    // 解析 commandId 和 args
    const withoutSlash = text.slice(1)
    const spaceIdx = withoutSlash.indexOf(' ')
    const commandId = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)
    const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim()

    if (!commandId) return null

    // 查找匹配的命令（文件系统 + 内置）
    const commands = workingDir ? this.discoverCommands(workingDir) : []
    if (enabledTools) {
      commands.push(...this.getBuiltinCommands(enabledTools))
    }
    const command = commands.find((c) => c.commandId === commandId)
    if (!command) return null

    return {
      commandId,
      commandName: command.name,
      args,
      expandedText: this.expandCommand(command, args),
      originalText: text
    }
  }

  /** 加载单个命令文件 */
  private loadCommand(commandId: string, filePath: string): SlashCommand | null {
    try {
      if (!statSync(filePath).isFile()) return null
      const raw = readFileSync(filePath, 'utf-8')

      // 尝试解析 frontmatter（复用 skillService 的解析逻辑）
      const parsed = skillService.parseSkillMarkdown(raw)

      if (parsed) {
        return {
          commandId,
          name: parsed.name || commandId,
          description: parsed.description || '',
          template: parsed.content,
          filePath
        }
      }

      // 无 frontmatter：整个文件作为 template
      return {
        commandId,
        name: commandId,
        description: '',
        template: raw.trim(),
        filePath
      }
    } catch (e) {
      log.warn(`加载命令文件失败: ${filePath}`, e)
      return null
    }
  }

  /** 获取插件贡献的命令（按启用工具过滤） */
  getBuiltinCommands(enabledTools: string[]): SlashCommand[] {
    return pluginRegistry.getAllCommands(enabledTools)
  }
}

export const commandService = new CommandService()
