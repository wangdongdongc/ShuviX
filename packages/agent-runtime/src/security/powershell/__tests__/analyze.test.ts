/**
 * PowerShell 扫描器（宽松轨）—— 「命令原文 → 结构事实」的直测，不经任何策略。
 *
 * 这一层只有一条承诺：**只许漏，不许造**。凭空读出一条命令会让 deny 误拦一条无害命令
 * （deny 不能为单条命令豁免），漏读则落回 ask-on-command。所以这里一半用例钉「读得到」，
 * 另一半钉「作为数据出现的同一段文字不被读成命令」—— 后一半与前一半同样重要。
 *
 * 约定：cmds 是 `[base, depth]` 列表。括号 / 代码块里的命令先于包着它的那条命令产出，
 * 所以除非用例特意钉顺序，一律按集合比较（expectCmds）。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  analyzePowerShellCommand,
  decodeBase64Utf16le,
  MAX_POWERSHELL_PAYLOAD_DEPTH,
  MAX_POWERSHELL_SOURCE_LENGTH
} from '../analyze'
import type { PowerShellAnalyzeOptions, PowerShellCommand } from '../types'
import type { ShellFacts } from '../../shell/types'

type Pair = [string, number]

function cmds(src: string, opts?: PowerShellAnalyzeOptions): Pair[] {
  return analyzePowerShellCommand(src, opts).commands.map((c): Pair => [c.base, c.depth])
}

/** 顺序无关的 `[base, depth]` 比较（src 带进断言，表驱动时红了知道是哪一条） */
function expectCmds(src: string, expected: Pair[], opts?: PowerShellAnalyzeOptions): void {
  const sorted = (list: Pair[]): string[] => list.map((p) => JSON.stringify(p)).sort()
  expect({ src, cmds: sorted(cmds(src, opts)) }).toEqual({ src, cmds: sorted(expected) })
}

/** 第一条 base 为 name（且在 depth 层，若给了）的命令；找不到让用例红在这里 */
function commandNamed(src: string, base: string, depth?: number): PowerShellCommand {
  const found = analyzePowerShellCommand(src).commands.find(
    (c) => c.base === base && (depth === undefined || c.depth === depth)
  )
  expect(found, `${JSON.stringify(src)} 里应有 ${base}`).toBeDefined()
  return found as PowerShellCommand
}

const argvOf = (src: string, base: string): (string | null)[] => commandNamed(src, base).argv

const bases = (src: string): string[] => analyzePowerShellCommand(src).commands.map((c) => c.base)

function redirectsOf(src: string): [string, string | null, number][] {
  return analyzePowerShellCommand(src).redirects.map((r): [string, string | null, number] => [
    r.kind,
    r.target,
    r.depth
  ])
}

/** `-EncodedCommand` 的编码：UTF-16LE 再 base64 */
const encode = (s: string): string => Buffer.from(s, 'utf16le').toString('base64')

/** 嵌套 bash 解析器的替身：返回一份什么都没读到的事实 —— 这里只关心它被怎样调用 */
function bashFacts(source: string): ShellFacts {
  return {
    source,
    parsed: true,
    reason: 'ok',
    errorSpans: [],
    wordOnly: false,
    wordOnlyCommands: [],
    literalCommands: [],
    dynamics: [],
    redirects: [],
    depthExceeded: false
  }
}

// ─── 语句结构 ────────────────────────────────────────────────

