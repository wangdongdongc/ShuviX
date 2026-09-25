/**
 * `shuvix` CLI 的三个 shim（resources/cli）—— 命令工具起的 shell 里 `shuvix …` 就是它们。Windows 上
 * 的命令工具换成了 PowerShell，于是多了 `shuvix.ps1`：PowerShell 会先于同目录的 `shuvix.cmd` 解析到它，
 * 参数不经 cmd.exe（cmd 会在第一个换行处截断多行参数、重新解释 & | ^ %）。
 *
 * 这里没有 PowerShell 可跑（CI 的 macOS / Linux 上也没有），所以钉的是文件的**形状**：
 *
 *   H1a 纯可打印 ASCII（+ \t \n \r）、没有 BOM —— 5.1 按系统代码页读无 BOM 的文件，一个非 ASCII 字符
 *       就可能把整行读坏；
 *   H1b 缺 SHUVIX_ELECTRON / SHUVIX_CLI_JS：往 stderr 说一声并 `exit 2`（与另两个 shim 同一个退出码）；
 *   H1c 脚本跑在调用方的 PowerShell 进程里，它改的环境会漏进调用方命令的其余部分 —— 每个被赋值的
 *       `$env:NAME` 都得在 `$saved` 里存过、并在 `finally` 里还原（集合从文件里现抽，不手抄）；
 *   H1d 以 `& $env:SHUVIX_ELECTRON $env:SHUVIX_CLI_JS @args` 调用、ELECTRON_RUN_AS_NODE 设为 '1'、
 *       退出码取自 $LASTEXITCODE；
 *   H1e 三个 shim 设的是同一组变量；electron-builder 仍把整个 resources/cli 目录带进安装包。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DESKTOP_ROOT = resolve(__dirname, '../../../..')
const CLI_DIR = join(DESKTOP_ROOT, 'resources/cli')
const PS1 = join(CLI_DIR, 'shuvix.ps1')

const read = (path: string): string => readFileSync(path, 'utf-8')

/** 去掉 `#` 注释行（PowerShell 的行注释），只看代码 */
const codeLines = (text: string): string[] =>
  text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line))

