/**
 * 真值填回命令时按引号环境转义（redaction/commandQuote.ts，docs/auto-redaction-design.md §14.2）。
 *
 *   CQ-1 POSIX：每种位置（裸词、紧贴别的字符、赋值、单引号、双引号、`$( )` 里、`$'…'`、两种 heredoc、注释）用真 bash
 *        跑一遍，输出的就是真值 —— 值里有 `$`、`'`、`"`、反引号、反斜杠、空格、`!`、`&`
 *   CQ-2 POSIX：解析器没就绪、命令有语法错误 → null（调用方原样替换）
 *   CQ-3 PowerShell：单引号、双引号（含 `""` 与反引号转义）、两种 here-string、行注释与块注释、裸词
 *   CQ-4 PowerShell 的转义写法
 */
import { spawnSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { initShellParser, resetShellParserForTests } from '../../security/shell'
import { loadShellParserWasmFromNodeModules } from '../../security/shell/nodeWasm'
import { commandQuoteContexts, quoteValue } from '../commandQuote'

const P = '{{REDACTED_PASSWORD_abcd2345}}'

const VALUES = [
  'Tr0ub4dor&3$x',
  "it's a 'quote'",
  'a"b`c\\d$HOME',
  'spa ce! $(whoami)',
  'plainValue123'
]

/** 命令里的 P 按位置转义成 value */
function fill(command: string, value: string): string {
  const spans: Array<{ start: number; end: number }> = []
  for (let i = command.indexOf(P); i !== -1; i = command.indexOf(P, i + P.length)) {
    spans.push({ start: i, end: i + P.length })
  }
  const contexts = commandQuoteContexts(command, spans, 'posix')
  if (contexts === null) throw new Error(`no contexts for ${command}`)
  let out = ''
  let last = 0
  spans.forEach((span, i) => {
    out += command.slice(last, span.start) + quoteValue(value, contexts[i], 'posix')
    last = span.end
  })
  return out + command.slice(last)
}

function bash(command: string): string {
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { HOME: '/home/x' } })
  if (r.status !== 0) throw new Error(`bash failed (${r.status}): ${r.stderr}\n${command}`)
  return r.stdout
}

beforeAll(async () => {
  await initShellParser(loadShellParserWasmFromNodeModules())
})

describe('POSIX', () => {
  const cases: Array<[name: string, command: string, expected: (v: string) => string]> = [
    ['裸词', `printf %s ${P}`, (v) => v],
    ['紧贴别的字符', `printf %s -p${P}`, (v) => `-p${v}`],
    ['赋值', `X=${P}; printf %s "$X"`, (v) => v],
    ['单引号', `printf %s 'x ${P} y'`, (v) => `x ${v} y`],
    ['双引号', `printf %s "x ${P} y"`, (v) => `x ${v} y`],
    ['双引号里的 $( )', `printf %s "$(printf %s ${P})"`, (v) => v],
    ["$'…'", `printf %s $'${P}'`, (v) => v],
    ['heredoc', `cat <<EOF\n${P}\nEOF`, (v) => `${v}\n`],
    ['加了引号的 heredoc', `cat <<'EOF'\n${P}\nEOF`, (v) => `${v}\n`],
    ['注释', `printf %s ok # ${P}`, () => 'ok'],
    ['管道里喂给 sudo -S 那样的', `printf '%s\\n' "${P}" | cat`, (v) => `${v}\n`]
  ]
  for (const [name, command, expected] of cases) {
    it(`CQ-1 ${name}`, () => {
      for (const value of VALUES) expect(bash(fill(command, value))).toBe(expected(value))
    })
  }

  it('CQ-2 解析器没就绪、语法错误 → null', async () => {
    expect(commandQuoteContexts(`echo "${P}`, [{ start: 6, end: 6 + P.length }], 'posix')).toBe(
      null
    )
    resetShellParserForTests()
    try {
      expect(commandQuoteContexts(`echo ${P}`, [{ start: 5, end: 5 + P.length }], 'posix')).toBe(
        null
      )
    } finally {
      await initShellParser(loadShellParserWasmFromNodeModules())
    }
  })
})

describe('PowerShell', () => {
  const contextOf = (command: string): string => {
    const start = command.indexOf(P)
    return commandQuoteContexts(command, [{ start, end: start + P.length }], 'powershell')![0]
  }

  it('CQ-3 位置', () => {
    expect(contextOf(`Write-Output ${P}`)).toBe('bare')
    expect(contextOf(`Write-Output 'it''s ${P}'`)).toBe('single')
    expect(contextOf(`Write-Output "say ""hi"" ${P}"`)).toBe('double')
    expect(contextOf('Write-Output "a`"b ' + P + '"')).toBe('double')
    expect(contextOf(`$s = @'\n${P}\n'@`)).toBe('literal')
    expect(contextOf(`$s = @"\n${P}\n"@`)).toBe('here-double')
    expect(contextOf(`ls # ${P}`)).toBe('literal')
    expect(contextOf(`ls <# ${P} #> -Force`)).toBe('literal')
    expect(contextOf(`'a' + ${P}`)).toBe('bare')
  })

  it('CQ-4 转义', () => {
    const v = 'it\'s $x `y "z"'
    expect(quoteValue(v, 'single', 'powershell')).toBe('it\'\'s $x `y "z"')
    expect(quoteValue(v, 'double', 'powershell')).toBe('it\'s `$x ``y `"z`"')
    expect(quoteValue(v, 'here-double', 'powershell')).toBe('it\'s `$x ``y "z"')
    expect(quoteValue(v, 'bare', 'powershell')).toBe("'it''s $x `y \"z\"'")
    expect(quoteValue('plain', 'bare', 'powershell')).toBe("'plain'")
    expect(quoteValue(v, 'literal', 'powershell')).toBe(v)
  })
})