describe('PowerShell 扫描器 — 语句结构', () => {
  it('PSA-1 分隔符：; / 换行 / CRLF / | / && / || / 后台 & 都切出两条 depth 0 命令', () => {
    for (const src of ['a; b', 'a\nb', 'a\r\nb', 'a | b', 'a && b', 'a || b', 'a & b']) {
      const facts = analyzePowerShellCommand(src)
      expect({ src, parsed: facts.parsed }).toEqual({ src, parsed: true })
      expectCmds(src, [
        ['a', 0],
        ['b', 0]
      ])
    }
    // 结尾的 `&` 是后台作业，不是一条空命令
    expect(cmds('a &')).toEqual([['a', 0]])
  })

  it('PSA-2 续行：行尾反引号、行尾 | / && / || 之后的换行不断句', () => {
    for (const src of ['Remove-Item C:\\ `\n-Recurse', 'Remove-Item C:\\ `\r\n-Recurse']) {
      const facts = analyzePowerShellCommand(src)
      expect(facts.commands).toHaveLength(1)
      expect({ src, argv: facts.commands[0].argv }).toEqual({
        src,
        argv: ['Remove-Item', 'C:\\', '-Recurse']
      })
    }
    for (const src of ['Get-ChildItem |\n  Remove-Item x', 'a &&\n b', 'a ||\n b']) {
      expect({ src, n: analyzePowerShellCommand(src).commands.length }).toEqual({ src, n: 2 })
    }
  })

  it('PSA-2b 反引号 + 空格 + 换行不是续行：-Recurse 留在下一行、不属于这条命令', () => {
    // PowerShell 的续行要求反引号**紧贴**换行；中间隔一个空格，反引号转义的是那个空格，
    // 换行照常断句，下一行的 `-Recurse` 是一条以 `-` 开头的表达式
    const facts = analyzePowerShellCommand('Remove-Item C:\\ ` \n-Recurse')
    for (const c of facts.commands) {
      expect(c.argv).not.toContain('-Recurse')
      expect(c.name).not.toBe('-Recurse')
    }
    expect(bases('Remove-Item C:\\ ` \n-Recurse')).toEqual(['Remove-Item'])
  })

  it('PSA-3 调用运算符与点源：& / . 之后的名字才是命令', () => {
    const exe = commandNamed("& 'C:\\Tools\\x.exe' a", 'x')
    expect(exe.argv).toEqual(['C:\\Tools\\x.exe', 'a'])
    expect(bases('&"format" C:')).toEqual(['format'])
    expect(bases('. .\\setup.ps1 -Force')).toEqual(['setup.ps1'])
    // `& { … }` / `. { … }`：运行的是块里的命令，外面不再多出一条
    expect(cmds('& { Clear-Disk 0 }')).toEqual([['Clear-Disk', 0]])
    expect(cmds('. { Format-Volume }')).toEqual([['Format-Volume', 0]])
    // 引号里的整串是**一个**命令名（一个找不到的程序），不是一条 Remove-Item
    expect(bases("& 'Remove-Item C:\\ -Recurse'")).not.toContain('Remove-Item')
  })

  it('PSA-4 语句开头是表达式 → 不是命令调用', () => {
    // `'C:\x.exe' arg` 在 PowerShell 里只是输出一个字符串，要 `&` 才会运行
    for (const src of [
      "'C:\\x.exe' arg",
      '"format" C:',
      '(1)',
      '$x.Name',
      '1..3',
      '0x10',
      '1kb',
      "[IO.File]::Delete('C:\\x')",
      '-not $true',
      '!$x',
      '@(1,2)',
      '+1'
    ]) {
      expect({ src, cmds: cmds(src) }).toEqual({ src, cmds: [] })
    }
    // 数字后面紧跟单词字符就不是数字字面量：7z 是命令名
    expect(cmds('7z x a.zip')).toEqual([['7z', 0]])
    expect(cmds('7z.exe l a.zip')).toEqual([['7z', 0]])
    // 表达式开头的管道，后面的元素照样是命令
    expectCmds('1..3 | % { rm $_ }', [
      ['ForEach-Object', 0],
      ['Remove-Item', 0]
    ])
  })

  it('PSA-5 赋值的右边是一条独立的语句：会运行，照读', () => {
    expectCmds('$r = Remove-Item x', [['Remove-Item', 0]])
    expectCmds('$n += Get-Item x', [['Get-Item', 0]])
    expectCmds('[int]$x = Get-Random', [['Get-Random', 0]])
    expectCmds('$a ??= Get-Item x', [['Get-Item', 0]])
    expectCmds('$null = Remove-Item x', [['Remove-Item', 0]])
    // 右边是字符串就只是字符串
    expect(cmds("$s = 'Remove-Item x'")).toEqual([])
  })

  it('PSA-6 容器里的命令是真命令：括号 / 子表达式 / 代码块 / 控制流 / 哈希表的值', () => {
    for (const src of [
      '(Get-Item x)',
      '$(Get-Item x)',
      '@(Get-Item x)',
      'Invoke-Command { Get-Item x }',
      'if ($a) { Get-Item x } elseif ($b) { Get-Item y } else { Get-Item z }',
      'foreach ($f in $l) { Get-Item x }',
      'try { Get-Item x } catch { Get-Item y } finally { Get-Item z }',
      "switch ($v) { 'a' { Get-Item x } }",
      '@{ k = Get-Item x; j = 2 }',
      '@{\n  k = Get-Item x\n  j = 2\n}'
    ]) {
      expect({ src, cmds: cmds(src) }).toEqual({
        src,
        cmds: expect.arrayContaining([['Get-Item', 0]])
      })
    }
    // 嵌在参数里的这些构造让那个参数变成动态（null），里面的命令照样读出来
    const src = 'Write-Output (1..3) @(Get-Item x) $(Get-Date)'
    const write = commandNamed(src, 'Write-Output')
    expect(write.argv).toEqual(['Write-Output', null, null, null])
    expect(write.complete).toBe(false)
    expectCmds(src, [
      ['Write-Output', 0],
      ['Get-Item', 0],
      ['Get-Date', 0]
    ])
  })

  it('PSA-7 关键字只在管道第一段的命令位置上生效', () => {
    // 管道后段的 foreach 是 ForEach-Object 的别名，不是 foreach 语句
    const each = analyzePowerShellCommand('gci | foreach { rm $_ }').commands.find(
      (c) => c.argv[0] === 'foreach'
    )
    expect(each?.base).toBe('ForEach-Object')
    // 参数位置上的 if / foreach 只是字
    const write = analyzePowerShellCommand('Write-Output if foreach')
    expect(write.commands).toHaveLength(1)
    expect(write.commands[0].argv).toEqual(['Write-Output', 'if', 'foreach'])
    // 关键字不区分大小写
    expect(cmds('IF ($a) { Get-Item x }')).toEqual([['Get-Item', 0]])
    expect(cmds('return Remove-Item x')).toEqual([['Remove-Item', 0]])
    expect(cmds('throw (Get-Item x)')).toEqual([['Get-Item', 0]])
    expect(cmds(':outer while ($true) { Get-Item x }')).toEqual([['Get-Item', 0]])
    expect(cmds('function f { Clear-Disk 1 }')).toEqual([['Clear-Disk', 0]])
    // 关键字后面必须是分隔：do-something / data.exe / if.exe 都是命令
    expect(cmds('do-something x')).toEqual([['do-something', 0]])
    expect(cmds('data.exe --flag')).toEqual([['data', 0]])
    expect(cmds('if.exe /x')).toEqual([['if', 0]])
  })
})

// ─── 词法 ────────────────────────────────────────────────────

