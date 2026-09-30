/**
 * 「实际执行的命令」那份记录（commandInvocation.ts）—— 工具卡点开才读的旁路文件：
 *
 *  - CI-1..4 bash 形态：`cd` + 变量前缀 + 命令，逐字钉住；套沙箱的 argv（有 `--`）每个选项连同值一行、
 *            `--` 之后排在最后一行；只列名字的变量是开头一行 `:` 空命令（不是 `#` —— 交互式 zsh 不认注释）；
 *  - CI-5 / CI-6 两种 shell 的引号规则（安全字符原样，其余包起来；PowerShell 的弯单引号也要双写）；
 *  - CI-7 powershell 形态：`Set-Location` + `$env:K = '字面量'` + `& '可执行文件' …`；
 *  - CI-8 只列名字的变量名里有控制字符：压成 `?`，说明留在一行里（换行逃不出去）；
 *  - RT-1 贴进真 shell（bash / sh / zsh）跑一遍：cwd、变量、每个参数一字不差地到达被调程序；
 *  - RT-2 同上，pwsh（这台机器上没有就跳过）；
 *  - RI-1..7 读写：记下 → 原样读回；会话 id / toolCallId 逃不出 `tool_results/<sid>/`；
 *            没有记录不建目录；512 KiB 读上限；写失败只记一条警告、不抛。
 *
 * 替身：electron（userData → 每条用例一个新的临时目录）、logger（记下警告）。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  userData: '',
  logs: [] as Array<{ tag: string; level: string; text: string }>
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false }
}))
vi.mock('../../logger', () => {
  const make = (tag: string): Record<string, (...args: unknown[]) => void> => {
    const at =
      (level: string) =>
      (...args: unknown[]): void => {
        state.logs.push({ tag, level, text: args.map(String).join(' ') })
      }
    return {
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
      verbose: at('verbose'),
      silly: at('silly'),
      log: at('log')
    }
  }
  return { createLogger: make, default: make('default') }
})

import {
  formatInvocation,
  psQuote,
  readInvocation,
  recordInvocation,
  shQuote,
  type InvocationRecord
} from '../commandInvocation'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-cmdinv-')))
let caseSeq = 0

const SID = 'sess-cmdinv'
const toolResults = (): string => join(state.userData, 'tool_results')
const sessionDir = (sid = SID): string => join(toolResults(), sid)

const warnings = (): string[] =>
  state.logs.filter((e) => e.tag === 'CommandInvocation' && e.level === 'warn').map((e) => e.text)

/** 一份最小的 bash 记录 */
function bashRecord(over: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    shell: 'bash',
    invocation: { file: '/bin/bash', args: ['--norc', '-c', 'ls -la'] },
    cwd: '/w',
    env: {},
    hiddenEnv: [],
    ...over
  }
}

