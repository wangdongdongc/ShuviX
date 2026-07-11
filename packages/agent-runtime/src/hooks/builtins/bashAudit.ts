/**
 * 内置 hook：危险命令审计（PreToolUse on bash）—— 各端共享。
 *
 * 命中以下任一模式立即拒绝（同时 logger.warn）：
 *
 * **POSIX**：
 * - `rm -rf /`             根目录递归删除
 * - `:(){ :|:& };:`        bash fork 炸弹
 * - `mkfs(.xxx)`           格式化
 * - `dd if=... of=/dev/sd*` (或 nvme / disk) 磁盘块设备覆盖写
 *
 * **Windows**：
 * - `format <drive>:`      格式化磁盘
 * - `del/rd/rmdir /s /q <drive>:\`   驱动器根目录递归删除
 * - `cipher /w:<drive>:`   安全擦除
 * - `%0|%0`                cmd fork 炸弹
 * - `Remove-Item -Recurse -Force <drive>:\` PowerShell 递归强删
 *
 * 所有模式都跨平台同时启用 —— 即使是 Linux 用户也可能通过 WSL/容器跑 cmd，
 * 反之亦然；额外的正则匹配成本可忽略，过严比漏判好。
 *
 * 仅做关键字级匹配，足以挡住"模型 hallucinate 出灾难命令"的最常见情况。
 */
import type { HookHandler, HookInput, HookOutput } from '@shuvix/chat-protocol/types/hook'
import type { RuntimeLogger } from '../../types'

interface BashArgs {
  command?: unknown
}

/** 单正则匹配；不便用正则表达的复杂条件走 predicate */
type Check = { re: RegExp; label: string } | { predicate: (cmd: string) => boolean; label: string }

const DANGEROUS_PATTERNS: ReadonlyArray<Check> = [
  // ── POSIX ───────────────────────────────────────────────
  { re: /\brm\s+-[rRfF]+\s+\/(\s|$|\*)/, label: 'rm -rf /' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/, label: 'fork bomb (bash)' },
  { re: /\bmkfs(\.|\s)/, label: 'mkfs' },
  { re: /\bdd\s+if=.+\s+of=\/dev\/(sd[a-z]|nvme|disk)/, label: 'dd to disk device' },

  // ── Windows ─────────────────────────────────────────────
  // format <drive>:  （`/q` `/fs:` 等参数可选）
  { re: /\bformat\s+[A-Za-z]:/i, label: 'format <drive>:' },
  // del / rd / rmdir 带 /s /q 指向驱动器根目录
  {
    re: /\b(del|rd|rmdir)\s+(\/[sqfSQF]\s+)+[A-Za-z]:[\\/]?(\s|$|\*)/i,
    label: 'recursive delete from drive root'
  },
  // cipher /w:X:
  { re: /\bcipher\s+\/w:[A-Za-z]:/i, label: 'cipher /w drive wipe' },
  // cmd fork bomb：%0|%0
  { re: /%0\s*\|\s*%0/, label: 'fork bomb (cmd)' },
  // PowerShell：Remove-Item + -Recurse + -Force + <drive>:\ 参数顺序无关
  {
    predicate: (cmd) =>
      /\bRemove-Item\b/i.test(cmd) &&
      /-Recurse\b/i.test(cmd) &&
      /-Force\b/i.test(cmd) &&
      /[A-Za-z]:[\\/](\s|$|["'])/.test(cmd),
    label: 'PowerShell Remove-Item drive root'
  }
]

export function findDangerousPattern(command: string): string | null {
  for (const check of DANGEROUS_PATTERNS) {
    if ('re' in check) {
      if (check.re.test(command)) return check.label
    } else {
      if (check.predicate(command)) return check.label
    }
  }
  return null
}

/** 构造 bash-audit handler（注入 logger）。 */
export function makeBashAudit(logger: RuntimeLogger): HookHandler {
  return (input: HookInput): HookOutput | void => {
    const args = input.tool_input as BashArgs | undefined
    const cmd = args?.command
    if (typeof cmd !== 'string' || !cmd) return

    const hit = findDangerousPattern(cmd)
    if (hit) {
      logger.warn(
        `bash-audit 拦截: ${hit} session=${input.session_id} command="${cmd.slice(0, 200)}"`
      )
      return {
        hookSpecificOutput: {
          permissionDecision: 'deny',
          reason: `bash-audit: refused dangerous command (${hit})`
        }
      }
    }
  }
}