describe('PowerShell 扫描器 — 词法', () => {
  it("PSA-8 单引号：字面，'' 是引号本身，$( ) 不展开", () => {
    const src = "Write-Output 'it''s; Remove-Item C:\\ -r'"
    const facts = analyzePowerShellCommand(src)
    expect(facts.commands).toHaveLength(1)
    expect(facts.commands[0].argv[1]).toBe("it's; Remove-Item C:\\ -r")

    const literal = analyzePowerShellCommand("Write-Output '$(Remove-Item x)'")
    expect(literal.commands).toHaveLength(1)
    expect(literal.commands[0].argv[1]).toBe('$(Remove-Item x)')
    expect(literal.commands[0].complete).toBe(true)
  })

  it('PSA-9 双引号："" 与 `" 是引号本身；$( ) 展开且读出其中命令；变量让参数变动态', () => {
    expect(argvOf('Write-Output "a""b"', 'Write-Output')[1]).toBe('a"b')
    // 反引号转义掉的 $ 不再展开
    const escaped = analyzePowerShellCommand('Write-Output "`$(Remove-Item x)"')
    expect(escaped.commands.map((c) => c.base)).toEqual(['Write-Output'])
    expect(escaped.commands[0].argv[1]).toBe('$(Remove-Item x)')
    // 转义的引号不结束字符串：`;` 仍在串里
    const quoted = analyzePowerShellCommand('Write-Output "a`"; Remove-Item x"')
    expect(quoted.commands).toHaveLength(1)
    expect(quoted.commands[0].argv[1]).toBe('a"; Remove-Item x')
    // 双引号里的子表达式会运行
    const sub = 'Write-Output "$(Remove-Item x)"'
    expectCmds(sub, [
      ['Remove-Item', 0],
      ['Write-Output', 0]
    ])
    expect(argvOf(sub, 'Write-Output')).toEqual(['Write-Output', null])

    for (const src of [
      'Write-Output "$x"',
      'Write-Output "${C:\\x}"',
      'Write-Output $env:SystemDrive\\',
      'Write-Output @splat'
    ]) {
      expect({ src, argv: argvOf(src, 'Write-Output') }).toEqual({
        src,
        argv: ['Write-Output', null]
      })
    }
    // 孤立的 $ 不是变量
    expect(argvOf('Write-Output a$', 'Write-Output')).toEqual(['Write-Output', 'a$'])
  })

  it('PSA-10 反引号转义：`t / `u{…} / `n / `$，以及命令名里夹的反引号', () => {
    expect(argvOf('Write-Output a`tb `u{41} `n `$x', 'Write-Output')).toEqual([
      'Write-Output',
      'a\tb',
      'A',
      '\n',
      '$x'
    ])
    expect(bases('Re`m`ove-`Item x')).toEqual(['Remove-Item'])
  })

  it('PSA-11 here-string：只在行首的终止符处结束，不凭空造命令', () => {
    // 字面 here-string 的正文是数据
    expect(cmds("$s = @'\nRemove-Item x\n'@")).toEqual([])
    // 可展开 here-string 里的子表达式会运行
    expect(cmds('@"\n$(Clear-Disk 1)\n"@')).toEqual([['Clear-Disk', 0]])
    // 前面带空格的 '@ 不是终止符：Format-Volume 那一行仍在正文里
    const leading = analyzePowerShellCommand("$s = @'\nx\n '@\nFormat-Volume\n'@")
    expect(leading.parsed).toBe(true)
    expect(leading.commands).toEqual([])
    // CRLF
    expect(cmds("$s = @'\r\nRemove-Item x\r\n'@\r\nGet-Item y")).toEqual([['Get-Item', 0]])
    expect(cmds('@"\r\n$(Clear-Disk 1)\r\n"@')).toEqual([['Clear-Disk', 0]])
    // 同一行的 @'x'@ 不是 here-string；不抛、不造命令
    expect(() => analyzePowerShellCommand("@'x'@")).not.toThrow()
    expect(cmds("@'x'@")).toEqual([])
  })

  it('PSA-12 注释：# 到行尾、<# … #>；词中的 # 不是注释', () => {
    const line = analyzePowerShellCommand('Write-Output a # ; Format-Volume')
    expect(line.commands).toHaveLength(1)
    expect(line.commands[0].argv).toEqual(['Write-Output', 'a'])

    expect(argvOf('Write-Output a <# ; Format-Volume #> b', 'Write-Output')).toEqual([
      'Write-Output',
      'a',
      'b'
    ])
    expect(bases('Write-Output a <# ; Format-Volume #> b')).toEqual(['Write-Output'])
    expect(cmds('<# line1\nFormat-Volume\n#>')).toEqual([])

    const glued = 'Write-Output a#b; Format-Volume'
    expect(argvOf(glued, 'Write-Output')).toEqual(['Write-Output', 'a#b'])
    expectCmds(glued, [
      ['Write-Output', 0],
      ['Format-Volume', 0]
    ])
  })

  it('PSA-13 弯引号当引号、en/em dash 与 horizontal bar 当连字符', () => {
    // „a“ “b” ‚c‛ ‘d’
    expect(
      argvOf('Write-Output \u201Ea\u201C \u201Cb\u201D \u201Ac\u201B \u2018d\u2019', 'Write-Output')
    ).toEqual(['Write-Output', 'a', 'b', 'c', 'd'])
    // 直引号与弯引号混配
    expect(argvOf('Write-Output \u201Ca" \'b\u2019', 'Write-Output')).toEqual([
      'Write-Output',
      'a',
      'b'
    ])
    // Remove–Item ‘C:\’ —Recurse
    const src = 'Remove\u2013Item \u2018C:\\\u2019 \u2014Recurse'
    const c = commandNamed(src, 'Remove-Item')
    // argv[0] 保留原样（字面值），base 才是规范名；参数名里的 dash 归一成 ASCII
    expect(c.argv).toEqual(['Remove\u2013Item', 'C:\\', '-Recurse'])
    expect(bases('Clear\u2015Disk 1')).toEqual(['Clear-Disk'])
  })

  it('PSA-14 -Name:value 拆两项；开关的冒号值只认几个常量', () => {
    expect(argvOf('Get-ChildItem -Path:C:\\Windows -Filter:*.log', 'Get-ChildItem')).toEqual([
      'Get-ChildItem',
      '-Path',
      'C:\\Windows',
      '-Filter',
      '*.log'
    ])
    expect(argvOf("Get-Item -Path:'C:\\a b'", 'Get-Item')).toEqual(['Get-Item', '-Path', 'C:\\a b'])
    expect(argvOf('Get-Item -Path:$p', 'Get-Item')).toEqual(['Get-Item', '-Path', null])

    // $true 读成打开：只留参数名
    for (const v of ['$true', '$TRUE']) {
      expect(argvOf(`Remove-Item x -Recurse:${v}`, 'Remove-Item')).toEqual([
        'Remove-Item',
        'x',
        '-Recurse'
      ])
    }
    // 关：原样留成一项，绝不能被读成 -Recurse
    for (const v of ['$false', '$False', '$null', '0']) {
      expect(argvOf(`Remove-Item x -Recurse:${v}`, 'Remove-Item')).toEqual([
        'Remove-Item',
        'x',
        `-Recurse:${v}`
      ])
    }
    // 冒号后隔空白同样是这个开关的值
    const spaced = argvOf('Remove-Item x -Recurse: $false', 'Remove-Item')
    expect(spaced).toEqual(['Remove-Item', 'x', '-Recurse:$false'])
    expect(spaced).not.toContain(':')
  })

  it('PSA-14b （修过的 SB-1）冒号值是代码块：照常解析，块里的命令读出来，参数值为 null', () => {
    const each = '1 | ForEach-Object -Process:{ Remove-Item C:\\ -Recurse }'
    const eachFacts = analyzePowerShellCommand(each)
    expect(eachFacts.parsed).toBe(true)
    expect(commandNamed(each, 'Remove-Item').argv).toEqual(['Remove-Item', 'C:\\', '-Recurse'])
    expect(argvOf(each, 'ForEach-Object')).toEqual(['ForEach-Object', '-Process', null])

    const icm = 'Invoke-Command -ScriptBlock:{ Format-Volume -DriveLetter D }'
    expect(analyzePowerShellCommand(icm).parsed).toBe(true)
    expect(commandNamed(icm, 'Format-Volume').argv).toEqual(['Format-Volume', '-DriveLetter', 'D'])
    expect(argvOf(icm, 'Invoke-Command')).toEqual(['Invoke-Command', '-ScriptBlock', null])

    const loc = 'Get-Item -Path:(Get-Location)'
    expect(argvOf(loc, 'Get-Item')).toEqual(['Get-Item', '-Path', null])
    expectCmds(loc, [
      ['Get-Item', 0],
      ['Get-Location', 0]
    ])
    expect(argvOf('Get-Item -Path:@(1,2)', 'Get-Item')).toEqual(['Get-Item', '-Path', null])
  })

  it('PSA-15 --%：之后到行尾或 | 原样交给原生程序', () => {
    const src = 'cmd --% /c rd /s /q %SystemDrive%\\ | Get-Item x'
    expect(commandNamed(src, 'cmd', 0).argv).toEqual(['cmd', '/c', 'rd', '/s', '/q', null])
    expect(cmds(src)).toContainEqual(['Get-Item', 0])
    // `;` 在 --% 之后只是字
    expect(bases('Write-Output --% ; Format-Volume')).not.toContain('Format-Volume')
    // 按 Windows 命令行规则切：引号里的空白不切开，引号本身去掉 —— 原生程序看到的是一个参数
    expect(argvOf('app --% "a b" c', 'app')).toEqual(['app', 'a b', 'c'])
  })

  // --% 之后的引号在 cmd.exe 看来仍是引号：`cmd /c echo "a & format C:"` 只是 echo 一个字符串
  // （不经 --% 的同一写法见 PSA-24c）。引号里的那一段按一个参数记，拼回给 cmd 时引号还回去，
  // 所以读不出 `format C:` —— 读出来就是过拦：deny 不能为单条命令豁免
  it('PSA-15b cmd --% /c echo "a & format C:" 不读出 format', () => {
    expect(bases('cmd --% /c echo "a & format C:"')).not.toContain('format')
    expect(commandNamed('cmd --% /c echo "a & format C:"', 'echo', 1).argv).toEqual([
      'echo',
      'a & format C:'
    ])
  })

  it('PSA-16 数组参数：逗号分开的各元素分开记', () => {
    expect(argvOf('Remove-Item a,C:\\ -r', 'Remove-Item')).toEqual([
      'Remove-Item',
      'a',
      'C:\\',
      '-r'
    ])
    expect(argvOf('Get-Item a, b ,c', 'Get-Item')).toEqual(['Get-Item', 'a', 'b', 'c'])
  })
})

