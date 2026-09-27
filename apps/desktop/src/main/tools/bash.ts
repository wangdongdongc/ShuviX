/**
 * Bash 工具 — 在指定工作目录中执行 shell 命令（仅 macOS / Linux；Windows 上是 powershell 工具）
 * 从 pi-coding-agent 移植，支持输出截断、超时控制、abort。执行路径与 powershell 共用，见 shellCommand.ts
 *
 * 沙箱：构造时按会话固定「本会话的命令套不套沙箱」（sandbox.pinSession）。套的话 schema 多一个
 * `dangerouslyDisableSandbox`、描述多一段受限范围说明；不套就两样都没有 —— 提示词绝不指向
 * agent 没有的东西。设置页的 describe() 读全局开关。
 */

import { t } from '../i18n'
import { stopCommandHint } from '../services/bgTaskService'
import { pinSession, sandboxGloballyActive } from '../services/sandbox'
import { BASH_PLATFORMS } from '../utils/toolUtils/shell'
import type { ToolContext } from '../services/toolContext'
import {
  ShellCommandTool,
  backgroundParamDescription,
  shellCommandParamsSchema,
  type ShellCommandParamsSchema
} from './shellCommand'

function bashParamsSchema(sandboxed: boolean): ShellCommandParamsSchema {
  return shellCommandParamsSchema({
    command:
      'The shell command to execute. Supports pipes, redirects, and other bash features. Avoid commands that require interactive input.',
    runInBackground: backgroundParamDescription({
      stopHint: stopCommandHint('bash'),
      noDetach: 'do NOT append `&` and do NOT redirect the output yourself',
      answersInline: '`-y`/`--yes` flags, `yes |`, a heredoc'
    }),
    sandboxed
  })
}

const BASH_DESCRIPTION =
  'Execute a bash command in the working directory. The command runs in a bash shell with pipe and redirect support. Use this for running scripts, installing packages, git operations, builds, etc. Prefer built-in tools over shell commands where one fits: `ls` instead of `find`/`ls`, `grep` instead of `grep`/`rg`, `glob` instead of `find -name`, `read` instead of `cat`/`head`/`tail`, `write` instead of `echo >`, `edit` instead of `sed`/`awk`. Use bash when no built-in tool can accomplish the task.'

/**
 * 沙箱启用时追加的说明。写给模型：什么能做、什么做不了、做不了的怎么办。
 * 与 services/sandbox/tables.ts 的清单同义 —— 改清单时同步这里。
 */
const SANDBOX_DESCRIPTION =
  "\n\nCommands run confined in a sandbox, without asking the user. Confined commands can read almost anything and use the network, but can change files only in the working directory, $TMPDIR, /tmp and package-manager caches; credentials (~/.ssh, ~/.aws …), ShuviX's own data and personal folders (Documents, Desktop, Downloads …) are unreadable, and git hooks and git config cannot be written. Some things cannot work confined: creating or cloning a git repository, git commands that write .git/config (remote add, push -u, branch tracking, submodules, worktrees), fetching from or pushing to a private remote over SSH or with stored credentials, gh, opening apps (open), osascript, docker, sudo, and tools that sandbox themselves (swift build, xcodebuild, Playwright or Electron test runs). Only for those, set `dangerouslyDisableSandbox: true`: the command then runs with the user's full privileges and the user may be asked to approve it. When a confined command fails because of the sandbox, the result says what was refused — read it before deciding."

function bashDescription(sandboxed: boolean): string {
  return sandboxed ? BASH_DESCRIPTION + SANDBOX_DESCRIPTION : BASH_DESCRIPTION
}

export class BashTool extends ShellCommandTool {
  constructor(ctx: ToolContext) {
    const sandboxed = pinSession(ctx.sessionId)
    super(ctx, {
      shell: 'bash',
      label: t('tool.bashLabel'),
      description: bashDescription(sandboxed),
      parameters: bashParamsSchema(sandboxed),
      sandboxed
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
  // 设置页展示的是「此刻新建的会话会拿到什么」—— 读全局开关，与已在跑的会话无关
  describe: () => {
    const sandboxed = sandboxGloballyActive()
    return { description: bashDescription(sandboxed), parameters: bashParamsSchema(sandboxed) }
  }
})
