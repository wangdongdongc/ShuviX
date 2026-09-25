/**
 * PowerShell 工具 — Windows 上的命令工具（macOS / Linux 上是 bash 工具）。
 * 执行路径与 bash 共用（见 shellCommand.ts），可执行文件与固定参数见 shell.ts 的 getPowerShellConfig。
 *
 * 描述里的规则针对的是模型在 Windows 上最常犯的几类错：把 bash 语法写进 PowerShell
 * （`$HOME`、`\` 转义、`&&` 在 5.1 里不存在），以及再套一层 `powershell -Command "…"` ——
 * 外层先把 `$` 展开，内层拿到的已经是残缺的命令。
 */

import { t } from '../i18n'
import { stopCommandHint } from '../services/bgTaskService'
import type { ToolContext } from '../services/toolContext'
import {
  MAX_POWERSHELL_COMMAND_CHARS,
  POWERSHELL_PLATFORMS,
  getPowerShellConfig,
  powerShellCommandLineLength,
  powerShellEditionLabel,
  type PowerShellEdition
} from '../utils/toolUtils/shell'
import {
  ShellCommandTool,
  backgroundParamDescription,
  shellCommandParamsSchema
} from './shellCommand'

const PowerShellParamsSchema = shellCommandParamsSchema({
  command:
    'The PowerShell command to execute. Supports pipelines, redirects, and multiple statements. Avoid commands that require interactive input.',
  runInBackground: backgroundParamDescription({
    stopHint: stopCommandHint('powershell'),
    noDetach:
      'do NOT wrap it in `Start-Process` / `Start-Job`, do NOT end it with `&`, and do NOT redirect the output yourself',
    answersInline: '`-y`/`--yes` flags, `-Force`, `-Confirm:$false`'
  })
})

/**
 * 这台机器上实际会用到的版本；不在 Windows 上（设置页在任意平台展示工具描述）时为 null，
 * 描述改说两种可能。
 */
function currentEdition(): PowerShellEdition | null {
  if (process.platform !== 'win32') return null
  try {
    return getPowerShellConfig().edition
  } catch {
    return null
  }
}

function powershellDescription(): string {
  const edition = currentEdition()
  const runsIn = edition
    ? `It runs in ${powerShellEditionLabel(edition)}.`
    : 'It runs in PowerShell 7 (pwsh) when installed, otherwise in Windows PowerShell 5.1.'
  const chaining =
    edition === 'pwsh'
      ? '`&&` and `||` chain on success / failure as in bash.'
      : edition === 'windows-powershell'
        ? '`&&` and `||` do not exist in Windows PowerShell 5.1 — use `first; if ($?) { second }`.'
        : '`&&` and `||` exist only in PowerShell 7 — in 5.1 use `first; if ($?) { second }`.'
  return [
    `Execute a PowerShell command in the working directory. ${runsIn} Write PowerShell, not bash or cmd:`,
    '- Environment variables are `$env:NAME` (`$env:PATH`, `$env:USERPROFILE`), not `$NAME` or `%NAME%`.',
    "- Single-quoted strings are literal ('$x' stays $x); double-quoted strings expand `$variables` and `$(...)`. For multi-line literal text use a single-quoted here-string: `@'` ending its line, the text, then `'@` at the very start of a line.",
    '- The escape character is the backtick (`), not backslash — a backslash is an ordinary path separator.',
    `- Separate statements with \`;\` or newlines. ${chaining}`,
    '- Run programs directly. Never wrap the command in another `powershell -Command`, `pwsh -c` or `bash -c`: the outer layer expands `$` before the inner one sees it. For a cmd.exe built-in use `cmd /c "…"`.',
    "- A program whose path contains spaces needs the call operator: `& 'C:\\Program Files\\app\\app.exe' --flag`.",
    '- Commands that would ask for confirmation fail instead of waiting; pass `-Force` or `-Confirm:$false` when you mean it.',
    '- The exit code is 0 when the last statement succeeded and 1 otherwise; the exit code of a native program is in `$LASTEXITCODE` (end with `exit $LASTEXITCODE` when the exact code matters).',
    'Use this for running scripts, installing packages, git operations, builds, etc. Prefer built-in tools over shell commands where one fits: `ls` instead of `Get-ChildItem`/`dir`, `grep` instead of `Select-String`, `glob` instead of `Get-ChildItem -Recurse -Filter`, `read` instead of `Get-Content`/`cat`, `write` instead of `Set-Content`/`Out-File`, `edit` instead of `-replace` rewrites. Use powershell when no built-in tool can accomplish the task.'
  ].join('\n')
}

/** 命令行放不下时在询问之前回话，而不是让用户批准一条 spawn 不起来的命令 */
function rejectOversized(command: string): string | null {
  const length = powerShellCommandLineLength(command)
  if (length <= MAX_POWERSHELL_COMMAND_CHARS) return null
  return (
    `Command was not executed: on the Windows command line it takes ${length} characters, over the ` +
    `${MAX_POWERSHELL_COMMAND_CHARS} a single PowerShell invocation can carry. Write the script to a ` +
    ".ps1 file with the write tool and run it with `& './script.ps1'`."
  )
}

export class PowerShellTool extends ShellCommandTool {
  constructor(ctx: ToolContext) {
    super(ctx, {
      shell: 'powershell',
      label: t('tool.powershellLabel'),
      description: powershellDescription(),
      parameters: PowerShellParamsSchema,
      reject: rejectOversized
    })
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'powershell',
  group: 'general',
  // 只在 Windows 上解析给 agent：macOS / Linux 上的命令工具是 bash
  platforms: POWERSHELL_PLATFORMS,
  getLabel: () => t('tool.powershellLabel'),
  getHint: () => t('tool.powershellHint'),
  factory: (ctx) => new PowerShellTool(ctx),
  presentation: {
    icon: 'Terminal',
    iconColor: '#3b82f6',
    // 与 bash 同一种终端形态详情；formItems 保留作降级
    detailView: 'terminal',
    formItems: [
      {
        field: 'command',
        renderer: { type: 'code', language: 'powershell', wrap: true, lineNumbers: true }
      }
    ],
    showUndeclaredFields: false
  },
  describe: () => ({ description: powershellDescription(), parameters: PowerShellParamsSchema })
})