// ─── 命令名 ──────────────────────────────────────────────────

describe('PowerShell 扫描器 — 命令名', () => {
  it('PSA-17 规范化：去路径 / 模块限定 / .exe .com，大小写不动', () => {
    expect(bases('C:\\Windows\\System32\\format.com D:')).toEqual(['format'])
    expect(bases('FORMAT.EXE D:')).toEqual(['FORMAT'])
    expect(bases('Microsoft.PowerShell.Management\\Remove-Item x')).toEqual(['Remove-Item'])
    expect(bases('Storage\\Format-Volume')).toEqual(['Format-Volume'])
    const raw = analyzePowerShellCommand('name').commands[0]
    expect([raw.name, raw.base]).toEqual(['name', 'name'])
  })

  it('PSA-18 默认别名只在裸名上解析；版本间含义不同的别名按字面', () => {
    for (const alias of ['rm', 'del', 'erase', 'rd', 'ri', 'rmdir', 'RM', 'Del']) {
      expect({ alias, bases: bases(`${alias} x`) }).toEqual({ alias, bases: ['Remove-Item'] })
    }
    for (const [alias, cmdlet] of [
      ['iex', 'Invoke-Expression'],
      ['IEX', 'Invoke-Expression'],
      ['echo', 'Write-Output'],
      ['%', 'ForEach-Object'],
      ['?', 'Where-Object']
    ]) {
      expect({ alias, base: bases(`${alias} x`)[0] }).toEqual({ alias, base: cmdlet })
    }
    // 带路径 / 扩展名的是某个文件，不是 Remove-Item
    for (const src of ['.\\rm.exe x', 'rm.exe x', 'C:\\tools\\rm x']) {
      expect({ src, bases: bases(src) }).toEqual({ src, bases: ['rm'] })
    }
    for (const name of ['curl', 'wget', 'sc', 'mkdir']) {
      expect({ name, bases: bases(`${name} x`) }).toEqual({ name, bases: [name] })
    }
  })

  it('PSA-19 sudo：剥掉并记下，选项（含带值的 -D）一并跳过；只有 sudo 一个词时按字面', () => {
    const plain = commandNamed('sudo Remove-Item x', 'Remove-Item')
    expect([plain.argv, plain.wrappers]).toEqual([['Remove-Item', 'x'], ['sudo']])

    const inline = commandNamed('sudo --inline rm x', 'Remove-Item')
    expect([inline.argv, inline.wrappers]).toEqual([['rm', 'x'], ['sudo']])

    const chdir = commandNamed('sudo -D C:\\ rm x', 'Remove-Item')
    expect([chdir.argv, chdir.wrappers]).toEqual([['rm', 'x'], ['sudo']])

    const exe = commandNamed('sudo.exe rm x', 'Remove-Item')
    expect(exe.wrappers).toEqual(['sudo'])

    const bare = analyzePowerShellCommand('sudo').commands
    expect(bare).toHaveLength(1)
    expect([bare[0].argv, bare[0].wrappers]).toEqual([['sudo'], []])
  })
})