describe('shuvix.ps1', () => {
  it('H1a — 文件存在，全是可打印 ASCII（外加 \\t \\n \\r），没有 BOM', () => {
    expect(existsSync(PS1)).toBe(true)
    const bytes = readFileSync(PS1)
    expect(bytes.length).toBeGreaterThan(0)
    // UTF-8 BOM = EF BB BF
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])
    const bad = [...bytes]
      .map((byte, index) => ({ byte, index }))
      .filter(
        ({ byte }) =>
          !(byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e))
      )
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('H1b — 缺 SHUVIX_ELECTRON 或 SHUVIX_CLI_JS：往 stderr 写、exit 2', () => {
    const code = codeLines(read(PS1)).join('\n')
    const guard =
      /if\s*\(\s*-not\s+\$env:SHUVIX_ELECTRON\s+-or\s+-not\s+\$env:SHUVIX_CLI_JS\s*\)\s*\{([\s\S]*?)\n\}/.exec(
        code
      )
    expect(guard, '应有「两个变量缺一个就退出」的守卫').not.toBeNull()
    const body = guard![1]
    expect(body).toMatch(/\[Console\]::Error\.WriteLine\(/)
    expect(body).toMatch(/\bexit 2\b/)
    // 守卫在调用之前
    expect(code.indexOf(guard![0])).toBeLessThan(code.indexOf('& $env:SHUVIX_ELECTRON'))
  })

  it('H1c — 每个被赋值的 $env:NAME 都在 $saved 里存过，并在 finally 里逐个还原', () => {
    const code = codeLines(read(PS1)).join('\n')

    // 被赋值的环境变量：`$env:NAME =`（排除 `==` 比较；PowerShell 的比较是 -eq，这里只防手滑）
    const assigned = new Set([...code.matchAll(/\$env:(\w+)\s*=(?!=)/g)].map((m) => m[1]))
    expect(assigned.size, '自检：脚本确实改了环境').toBeGreaterThanOrEqual(3)

    const savedBlock = /\$saved\s*=\s*@\{([\s\S]*?)\}/.exec(code)
    expect(savedBlock, '应有 $saved = @{ … }').not.toBeNull()
    const savedKeys = new Map(
      [...savedBlock![1].matchAll(/^\s*(\w+)\s*=\s*(\S+)\s*$/gm)].map((m) => [m[1], m[2]])
    )
    for (const name of assigned) {
      expect(savedKeys.has(name), `$env:${name} 被改了却没存`).toBe(true)
      // 存的是它自己改之前的值
      expect(savedKeys.get(name), name).toBe(`$env:${name}`)
    }

    // 存在 $saved 之后、调用之前改；在 finally 里按 $saved 的键逐个还原
    const tryAt = code.search(/\btry\s*\{/)
    const finallyMatch = /\}\s*finally\s*\{([\s\S]*?)\n\}/.exec(code)
    expect(tryAt).toBeGreaterThan(code.indexOf('$saved'))
    expect(finallyMatch, '应有 finally 块').not.toBeNull()
    const restore = finallyMatch![1]
    expect(restore).toMatch(/foreach\s*\(\s*\$name\s+in\s+\$saved\.Keys\s*\)/)
    expect(restore).toMatch(
      /\[Environment\]::SetEnvironmentVariable\(\s*\$name\s*,\s*\$saved\[\$name\]\s*\)/
    )
    // 所有赋值都发生在 try 里（try 之前改就可能漏过 finally）
    for (const m of code.matchAll(/\$env:(\w+)\s*=(?!=)/g)) {
      expect(m.index!, `$env:${m[1]} 的赋值应在 try 之内`).toBeGreaterThan(tryAt)
      expect(m.index!, `$env:${m[1]} 的赋值应在 finally 之前`).toBeLessThan(finallyMatch!.index)
    }
  })

  it('H1d — 以 & $env:SHUVIX_ELECTRON $env:SHUVIX_CLI_JS @args 调用；ELECTRON_RUN_AS_NODE=1；退出码取自 $LASTEXITCODE', () => {
    const code = codeLines(read(PS1)).join('\n')
    expect(code).toContain('& $env:SHUVIX_ELECTRON $env:SHUVIX_CLI_JS @args')
    expect(code).toMatch(/\$env:ELECTRON_RUN_AS_NODE\s*=\s*'1'/)
    // 退出码：先接住 $LASTEXITCODE，finally 还原完环境再 exit 它
    const captured = /\$(\w+)\s*=\s*\$LASTEXITCODE/.exec(code)
    expect(captured, '应把 $LASTEXITCODE 存下来').not.toBeNull()
    const variable = captured![1]
    const exitLine = new RegExp(`^exit \\$${variable}\\s*$`, 'm').exec(code)
    expect(exitLine, `脚本末尾应 exit $${variable}`).not.toBeNull()
    expect(exitLine!.index).toBeGreaterThan(code.search(/\bfinally\b/))
    // 调用之后才读 $LASTEXITCODE
    expect(captured!.index).toBeGreaterThan(code.indexOf('& $env:SHUVIX_ELECTRON'))
  })
})

describe('三个 shim 一致', () => {
  it('H1e — POSIX shuvix 与 shuvix.cmd 同样设 ELECTRON_RUN_AS_NODE、把用户的 NODE_OPTIONS 挪进 SHUVIX_NODE_OPTIONS', () => {
    const posix = read(join(CLI_DIR, 'shuvix'))
    const cmd = read(join(CLI_DIR, 'shuvix.cmd'))
    const ps1 = read(PS1)

    expect(posix).toMatch(/ELECTRON_RUN_AS_NODE=1/)
    expect(posix).toMatch(/SHUVIX_NODE_OPTIONS="\$NODE_OPTIONS"/)
    expect(cmd).toMatch(/set "ELECTRON_RUN_AS_NODE=1"/)
    expect(cmd).toMatch(/set "SHUVIX_NODE_OPTIONS=%NODE_OPTIONS%"/)
    expect(ps1).toMatch(/\$env:SHUVIX_NODE_OPTIONS\s*=\s*\$env:NODE_OPTIONS/)

    // 缺变量时三者同一个退出码
    expect(posix).toMatch(/\bexit 2\b/)
    expect(cmd).toMatch(/exit \/b 2\b/)
    expect(ps1).toMatch(/\bexit 2\b/)
  })

  it('H1e — electron-builder 仍把 resources/cli 整个目录带进安装包（.ps1 不用单独登记）', () => {
    const yml = read(join(DESKTOP_ROOT, 'electron-builder.yml'))
    expect(yml).toMatch(/^\s*-\s*from:\s*resources\/cli\s*$/m)
  })
})
