/**
 * PowerShell 命令解析层 —— 纯数据类型。
 *
 * 与 bash 那一层（`../shell/`）同一条红线，而且更窄：这里**只有宽松轨**。
 * 产出只能用来发现危险（拦截 / 询问），**不能用来证明安全**：没有严格轨，
 * 也就没有任何字段可以拿来放行。理由见 analyze.ts 文件头。
 */
import type { ShellFacts, ShellRedirectKind, ShellSpan } from '../shell/types'

/**
 * 这条命令是按哪种语言读出来的。PowerShell 命令里嵌着的 `cmd /c "…"` 载荷按 cmd.exe
 * 的规则读，产出的命令也记在这里（`bash -c` 载荷交给宿主的 bash 解析器，见 nestedBash）。
 */
export type PowerShellCommandShell = 'powershell' | 'cmd'

/** 抽出的一条命令 */
export interface PowerShellCommand {
  shell: PowerShellCommandShell
  /** 去掉 wrapper 之后 argv[0] 的字面值；不可静态确定时为空串 */
  name: string
  /**
   * 规范化的命令名：去掉路径 / 模块限定前缀与 `.exe` / `.com` 扩展名，默认别名解析成
   * cmdlet 名（`rm` / `del` / `rd` → `Remove-Item`）。**大小写不做统一** —— PowerShell 的
   * 命令名不区分大小写，规则里一律先 `lowerAscii()` 再比。name 为空时同为空串。
   */
  base: string
  /**
   * 去掉 wrapper 之后的各参数字面值，**动态词以 null 占位以保留位置**；argv[0] 即 name。
   * `-Name:value` 拆成 `-Name` 与 value 两项；`-Switch:$true` 只留 `-Switch`，
   * `-Switch:$false` 原样留成一项（开关是关的，不能读成打开）。
   */
  argv: (string | null)[]
  /** 依次剥掉的 wrapper 名（目前只有 Windows 的 `sudo`） */
  wrappers: string[]
  /** argv 是否整条静态可知 */
  complete: boolean
  /** 在**其所属源串**中的区间；depth>0 时相对于载荷串 */
  span: ShellSpan
  /** 0 = 原始命令，>0 = 由 `powershell -Command` / `cmd /c` / `Invoke-Expression` 载荷再解析而来 */
  depth: number
}

/** 一处重定向（`>` / `>>` / `2>` / `*>` / `3>&1` …） */
export interface PowerShellRedirect {
  kind: ShellRedirectKind
  /** 字面可知的目标；动态（`$null`、变量、子表达式）或 fd 复制时为 null */
  target: string | null
  span: ShellSpan
  depth: number
}

/** 未能完整读完的原因 */
export type PowerShellUnparsedReason = 'ok' | 'too-long' | 'syntax-error'

/** 一条 PowerShell 命令的结构事实 */
export interface PowerShellFacts {
  source: string
  /**
   * 整条命令读完且没有遇到结构错误（未闭合的引号 / 括号 / here-string、多余的闭括号）。
   * 为 false 时 commands / redirects 只含错误之前读到的部分 —— PowerShell 本身遇到语法错误
   * 就一行都不执行，所以这些是「若能执行会执行的」，不是全集。
   */
  parsed: boolean
  reason: PowerShellUnparsedReason
  /** 第一处结构错误的位置；parsed 时为 null */
  errorAt: number | null
  commands: PowerShellCommand[]
  redirects: PowerShellRedirect[]
  /**
   * 嵌套的 bash 载荷（`bash -c '…'` / `sh -c '…'`），由宿主注入的 bash 解析器读出；
   * depth 是载荷所在的层（外层命令 depth + 1）。宿主没注入解析器时为空。
   */
  nestedBash: { facts: ShellFacts; depth: number }[]
  /** 递归载荷时触到深度上限而仍有载荷未读 */
  depthExceeded: boolean
}

export interface PowerShellAnalyzeOptions {
  /** 读嵌套 `bash -c` 载荷用的 bash 解析器（宿主注入的那一个）；缺省则这类载荷不展开 */
  analyzeBash?: (source: string) => ShellFacts
}