// ─── 重定向 ──────────────────────────────────────────────────

describe('PowerShell 扫描器 — 重定向', () => {
  it('PSA-20 种类与目标', () => {
    expect(redirectsOf('Write-Output x > f')).toEqual([['write', 'f', 0]])
    expect(redirectsOf('Write-Output x >> f')).toEqual([['append', 'f', 0]])
    expect(redirectsOf('Write-Output x 2> f')).toEqual([['write', 'f', 0]])
    expect(redirectsOf('Write-Output x *> f')).toEqual([['write', 'f', 0]])
    expect(redirectsOf('Write-Output x *>> f')).toEqual([['append', 'f', 0]])
    for (const op of ['2>&1', '3>&1', '*>&1']) {
      expect({ op, r: redirectsOf(`Write-Output x ${op}`) }).toEqual({
        op,
        r: [['fd-dup', null, 0]]
      })
    }
    // 目标动态：记成写、目标 null（投影层会把它过滤掉）
    for (const src of [
      'Write-Output x > $null',
      'Write-Output x 2> $null',
      'Write-Output x > $env:TEMP\\x'
    ]) {
      expect({ src, r: redirectsOf(src) }).toEqual({ src, r: [['write', null, 0]] })
    }
    expect(redirectsOf("Write-Output x > 'a b.txt'")).toEqual([['write', 'a b.txt', 0]])
    // 贴着写：`x>y` 是参数 x 加一个写到 y 的重定向
    expect(argvOf('Write-Output x>y', 'Write-Output')).toEqual(['Write-Output', 'x'])
    expect(redirectsOf('Write-Output x>y')).toEqual([['write', 'y', 0]])
    // 表达式语句上的重定向同样记下
    expect(redirectsOf('5 > five.txt')).toEqual([['write', 'five.txt', 0]])
  })

  it('PSA-20b （修过的 SB-10）重定向写在命令名前面：命令照读，重定向照记', () => {
    const src = '> out.txt Remove-Item C:\\ -Recurse'
    const facts = analyzePowerShellCommand(src)
    expect(facts.commands.map((c) => [c.base, c.argv])).toEqual([
      ['Remove-Item', ['Remove-Item', 'C:\\', '-Recurse']]
    ])
    expect(redirectsOf(src)).toEqual([['write', 'out.txt', 0]])
  })

  it('PSA-21 缺目标、或目标是保留的 < → 结构错误', () => {
    for (const src of ['Write-Output x >', 'Write-Output x > <']) {
      expect({ src, parsed: analyzePowerShellCommand(src).parsed }).toEqual({
        src,
        parsed: false
      })
    }
  })
})

// ─── 嵌套载荷 ────────────────────────────────────────────────