beforeEach(() => {
  state.userData = join(ROOT, `case-${++caseSeq}`)
  mkdirSync(state.userData, { recursive: true })
  state.logs.length = 0
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

// ─── 格式化 ────────────────────────────────────────

describe('formatInvocation —— bash 形态', () => {
  it('CI-1 没套沙箱、没有额外变量：cd 一行 + 命令一行', () => {
    expect(formatInvocation(bashRecord())).toBe("cd /w && \\\n/bin/bash --norc -c 'ls -la'\n")
  })

  it('CI-2 带会话 id：变量前缀单独一行，夹在 cd 与命令之间', () => {
    expect(formatInvocation(bashRecord({ env: { SHUVIX_SESSION_ID: 'sid-1' } }))).toBe(
      "cd /w && \\\nSHUVIX_SESSION_ID=sid-1 \\\n/bin/bash --norc -c 'ls -la'\n"
    )
  })

  it('CI-3 套沙箱的 argv（有 --）：选项连同值各占一行，-- 之后排在最后一行；变量按给定顺序写在一行', () => {
    const text = formatInvocation({
      shell: 'bash',
      invocation: {
        file: '/usr/bin/sandbox-exec',
        args: [
          '-p',
          '(version 1)\n(deny default)',
          '-D',
          'P0=/w',
          '-D',
          'P1=/a b',
          '--',
          '/bin/bash',
          '--norc',
          '-c',
          "echo 'hi'"
        ]
      },
      cwd: '/w',
      env: { TMPDIR: '/private/tmp/shuvix-501/abcd1234/', SHUVIX_SESSION_ID: 'sid-1' },
      hiddenEnv: []
    })
    expect(text).toBe(
      [
        'cd /w && \\',
        'TMPDIR=/private/tmp/shuvix-501/abcd1234/ SHUVIX_SESSION_ID=sid-1 \\',
        '/usr/bin/sandbox-exec \\',
        "  -p '(version 1)",
        "(deny default)' \\",
        '  -D P0=/w \\',
        "  -D 'P1=/a b' \\",
        "  -- /bin/bash --norc -c 'echo '\\''hi'\\'''"
      ].join('\n') + '\n'
    )
  })

  it('CI-4 只列名字的变量：开头一行 `:` 空命令（整段说明一个单引号词），不是 # 注释', () => {
    const text = formatInvocation(
      bashRecord({ env: { SHUVIX_SESSION_ID: 'sid-1' }, hiddenEnv: ['API_KEY', 'DB_URL'] })
    )
    const lines = text.split('\n')
    expect(lines[0]).toBe(": 'Also set (values not shown): API_KEY, DB_URL'")
    expect(text.startsWith('#')).toBe(false)
    // 说明之后才是原样的 cd + 变量 + 命令
    expect(lines.slice(1).join('\n')).toBe(
      "cd /w && \\\nSHUVIX_SESSION_ID=sid-1 \\\n/bin/bash --norc -c 'ls -la'\n"
    )
  })

  it('CI-4 hiddenEnv 为空：没有说明行，第一行就是 cd', () => {
    const text = formatInvocation(bashRecord({ hiddenEnv: [] }))
    expect(text.startsWith('cd /w && ')).toBe(true)
    expect(text).not.toContain('Also set')
  })
})

describe('引号规则', () => {
  it.each(['/usr/bin/x', '-D', 'P0=/a/b.c', 'a,b:c@d%e+f'])(
    'CI-5 shQuote 安全字符原样：%s',
    (word) => {
      expect(shQuote(word)).toBe(word)
    }
  )

  it.each(['a b', '$HOME', '*', '~', 'a;b', '#x', 'a\nb', 'a\\b', '!x', '中文'])(
    'CI-5 shQuote 其余一律单引号包起来：%j',
    (word) => {
      expect(shQuote(word)).toBe(`'${word}'`)
    }
  )

  it("CI-5 shQuote 空串 → ''；内部单引号写成 '\\''", () => {
    expect(shQuote('')).toBe("''")
    expect(shQuote("it's")).toBe("'it'\\''s'")
  })

  it.each(['-NoLogo', 'Bypass'])('CI-6 psQuote 安全字符原样：%s', (word) => {
    expect(psQuote(word)).toBe(word)
  })

  it.each([
    ['C:\\Program Files\\x.exe', "'C:\\Program Files\\x.exe'"],
    ['$env:X', "'$env:X'"],
    ['a b', "'a b'"],
    ["it's", "'it''s'"],
    ['', "''"],
    // 弯单引号在 PowerShell 里同样结束字符串 —— 与 ' 一样双写
    ['don\u2019t', "'don\u2019\u2019t'"],
    ['\u2018x\u201Ay\u201B', "'\u2018\u2018x\u201A\u201Ay\u201B\u201B'"]
  ])('CI-6 psQuote 其余写成单引号字面量：%j → %j', (word, quoted) => {
    expect(psQuote(word)).toBe(quoted)
  })
})

describe('formatInvocation —— powershell 形态', () => {
  it('CI-7 说明（# 注释）→ Set-Location → $env: 赋值（值恒为字面量）→ & 可执行文件 + 参数', () => {
    const text = formatInvocation({
      shell: 'powershell',
      invocation: {
        file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        args: ['-NoLogo', '-Command', "Write-Output 'a'\nGet-Date"]
      },
      cwd: 'C:\\w',
      env: { SHUVIX_SESSION_ID: 'sid-1' },
      hiddenEnv: ['TOKEN']
    })
    expect(text.split('\n')).toEqual([
      '# Also set (values not shown): TOKEN',
      "Set-Location -LiteralPath 'C:\\w'",
      "$env:SHUVIX_SESSION_ID = 'sid-1'",
      "& 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -NoLogo -Command 'Write-Output ''a''",
      "Get-Date'",
      ''
    ])
  })

  it('CI-7 $env: 的值即使全是安全字符也写成字面量（赋值右边是表达式模式，裸词会被当命令跑）', () => {
    const text = formatInvocation({
      shell: 'powershell',
      invocation: { file: 'pwsh.exe', args: ['-Command', 'x'] },
      cwd: 'C:\\w',
      env: { A: 'plain', B: "it's", C: '' },
      hiddenEnv: []
    })
    const lines = text.split('\n')
    expect(lines).toContain("$env:A = 'plain'")
    expect(lines).toContain("$env:B = 'it''s'")
    expect(lines).toContain("$env:C = ''")
    expect(text).not.toContain('#')
  })
})

describe('只列名字的变量名里有控制字符', () => {
  it.each([
    ['A\nrm -rf ~', 'A?rm -rf ~'],
    ['B\r\nC', 'B??C'],
    ['D\x00E\x7fF\tG', 'D?E?F?G']
  ])('CI-8 bash：%j 压成 %j，说明仍在一行、仍在引号里', (name, shown) => {
    const text = formatInvocation(bashRecord({ hiddenEnv: [name] }))
    const lines = text.split('\n')
    expect(lines[0]).toBe(`: 'Also set (values not shown): ${shown}'`)
    expect(lines[1].startsWith('cd /w && ')).toBe(true)
    expect(lines).not.toContain('rm -rf ~')
  })

  it('CI-8 powershell：同样压成一行注释', () => {
    const text = formatInvocation({
      shell: 'powershell',
      invocation: { file: 'pwsh.exe', args: ['-Command', 'x'] },
      cwd: 'C:\\w',
      env: {},
      hiddenEnv: ['A\nrm -rf ~']
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe('# Also set (values not shown): A?rm -rf ~')
    expect(lines[1]).toBe("Set-Location -LiteralPath 'C:\\w'")
  })
})

// ─── 贴进真 shell ──────────────────────────────────

describe.skipIf(process.platform === 'win32')('RT-1 贴进真 shell 跑一遍 [posix]', () => {
  const WORDS = ['plain', 'with space', "it's", '$HOME', 'multi\nline', '', '*', '~'] as const
  const ENV = { TMPDIR: '/tmp/a b/', SHUVIX_SESSION_ID: "s'1" }

  const zsh = spawnSync('/bin/sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout.trim()
  /**
   * 外层 shell：解析这份文本的那一个（被调程序恒为 /bin/sh）。`stdin` = 像贴进终端那样逐行喂给
   * 交互式 shell —— macOS 终端缺省的交互式 zsh 不认 # 注释（interactive_comments 关着），说明行
   * 必须是 `:` 空命令，这一格就是为它设的（`-c` 形态的 zsh 照认注释，测不出来）
   */
  const OUTER: Array<[string, string, string[], 'arg' | 'stdin']> = [
    ['bash --norc -c', '/bin/bash', ['--norc', '-c'], 'arg'],
    ['sh -c', '/bin/sh', ['-c'], 'arg'],
    ...(zsh
      ? ([
          ['zsh -f -c', zsh, ['-f', '-c'], 'arg'],
          ['interactive zsh -f -i (stdin)', zsh, ['-f', '-i'], 'stdin']
        ] as Array<[string, string, string[], 'arg' | 'stdin']>)
      : [])
  ]

  it.each(
    OUTER.flatMap(
      ([label, file, args, mode]) =>
        [
          [label, 'without --', file, args, mode, false],
          [label, 'with --', file, args, mode, true]
        ] as Array<[string, string, string, string[], 'arg' | 'stdin', boolean]>
    )
  )(
    'RT-1 %s（%s）：cwd、变量、每个参数一字不差地到达被调程序，shell 不报错',
    (_label, _variant, outerFile, outerArgs, mode, withDashes) => {
      const cwd = join(ROOT, `rt-${++caseSeq}`, "dir with 'q' $x")
      mkdirSync(cwd, { recursive: true })
      const words = withDashes ? [...WORDS, '--', 'after', '-x'] : [...WORDS, 'after', '-x']
      const text = formatInvocation({
        shell: 'bash',
        invocation: {
          file: '/bin/sh',
          args: ['-c', 'printf "%s\\0" "$PWD" "$TMPDIR" "$SHUVIX_SESSION_ID" "$@"', 'sh', ...words]
        },
        cwd,
        env: ENV,
        // 说明行（`:` 空命令）贴进去必须无害
        hiddenEnv: ['API_KEY', 'DB_URL']
      })
      // 有 -- 时确实排成了多行形态（否则这一变体没测到分行的那条路径）
      if (withDashes) expect(text).toContain('\n  -- after -x\n')

      const result = spawnSync(outerFile, mode === 'arg' ? [...outerArgs, text] : outerArgs, {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ROOT },
        ...(mode === 'stdin' ? { input: text } : {})
      })
      expect(result.status, result.stderr).toBe(0)
      // 交互式 shell 的提示符写在 stderr 上，所以不要求它为空；但不能有 shell 自己报的错
      // （`#` 说明行在交互式 zsh 里是 "zsh: no matches found: (values not shown):"）
      expect(result.stderr).not.toMatch(/(zsh|bash|sh): /)
      if (mode === 'arg') expect(result.stderr).toBe('')
      const got = result.stdout.split('\0')
      // printf 每个词后面都跟一个 NUL：最后一段是空串
      expect(got.pop()).toBe('')
      expect(got).toEqual([cwd, ENV.TMPDIR, ENV.SHUVIX_SESSION_ID, ...words])
    }
  )
})

const pwsh = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], {
  encoding: 'utf8'
})
  .stdout?.trim()
  .split(/\r?\n/)[0]

describe.skipIf(!pwsh)('RT-2 贴进真 pwsh 跑一遍（没有 pwsh 就跳过）', () => {
  it('RT-2 cwd、变量、每个参数一字不差地到达被调程序', () => {
    const cwd = join(ROOT, `rt-ps-${++caseSeq}`, "dir with 'q' $x \u2019")
    mkdirSync(cwd, { recursive: true })
    const words = ['plain', 'with space', "it's", '$HOME', 'don\u2019t', '*']
    const script =
      '$out = @((Get-Location).ProviderPath, $env:TMPDIR, $env:SHUVIX_SESSION_ID) + $args; ' +
      '[Console]::Out.Write(($out -join [char]0) + [char]0)'
    const text = formatInvocation({
      shell: 'powershell',
      invocation: { file: pwsh!, args: ['-NoLogo', '-NoProfile', '-Command', script, ...words] },
      cwd,
      env: { TMPDIR: '/tmp/a b/', SHUVIX_SESSION_ID: "s'1" },
      hiddenEnv: ['API_KEY']
    })
    const result = spawnSync(pwsh!, ['-NoLogo', '-NoProfile', '-Command', text], {
      encoding: 'utf8'
    })
    expect(result.status, result.stderr).toBe(0)
    const got = result.stdout.split('\0')
    expect(got.pop()).toBe('')
    expect(got.slice(0, 3)).toEqual([cwd, '/tmp/a b/', "s'1"])
  })
})

// ─── 读写 ──────────────────────────────────────────

describe('recordInvocation / readInvocation', () => {
  it('RI-1 记下 → 原样读回（就是 formatInvocation 的文本）', () => {
    const rec = bashRecord({ env: { SHUVIX_SESSION_ID: SID }, hiddenEnv: ['API_KEY'] })
    recordInvocation(SID, 'call_1', rec)
    expect(readInvocation(SID, 'call_1')).toBe(formatInvocation(rec))
    expect(existsSync(join(sessionDir(), 'call_1.invocation.txt'))).toBe(true)
    expect(warnings()).toEqual([])
  })

  it.each([
    ['空串', ''],
    ['.', '.'],
    ['..', '..'],
    ['../x', '../x'],
    ['a/b', 'a/b'],
    ['a\\b', 'a\\b'],
    ['x..y', 'x..y'],
    ['undefined', undefined as unknown as string]
  ])('RI-2 不安全的会话 id（%s）→ null，哪怕它会指到的地方真有一份可读的文件', (_label, sid) => {
    const id = 'call_x'
    const name = `${id}.invocation.txt`
    // 在每个坏 id 拼出来会指到的位置都放一份
    for (const dir of [
      toolResults(),
      state.userData,
      join(state.userData, 'x'),
      join(toolResults(), 'a', 'b'),
      join(toolResults(), 'a\\b'),
      join(toolResults(), 'x..y'),
      join(toolResults(), 'undefined')
    ]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), 'PLANTED')
    }
    expect(readInvocation(sid, id)).toBeNull()
  })

  it('RI-3 toolCallId 逃不出会话目录：文件名只剩安全字符；同一个原始 id 读回的就是那一条', () => {
    // 会话目录旁边放一份诱饵：'../evil' 若被原样拼接就会读到它
    mkdirSync(toolResults(), { recursive: true })
    writeFileSync(join(toolResults(), 'evil.invocation.txt'), 'PLANTED')
    expect(readInvocation(SID, '../evil')).toBeNull()

    const ids = ['../../evil', 'a/b', 'a\\b', '..', 'call:1.x', '../evil']
    for (const id of ids) {
      const rec = bashRecord({ invocation: { file: '/bin/bash', args: ['-c', `echo ${id}`] } })
      recordInvocation(SID, id, rec)
      // 立刻读回（'a/b' 与 'a\\b' 压成同一个文件名，后写的会盖掉先写的）
      const back = readInvocation(SID, id)
      expect(back).toBe(formatInvocation(rec))
      expect(back).not.toBe('PLANTED')
    }

    for (const name of readdirSync(sessionDir())) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+\.invocation\.txt$/)
    }
    // 会话目录之外什么都没多出来：tool_results 下只有会话目录与那份诱饵，userData 下只有 tool_results
    expect(readdirSync(toolResults()).sort()).toEqual([SID, 'evil.invocation.txt'].sort())
    expect(readdirSync(state.userData)).toEqual(['tool_results'])
    expect(warnings()).toEqual([])
  })

  it('RI-4 空 toolCallId → null', () => {
    recordInvocation(SID, 'call_1', bashRecord())
    expect(readInvocation(SID, '')).toBeNull()
  })

  it('RI-5 没有记录 → null，而且读这一下不建 tool_results/<sid>/', () => {
    expect(readInvocation('sess-never', 'call_1')).toBeNull()
    expect(existsSync(sessionDir('sess-never'))).toBe(false)
    expect(existsSync(toolResults())).toBe(false)
  })

  it('RI-6 512 KiB 读上限：恰好 524288 字节整份给；多 100 字节就截断并说还剩多少', () => {
    const LIMIT = 512 * 1024
    mkdirSync(sessionDir(), { recursive: true })

    writeFileSync(join(sessionDir(), 'call_exact.invocation.txt'), 'a'.repeat(LIMIT))
    expect(readInvocation(SID, 'call_exact')).toBe('a'.repeat(LIMIT))

    writeFileSync(join(sessionDir(), 'call_over.invocation.txt'), 'a'.repeat(LIMIT + 100))
    expect(readInvocation(SID, 'call_over')).toBe(
      'a'.repeat(LIMIT) + '\n… (100 more bytes not shown)\n'
    )
  })

  it('RI-7 写失败（记录的位置被一个目录占着）：不抛，只记一条警告；读回 null（再记一条）', () => {
    mkdirSync(join(sessionDir(), 'call_dir.invocation.txt'), { recursive: true })

    expect(() => recordInvocation(SID, 'call_dir', bashRecord())).not.toThrow()
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('call_dir')

    expect(readInvocation(SID, 'call_dir')).toBeNull()
    expect(warnings()).toHaveLength(2)
  })
})
