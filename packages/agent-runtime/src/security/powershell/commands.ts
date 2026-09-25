/**
 * PowerShell 命令名的规范化与 wrapper 解包。
 *
 * 规范化的目的是让策略按「真正会跑的那个命令」写，而不必枚举同一个命令的每种写法：
 * `rm` / `del` / `erase` / `rd` / `ri` / `rmdir` / `Microsoft.PowerShell.Management\Remove-Item`
 * 都读成 `Remove-Item`，`C:\Windows\System32\format.com` 读成 `format`。
 */

/**
 * PowerShell 的默认别名（Windows PowerShell 5.1 与 PowerShell 7 在 Windows 上都有的那一批，
 * 小写键）。只收文件、进程、执行相关的 —— 规则关心的是这几类，全表两百多条多半用不上。
 *
 * 刻意不收的：`sc`（5.1 是 Set-Content，7 里是 sc.exe 服务控制）、`curl` / `wget`
 * （5.1 是 Invoke-WebRequest，7 里是真正的 curl.exe）—— 版本间含义不同的别名一律按字面。
 * `md` / `mkdir` 是函数不是别名，也按字面。
 */
export const POWERSHELL_ALIASES: Readonly<Record<string, string>> = {
  '%': 'ForEach-Object',
  '?': 'Where-Object',
  ac: 'Add-Content',
  cat: 'Get-Content',
  cd: 'Set-Location',
  chdir: 'Set-Location',
  clc: 'Clear-Content',
  cli: 'Clear-Item',
  clp: 'Clear-ItemProperty',
  copy: 'Copy-Item',
  cp: 'Copy-Item',
  cpi: 'Copy-Item',
  cpp: 'Copy-ItemProperty',
  del: 'Remove-Item',
  dir: 'Get-ChildItem',
  echo: 'Write-Output',
  erase: 'Remove-Item',
  foreach: 'ForEach-Object',
  gc: 'Get-Content',
  gci: 'Get-ChildItem',
  gi: 'Get-Item',
  icm: 'Invoke-Command',
  iex: 'Invoke-Expression',
  ii: 'Invoke-Item',
  irm: 'Invoke-RestMethod',
  iwr: 'Invoke-WebRequest',
  kill: 'Stop-Process',
  ls: 'Get-ChildItem',
  mi: 'Move-Item',
  move: 'Move-Item',
  mv: 'Move-Item',
  ni: 'New-Item',
  rd: 'Remove-Item',
  ren: 'Rename-Item',
  ri: 'Remove-Item',
  rm: 'Remove-Item',
  rmdir: 'Remove-Item',
  rni: 'Rename-Item',
  rp: 'Remove-ItemProperty',
  sajb: 'Start-Job',
  saps: 'Start-Process',
  si: 'Set-Item',
  sl: 'Set-Location',
  sp: 'Set-ItemProperty',
  spps: 'Stop-Process',
  start: 'Start-Process',
  type: 'Get-Content',
  where: 'Where-Object',
  write: 'Write-Output'
}

/** 可执行文件扩展名 —— 带不带都是同一个程序（`format` 与 `format.com`） */
const EXECUTABLE_EXT = /\.(exe|com)$/i

/**
 * 命令名的末段：去掉路径 / 模块限定前缀（`C:\Windows\System32\format.com`、
 * `Microsoft.PowerShell.Management\Remove-Item`）与 `.exe` / `.com` 扩展名。不解析别名 ——
 * cmd.exe 载荷里的命令名用它（cmd 没有 PowerShell 的别名）。
 */
export function commandLeaf(name: string): string {
  const lastSep = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return name.slice(lastSep + 1).replace(EXECUTABLE_EXT, '')
}

/**
 * 命令名 → 规范化的 base（见 PowerShellCommand.base）：commandLeaf + 默认别名解析。
 *
 * 别名只在**裸名**上解析：`.\rm.exe`、`C:\tools\rm` 是某个文件，不是 Remove-Item。
 */
export function powerShellCommandBase(name: string): string {
  // PowerShell 把 en dash / em dash / horizontal bar 当作 `-`：`Remove–Item` 就是 Remove-Item
  const bare = commandLeaf(name)
  const leaf = bare.replace(/[\u2013\u2014\u2015]/g, '-')
  if (bare === name) {
    const alias = POWERSHELL_ALIASES[leaf.toLowerCase()]
    if (alias) return alias
  }
  return leaf
}

/** Windows `sudo` 的选项里带值的那几个（其余是开关） */
const SUDO_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-d', '--chdir'])

/**
 * 剥掉透明 wrapper。目前只有 Windows 11 的 `sudo`（`sudo [选项] 命令 参数…`）——
 * 它以提权身份原样运行后面的命令，规则要看的是后面那一个。
 */
export function stripPowerShellWrappers(argv: (string | null)[]): {
  argv: (string | null)[]
  wrappers: string[]
} {
  const wrappers: string[] = []
  let rest = argv
  while (
    rest.length > 0 &&
    rest[0] !== null &&
    powerShellCommandBase(rest[0]).toLowerCase() === 'sudo'
  ) {
    wrappers.push('sudo')
    let k = 1
    while (k < rest.length) {
      const a = rest[k]
      if (a === null || !a.startsWith('-')) break
      k++
      if (a === '--') break
      if (SUDO_VALUE_OPTIONS.has(a.toLowerCase())) k++
    }
    rest = rest.slice(k)
  }
  return { argv: rest, wrappers }
}