describe('PowerShell 扫描器 — 嵌套载荷', () => {
  it('PSA-22 powershell / pwsh 的 -Command（以及 5.1 的第一个位置参数）', () => {
    for (const src of [
      'powershell -c "Format-Volume -DriveLetter D"',
      'powershell -Command Format-Volume -DriveLetter D',
      'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Format-Volume -DriveLetter D"',
      'powershell.exe -NoP -w hidden Format-Volume',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -c Format-Volume',
      'pwsh -c Format-Volume',
      'powershell -Command "& {Format-Volume}"',
      'powershell -Command:"Format-Volume"'
    ]) {
      expect({ src, cmds: cmds(src) }).toEqual({
        src,
        cmds: expect.arrayContaining([['Format-Volume', 1]])
      })
    }
    // 读不到的：pwsh 的第一个位置参数是脚本文件；-File 之后都是给脚本的参数；-c - 从 stdin 读
    for (const src of [
      'pwsh Format-Volume',
      'pwsh -File x.ps1 -Command Format-Volume',
      'powershell -c -'
    ]) {
      const deep = analyzePowerShellCommand(src).commands.filter((c) => c.depth > 0)
      expect({ src, deep }).toEqual({ src, deep: [] })
    }
  })

  it('PSA-23 -EncodedCommand（及其缩写）解码再读；不是合法 base64 就不读、不抛', () => {
    const padded = encode('Format-Volume -DriveLetter D')
    expect(padded.endsWith('=')).toBe(true)
    const unpadded = padded.replace(/=+$/, '')
    for (const [cli, flag] of [
      ['powershell', '-EncodedCommand'],
      ['powershell', '-enc'],
      ['powershell', '-e'],
      ['powershell', '-ec'],
      ['pwsh', '-ec']
    ]) {
      for (const payload of [padded, unpadded]) {
        const src = `${cli} ${flag} ${payload}`
        expect({ src, cmd: commandNamed(src, 'Format-Volume', 1).argv }).toEqual({
          src,
          cmd: ['Format-Volume', '-DriveLetter', 'D']
        })
      }
    }
    // 长度 ≡ 1 (mod 4) 不可能是 base64；带非法字符的也不是
    for (const bad of ['not!base64', 'AAAAA']) {
      const src = `powershell -enc ${bad}`
      expect(() => analyzePowerShellCommand(src)).not.toThrow()
      expect({ src, cmds: cmds(src) }).toEqual({ src, cmds: [['powershell', 0]] })
    }
  })

  it('PSA-23b decodeBase64Utf16le 直测：非 ASCII 往返、空白、奇数尾字节、非法输入', () => {
    expect(decodeBase64Utf16le(encode('删除 C:\\'))).toBe('删除 C:\\')
    // 空白（含换行）被忽略
    const spaced = encode('ab').replace(/^(.{2})/, ' $1 \n')
    expect(decodeBase64Utf16le(spaced)).toBe('ab')
    // 'YQBi' = 0x61 0x00 0x62：凑不成 UTF-16 码元的尾字节丢掉
    expect(decodeBase64Utf16le('YQBi')).toBe('a')
    for (const bad of ['', '====', 'not!base64', 'AAAAA']) {
      expect({ bad, out: decodeBase64Utf16le(bad) }).toEqual({ bad, out: null })
    }
  })

  it('PSA-24 cmd /c：按 cmd.exe 的规则切，命令记在 depth 1、shell 为 cmd', () => {
    const chain = 'cmd /c "format C: /q && echo ok || rd /s /q x"'
    expectCmds(chain, [
      ['cmd', 0],
      ['format', 1],
      ['echo', 1],
      ['rd', 1]
    ])
    for (const c of analyzePowerShellCommand(chain).commands.filter((c) => c.depth === 1)) {
      expect(c.shell).toBe('cmd')
    }
    for (const src of [
      'cmd /cformat D:',
      'cmd /s /q /c format D:',
      'cmd /k format D:',
      'cmd /r format D:',
      'cmd /C format D:'
    ]) {
      expect({ src, argv: commandNamed(src, 'format', 1).argv }).toEqual({
        src,
        argv: ['format', 'D:']
      })
    }
    // ^ 转义与 @ 前缀都不改变命令名
    expect(commandNamed('cmd /c "f^ormat C:"', 'format', 1).argv).toEqual(['format', 'C:'])
    expect(commandNamed('cmd /c "@format C:"', 'format', 1).argv).toEqual(['format', 'C:'])
    // if / else 之后的括号块
    expectCmds('cmd /c "if exist x (rd /s /q y)"', [
      ['cmd', 0],
      ['if', 1],
      ['rd', 1]
    ])
    expectCmds('cmd /c "if exist x (rd /s /q y) else (format C:)"', [
      ['cmd', 0],
      ['if', 1],
      ['rd', 1],
      ['else', 1],
      ['format', 1]
    ])
    // cmd 没有 PowerShell 的别名：rd 就是 rd
    expect(commandNamed('cmd /c "rd /s /q C:\\"', 'rd', 1).argv).toEqual(['rd', '/s', '/q', 'C:\\'])
    // ^& 是字符
    expectCmds('cmd /c "echo ^& format C:"', [
      ['cmd', 0],
      ['echo', 1]
    ])
    expect(commandNamed('cmd /c "format %SystemDrive%"', 'format', 1).argv).toEqual([
      'format',
      null
    ])
  })

  it('PSA-24b cmd /c 里的重定向：写与 fd 复制记在 depth 1，读方向不记', () => {
    const src = 'cmd /c "echo x > C:\\o.txt 2>&1 & type < in.txt"'
    expect(redirectsOf(src)).toEqual([
      ['write', 'C:\\o.txt', 1],
      ['fd-dup', null, 1]
    ])
  })

  it('PSA-24c （修过的 SB-3 / SB-4）引号里的 & 与普通字符位置上的括号不造命令', () => {
    // SB-3：PowerShell 把含空白的参数加引号交给 cmd，引号里的 & 只是字符
    const echo = 'cmd /c echo "a & format C:"'
    expectCmds(echo, [
      ['cmd', 0],
      ['echo', 1]
    ])
    expect(commandNamed(echo, 'echo', 1).argv[1]).toBe('a & format C:')
    // SB-4：命令中间的括号是字符，不是块
    const paren = 'cmd /c "echo (format C:)"'
    expectCmds(paren, [
      ['cmd', 0],
      ['echo', 1]
    ])
    expect(commandNamed(paren, 'echo', 1).argv).toEqual(['echo', '(format', 'C:)'])
    expectCmds('cmd /c dir "C:\\Program Files (x86)"', [
      ['cmd', 0],
      ['dir', 1]
    ])
    // for … in (…) 的集合是一个字面词；do 之后的括号才是块
    const loop = 'cmd /c "for %i in (a b) do (echo %i)"'
    expectCmds(loop, [
      ['cmd', 0],
      ['for', 1],
      ['echo', 1]
    ])
    expect(commandNamed(loop, 'for', 1).argv).toContain('(a b)')
  })

  it('PSA-24d cmd 的 /c 引号规则：以引号开头的行去掉首尾引号；整行只是一个可执行文件路径时保留', () => {
    expect(commandNamed('cmd /c "format C: /q"', 'format', 1).argv).toEqual(['format', 'C:', '/q'])
    const exe = 'cmd /c "C:\\Program Files\\x\\app.exe"'
    const deep = analyzePowerShellCommand(exe).commands.filter((c) => c.depth === 1)
    expect(deep.map((c) => [c.base, c.argv])).toEqual([['app', ['C:\\Program Files\\x\\app.exe']]])
  })

  it('PSA-24e （修过的 SB-8）载荷里的动态参数不让整段失明，换成同样动态的占位', () => {
    expect(commandNamed('cmd /c format C: $null', 'format', 1).argv).toEqual(['format', 'C:', null])
    expect(cmds('powershell -c Format-Volume -DriveLetter D $null')).toContainEqual([
      'Format-Volume',
      1
    ])
  })

  it('PSA-25 Invoke-Expression：字面载荷才读得到', () => {
    for (const src of [
      "Invoke-Expression 'Format-Volume -DriveLetter D'",
      'iex "Format-Volume"',
      "iex -Command 'Format-Volume'",
      "iex -Command:'Format-Volume'",
      "IEX @'\nFormat-Volume\n'@"
    ]) {
      expect({ src, cmds: cmds(src) }).toEqual({
        src,
        cmds: expect.arrayContaining([['Format-Volume', 1]])
      })
    }
    for (const src of ['iex $s', 'iex "Format-Volume $d"', "'Format-Volume' | iex"]) {
      expect({ src, bases: bases(src) }).toEqual({ src, bases: ['Invoke-Expression'] })
    }
  })

  it('PSA-25b （修过的 SB-2）公共参数带的值不被当成载荷；开关不吞下一项', () => {
    for (const src of [
      "iex -ErrorAction SilentlyContinue 'Format-Volume'",
      "iex -ea x 'Format-Volume'",
      "iex -OutVariable v 'Format-Volume'"
    ]) {
      const deep = analyzePowerShellCommand(src).commands.filter((c) => c.depth === 1)
      expect({ src, deep: deep.map((c) => c.base) }).toEqual({ src, deep: ['Format-Volume'] })
    }
    expect(bases("iex -ErrorAction SilentlyContinue 'Format-Volume'")).not.toContain(
      'SilentlyContinue'
    )
    // -Verbose 是开关：它后面那一项就是载荷
    expect(cmds("iex -Verbose 'Format-Volume'")).toContainEqual(['Format-Volume', 1])
  })

  it('PSA-26 bash -c：交给宿主的 bash 解析器，载荷一字不改；读不到的不叫它', () => {
    const analyzeBash = vi.fn((src: string) => bashFacts(src))
    const facts = analyzePowerShellCommand("bash -c 'rm -rf /'", { analyzeBash })
    expect(analyzeBash).toHaveBeenCalledTimes(1)
    expect(analyzeBash).toHaveBeenCalledWith('rm -rf /')
    expect(facts.nestedBash.map((n) => n.depth)).toEqual([1])
    expect(facts.nestedBash[0].facts.source).toBe('rm -rf /')

    for (const [src, payload] of [
      ["sh -lc 'x'", 'x'],
      ['bash.exe -c x', 'x']
    ]) {
      const stub = vi.fn((s: string) => bashFacts(s))
      analyzePowerShellCommand(src, { analyzeBash: stub })
      expect({ src, calls: stub.mock.calls }).toEqual({ src, calls: [[payload]] })
    }

    const nested = analyzePowerShellCommand(`powershell -c "bash -c 'x'"`, {
      analyzeBash: vi.fn((s: string) => bashFacts(s))
    })
    expect(nested.nestedBash.map((n) => n.depth)).toEqual([2])

    for (const src of ['bash -c "rm $x"', 'bash script.sh']) {
      const stub = vi.fn((s: string) => bashFacts(s))
      analyzePowerShellCommand(src, { analyzeBash: stub })
      expect({ src, called: stub.mock.calls.length }).toEqual({ src, called: 0 })
    }

    // 宿主没注入解析器：载荷不展开、不抛
    const bare = analyzePowerShellCommand("bash -c 'rm -rf /'")
    expect(bare.nestedBash).toEqual([])
  })

  it('PSA-26b （修过的 SB-5）bash 解析器抛错：不抛，只跳过那一段，其余事实保留', () => {
    const analyzeBash = vi.fn((): ShellFacts => {
      throw new Error('boom')
    })
    const src = "Format-Volume; bash -c 'x'"
    let facts: ReturnType<typeof analyzePowerShellCommand> | undefined
    expect(() => {
      facts = analyzePowerShellCommand(src, { analyzeBash })
    }).not.toThrow()
    expect(analyzeBash).toHaveBeenCalledTimes(1)
    expect(facts!.parsed).toBe(true)
    expect(facts!.nestedBash).toEqual([])
    expectCmds(src, [
      ['Format-Volume', 0],
      ['bash', 0]
    ])
  })

  it('PSA-27 深度上限：7 层读到叶子，8 层停下并标记 depthExceeded', () => {
    expect(MAX_POWERSHELL_PAYLOAD_DEPTH).toBe(8)
    const deepest = MAX_POWERSHELL_PAYLOAD_DEPTH - 1
    const cmdChain = (n: number): string => 'cmd /c '.repeat(n) + 'format C:'
    const psChain = (n: number): string => 'powershell -c '.repeat(n) + 'Format-Volume'

    for (const [src, leaf] of [
      [cmdChain(deepest), 'format'],
      [psChain(deepest), 'Format-Volume']
    ]) {
      const facts = analyzePowerShellCommand(src)
      expect({ src, leaf: cmds(src).filter(([b]) => b === leaf) }).toEqual({
        src,
        leaf: [[leaf, deepest]]
      })
      expect(facts.depthExceeded).toBe(false)
    }
    for (const [src, leaf] of [
      [cmdChain(deepest + 1), 'format'],
      [psChain(deepest + 1), 'Format-Volume']
    ]) {
      const facts = analyzePowerShellCommand(src)
      expect({ src, leaf: bases(src).includes(leaf) }).toEqual({ src, leaf: false })
      expect(facts.depthExceeded).toBe(true)
    }

    // 两种语言交替：cmd 载荷里的 powershell 按 cmd 读、它的载荷再按 PowerShell 读
    const mixed = analyzePowerShellCommand('cmd /c powershell -c Format-Volume').commands.map(
      (c) => [c.base, c.shell, c.depth]
    )
    expect(mixed).toEqual(
      expect.arrayContaining([
        ['powershell', 'cmd', 1],
        ['Format-Volume', 'powershell', 2]
      ])
    )
  })

  it('PSA-28 读不通的嵌套 PowerShell 载荷整段不并入，外层照常', () => {
    const facts = analyzePowerShellCommand(`powershell -c "Format-Volume; 'unterminated"`)
    expect(facts.parsed).toBe(true)
    expect(facts.commands.filter((c) => c.depth > 0)).toEqual([])
  })
})

