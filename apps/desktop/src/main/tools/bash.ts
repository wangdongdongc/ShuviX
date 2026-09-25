/**
 * Bash 工具 — 在指定工作目录中执行 shell 命令（仅 macOS / Linux；Windows 上是 powershell 工具）
 * 从 pi-coding-agent 移植，支持输出截断、超时控制、abort。执行路径与 powershell 共用，见 shellCommand.ts
 */

import { t } from '../i18n'
import { stopCommandHint } from '../services/bgTaskService'
import { BASH_PLATFORMS } from '../utils/toolUtils/shell'
import type { ToolContext } from '../services/toolContext'
import {
  ShellCommandTool,
  backgroundParamDescription,
  shellCommandParamsSchema
} from './shellCommand'

const BashParamsSchema = shellCommandParamsSchema({
  command:
    'The shell command to execute. Supports pipes, redirects, and other bash features. Avoid commands that require interactive input.',
  runInBackground: backgroundParamDescription({
    stopHint: stopCommandHint('bash'),
    noDetach: 'do NOT append `&` and do NOT redirect the output yourself',
    answersInline: '`-y`/`--yes` flags, `yes |`, a heredoc'
  })
})

const BASH_DESCRIPTION =
  'Execute a bash command in the working directory. The command runs in a bash shell with pipe and redirect support. Use this for running scripts, installing packages, git operations, builds, etc. Prefer built-in tools over shell commands where one fits: `ls` instead of `find`/`ls`, `grep` instead of `grep`/`rg`, `glob` instead of `find -name`, `read` instead of `cat`/`head`/`tail`, `write` instead of `echo >`, `edit` instead of `sed`/`awk`. Use bash when no built-in tool can accomplish the task.'

export class BashTool extends ShellCommandTool {
  constructor(ctx: ToolContext) {
    super(ctx, {
      shell: 'bash',
      label: t('tool.bashLabel'),
      description: BASH_DESCRIPTION,
      parameters: BashParamsSchema
    })
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'bash',
  group: 'general',
  // Windows 上不解析给 agent：那里的命令工具是 powershell（见 shellCommand.ts 文件头）
  platforms: BASH_PLATFORMS,
  getLabel: () => t('tool.bashLabel'),
  getHint: () => t('tool.bashHint'),
  factory: (ctx) => new BashTool(ctx),
  presentation: {
    icon: 'Terminal',
    iconColor: '#eab308',
    // 展开态融成一段终端会话（提示符 + cwd + 命令 + 输出）；formItems 保留作降级
    detailView: 'terminal',
    formItems: [
      {
        field: 'command',
        renderer: { type: 'code', language: 'bash', wrap: true, lineNumbers: true }
      }
    ],
    showUndeclaredFields: false
  },
  describe: () => ({ description: BASH_DESCRIPTION, parameters: BashParamsSchema })
})
