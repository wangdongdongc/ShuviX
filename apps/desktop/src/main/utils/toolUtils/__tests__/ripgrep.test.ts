/**
 * rgSearch 的搜索目标前面有 `--`（HG-5，真实 rg，POSIX）。
 *
 * 单文件搜索时 target 就是文件名原样。没有 `--` 时，一个名叫 `--pre=./evil.sh` 的文件会被 rg 读成
 * 选项：--pre 对每个被搜的文件执行一条命令 —— 让 agent「在这个文件里搜一下」就等于执行了仓库里的
 * 任意脚本，命令询问 / 沙箱一个都看不见。名叫 `--files` 的文件则把搜索悄悄换成「列文件」。
 *
 * 夹具：临时目录里放一个可执行的 evil.sh（被执行就 touch 一个 marker），以及字面路径为
 * `--pre=./evil.sh`（目录 `--pre=.` 里的 evil.sh —— 文件名不能含 `/`，而这正是仓库里能造出来的
 * 形状）与 `--files` 的两个文件。对照组用**同一组参数去掉 `--`** 直接跑 rg，先证明这个夹具确实能
 * 触发执行 —— 于是「marker 不存在」说的是 `--` 在起作用，而不是夹具本来就无害。
 *
 * rg 二进制来自 @vscode/ripgrep；Windows 或二进制缺席时整组跳过。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRgPath, rgSearch, type RgMatch } from '../ripgrep'

const RG_AVAILABLE = process.platform !== 'win32' && existsSync(getRgPath())

let dir = ''
let marker = ''

const byPath = (matches: RgMatch[]): RgMatch[] =>
  [...matches].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.lineNum - b.lineNum))

/**
 * 夹具：
 *   evil.sh            可执行；被当作 --pre 预处理器执行时 touch marker，再原样输出文件内容
 *   --pre=./evil.sh    "needle"（目录 `--pre=.` 下的 evil.sh）
 *   --files            "needle in files"
 *   notes/a.txt        第 2 行 "the needle here"
 *   flags.txt          一行字面写着 -needle / --pre=./evil.sh / --files 的文本（给以 - 开头的模式用）
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-rg-test-'))
  marker = join(dir, 'marker')
  const evil = join(dir, 'evil.sh')
  writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`)
  chmodSync(evil, 0o755)
  mkdirSync(join(dir, '--pre=.'))
  writeFileSync(join(dir, '--pre=.', 'evil.sh'), 'needle\n')
  writeFileSync(join(dir, '--files'), 'needle in files\n')
  mkdirSync(join(dir, 'notes'))
  writeFileSync(join(dir, 'notes', 'a.txt'), 'first line\nthe needle here\n')
  writeFileSync(join(dir, 'flags.txt'), 'run with -needle then --pre=./evil.sh or --files\n')
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe.skipIf(!RG_AVAILABLE)('HG-5 rgSearch —— 以 - 开头的文件名是路径，不是选项', () => {
  it('HG-5 对照组：同一组参数去掉 `--` 直接跑 rg，--pre=./evil.sh 会被执行（夹具有效）', () => {
    const res = spawnSync(
      getRgPath(),
      [
        '-nH',
        '--hidden',
        '--no-messages',
        '--field-match-separator=|',
        '--regexp',
        'needle',
        '--pre=./evil.sh'
      ],
      // stdin 与 rgSearch 一样接 /dev/null：stdin 是管道时 rg 改搜 stdin，--pre 就无从触发
      { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    expect(res.error).toBeUndefined()
    expect(existsSync(marker)).toBe(true)
  })

  it('HG-5 target 为 `--pre=./evil.sh` → 在这个文件里找到 needle，evil.sh 没被执行', async () => {
    const result = await rgSearch({ cwd: dir, pattern: 'needle', target: '--pre=./evil.sh' })

    expect(result).toEqual({
      matches: [{ path: '--pre=./evil.sh', lineNum: 1, lineText: 'needle' }],
      truncated: false
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('HG-5 target 为 `--files` → 搜的是这个文件，而不是切成「列文件」模式', async () => {
    const result = await rgSearch({ cwd: dir, pattern: 'needle', target: '--files' })

    expect(result).toEqual({
      matches: [{ path: '--files', lineNum: 1, lineText: 'needle in files' }],
      truncated: false
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('HG-5 默认 target（.）照旧：整个 cwd 递归、去掉 ./ 前缀；子目录 target 照旧；都不执行 evil.sh', async () => {
    const all = await rgSearch({ cwd: dir, pattern: 'needle' })
    expect(all.truncated).toBe(false)
    expect(byPath(all.matches)).toEqual(
      byPath([
        { path: '--files', lineNum: 1, lineText: 'needle in files' },
        { path: '--pre=./evil.sh', lineNum: 1, lineText: 'needle' },
        {
          path: 'flags.txt',
          lineNum: 1,
          lineText: 'run with -needle then --pre=./evil.sh or --files'
        },
        { path: 'notes/a.txt', lineNum: 2, lineText: 'the needle here' }
      ])
    )

    const sub = await rgSearch({ cwd: dir, pattern: 'needle', target: 'notes' })
    expect(sub.matches).toEqual([{ path: 'notes/a.txt', lineNum: 2, lineText: 'the needle here' }])

    expect(existsSync(marker)).toBe(false)
  })

  it('HG-5 以 - 开头的模式仍是模式（走 --regexp）：-needle / --pre=./evil.sh / --files 都按文本匹配', async () => {
    const flagsLine = {
      path: 'flags.txt',
      lineNum: 1,
      lineText: 'run with -needle then --pre=./evil.sh or --files'
    }

    const dash = await rgSearch({ cwd: dir, pattern: '-needle' })
    expect(dash.matches).toEqual([flagsLine])

    const pre = await rgSearch({ cwd: dir, pattern: '--pre=./evil.sh' })
    expect(pre.matches).toEqual([flagsLine])
    expect(existsSync(marker)).toBe(false)

    // 模式是 --files、目标也是 --files：两边都得各就各位（文件内容里没有这串字 → 零命中，而不是列出文件）
    const both = await rgSearch({ cwd: dir, pattern: '--files', target: '--files' })
    expect(both.matches).toEqual([])
    const inFlags = await rgSearch({ cwd: dir, pattern: '--files', target: 'flags.txt' })
    expect(inFlags.matches).toEqual([flagsLine])
  })
})