// ─── 错误与上限 ──────────────────────────────────────────────

describe('PowerShell 扫描器 — 错误与上限', () => {
  it('PSA-29 结构错误：parsed=false、reason=syntax-error、errorAt 是位置，只留错误之前读到的', () => {
    const cases: [string, string[]][] = [
      ["Format-Volume; 'oops", ['Format-Volume']],
      ['"unterminated', []],
      ['(Get-Item x', ['Get-Item']],
      ['Get-Item x )', ['Get-Item']],
      ['Get-Item x }', ['Get-Item']],
      ["@'\nnever closed", []],
      ['Write-Output a <# never', []],
      ['Get-Content < in.txt', []],
      ['Remove-Item x < y', []]
    ]
    for (const [src, expected] of cases) {
      const facts = analyzePowerShellCommand(src)
      expect({
        src,
        parsed: facts.parsed,
        reason: facts.reason,
        errorAt: typeof facts.errorAt,
        bases: facts.commands.map((c) => c.base)
      }).toEqual({ src, parsed: false, reason: 'syntax-error', errorAt: 'number', bases: expected })
    }
    // 未闭合的括号报在开括号上
    expect(analyzePowerShellCommand('(Get-Item x').errorAt).toBe(0)
  })

  it('PSA-30 长度上限：恰好 64K 照读，多一个字符就按未解析处理', () => {
    expect(MAX_POWERSHELL_SOURCE_LENGTH).toBe(65536)
    const head = 'Format-Volume '
    const atLimit = head + 'x'.repeat(MAX_POWERSHELL_SOURCE_LENGTH - head.length)
    expect(atLimit.length).toBe(65536)
    const ok = analyzePowerShellCommand(atLimit)
    expect(ok.parsed).toBe(true)
    expect(ok.reason).toBe('ok')

    // 逐字段断言：toEqual 整份事实会在失败时把 64K 的 source 打出来
    const over = analyzePowerShellCommand(atLimit + 'x')
    expect(over.parsed).toBe(false)
    expect(over.reason).toBe('too-long')
    expect(over.errorAt).toBeNull()
    expect(over.commands).toEqual([])
    expect(over.redirects).toEqual([])
    expect(over.nestedBash).toEqual([])
    expect(over.depthExceeded).toBe(false)
  })

  it('PSA-31 括号嵌套上限：64 层照读，65 层按结构错误处理；病态输入不爆栈', () => {
    const nest = (n: number): string => '('.repeat(n) + 'Format-Volume' + ')'.repeat(n)
    expect(cmds(nest(64))).toEqual([['Format-Volume', 0]])
    expect(analyzePowerShellCommand(nest(64)).parsed).toBe(true)
    expect(analyzePowerShellCommand(nest(65)).parsed).toBe(false)

    let pathological: ReturnType<typeof analyzePowerShellCommand> | undefined
    expect(() => {
      pathological = analyzePowerShellCommand('('.repeat(10_000))
    }).not.toThrow()
    expect(pathological!.parsed).toBe(false)

    const sub = 'Write-Output ' + '$('.repeat(65) + 'Format-Volume' + ')'.repeat(65)
    expect(analyzePowerShellCommand(sub).parsed).toBe(false)
  })

  it('PSA-32 残缺输入一律不抛', () => {
    const empty = analyzePowerShellCommand('')
    expect([empty.parsed, empty.commands]).toEqual([true, []])
    for (const src of [
      '   \n\t ',
      ')',
      '}',
      '@',
      '$',
      '`',
      '&',
      '|',
      '--%',
      "'@",
      '@"',
      '&&',
      ';;;'
    ]) {
      expect(() => analyzePowerShellCommand(src), JSON.stringify(src)).not.toThrow()
    }
  })
})
