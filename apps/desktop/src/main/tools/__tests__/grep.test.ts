/**
 * grep 工具：rg 拒绝执行的搜索作为**错误**交回模型，而不是「No matches found」（真实 rg，POSIX）。
 *
 * 旧代码里写错的正则（`recordRead(`）、写坏的 include glob、rg 不支持的写法（反向引用、环视、未知的
 * Unicode 属性、字面换行）全都被说成「No matches found」—— 模型据此断言「没有调用者」。现在 rgSearch
 * 抛 RgUsageError，工具把它翻成 `The search was not run — ripgrep rejected it:` + rg 自己的说明；
 * 只有 rg 说的是 regex parse error 时才再补一句「pattern 是正则，这些字符要转义」（GR-3）。
 *
 * 反过来不能误报：有目录读不了时 rg 也退出 2，此时别处的匹配照样交回（GR-6）；合法模式零命中仍是
 * 「No matches found」—— 包括有读不了的目录、rg 因 --no-messages 退出 2 而 stderr 为空的情形（GR-7）。
 *
 * 门面 mock 同 edit.test.ts：resolveProjectConfig → 每个用例自己的临时目录、assertReadAllowed 恒放行；
 * toolRegistry / i18n / logger 桩掉。rg 二进制来自 @vscode/ripgrep；Windows 或二进制缺席时跳过，
 * chmod 000 的用例在 root 下也跳过（权限在 afterEach 里先还原再删目录）。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeTool,
  failureText,
  resultText,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: state.dir, referenceDirs: [] }),
  assertReadAllowed: async () => {},
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { GrepTool, searchRejectedMessage } from '../grep'
import { getRgPath } from '../../utils/toolUtils/ripgrep'
import type { ToolContext } from '../../services/toolContext'

const RG_AVAILABLE = process.platform !== 'win32' && existsSync(getRgPath())
const CAN_LOCK = RG_AVAILABLE && process.getuid?.() !== 0

const REJECTED = 'The search was not run — ripgrep rejected it:'
/** 转义提示里点名的字符与例子（只在 regex parse error 时出现） */
const ESCAPE_HINT =
  '`pattern` is a regular expression: escape ( ) [ ] { } . * + ? | ^ $ \\ to match them literally (for example `recordRead\\(`).'

const ctx: ToolContext = { sessionId: 'grep-test-session' }
let callSeq = 0
const grep = (args: {
  pattern: string
  path?: string
  include?: string
}): Promise<InvokedToolResult> => executeTool(new GrepTool(ctx), `g${++callSeq}`, args)

let locked: string[] = []

function write(rel: string, content: string): void {
  const p = join(state.dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

function lock(rel: string): void {
  const p = join(state.dir, rel)
  chmodSync(p, 0o000)
  locked.push(p)
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-grep-tool-'))
  locked = []
})

afterEach(() => {
  for (const p of locked) {
    try {
      chmodSync(p, 0o755)
    } catch {
      /* 已经不在了 */
    }
  }
  locked = []
  if (state.dir) rmSync(state.dir, { recursive: true, force: true })
  state.dir = ''
})

describe('searchRejectedMessage —— rg 的话原样附上，转义提示只给正则错误（GR-3）', () => {
  it('GR-3 regex parse error（含大小写不同的写法）→ rg 原文 + 转义提示；glob 错误 → rg 原文、不带提示', () => {
    const regex = 'rg: regex parse error:\n    (?:x()\n    ^\nerror: unclosed group'
    const shouty = 'rg: Regex Parse Error: something odd'
    const glob = "rg: error parsing glob '[a': unclosed character class; missing ']'"

    for (const rg of [regex, shouty]) {
      const text = searchRejectedMessage(rg)
      expect(text.startsWith(REJECTED), rg).toBe(true)
      expect(text, rg).toContain(rg)
      expect(text, rg).toContain(ESCAPE_HINT)
    }

    const text = searchRejectedMessage(glob)
    expect(text.startsWith(REJECTED)).toBe(true)
    expect(text).toContain(glob)
    expect(text).not.toContain('regular expression')
    expect(text).not.toContain('escape')
  })
})

describe.skipIf(!RG_AVAILABLE)(
  'grep 工具 —— rg 拒绝执行 = 失败，不是零命中（GR-2 / GR-4 / GR-5）',
  () => {
    it('GR-2 `recordRead(` 搜整个工作目录、以及只搜 src/a.ts（单文件分支：cwd = 父目录、target = 文件名）都失败，带 rg 的 unclosed group 与转义提示', async () => {
      write('src/a.ts', 'recordRead(x)\n')

      for (const args of [
        { pattern: 'recordRead(' },
        { pattern: 'recordRead(', path: 'src/a.ts' }
      ]) {
        const what = JSON.stringify(args)
        const text = await failureText(grep(args))
        expect(text.startsWith(REJECTED), what).toBe(true)
        expect(text, what).toContain('unclosed group')
        expect(text, what).toContain(ESCAPE_HINT)
        expect(text, what).not.toContain('No matches found')
      }
    })

    it("GR-4 include '[a' → 失败，带 rg 的 error parsing glob、不带正则转义提示；不说 No matches found", async () => {
      write('a.ts', 'needle\n')

      const text = await failureText(grep({ pattern: 'needle', include: '[a' }))

      expect(text.startsWith(REJECTED)).toBe(true)
      expect(text).toContain('error parsing glob')
      expect(text).not.toContain(ESCAPE_HINT)
      expect(text).not.toContain('regular expression')
      expect(text).not.toContain('No matches found')
    })

    it('GR-5 rg 不接受的常见写法（反向引用、环视、未知 Unicode 属性、字面换行）：每个都失败、带 rg 自己的解释', async () => {
      write('a.txt', 'aa foo bar\n')

      const cases: { pattern: string; says: RegExp }[] = [
        { pattern: '(a)\\1', says: /backreferences are not supported/ },
        { pattern: 'foo(?=bar)', says: /look-around/ },
        { pattern: '\\p{Nope}', says: /Unicode property not found/ }
      ]
      for (const { pattern, says } of cases) {
        const text = await failureText(grep({ pattern }))
        expect(text.startsWith(REJECTED), pattern).toBe(true)
        expect(text, pattern).toMatch(says)
        expect(text, pattern).toContain(ESCAPE_HINT)
        expect(text, pattern).not.toContain('No matches found')
      }

      // 字面换行：rg 的说明是「不许出现在正则里，试试 --multiline」，不是 regex parse error → 不带转义提示
      const text = await failureText(grep({ pattern: 'a\nb' }))
      expect(text.startsWith(REJECTED)).toBe(true)
      expect(text).toMatch(/not allowed in a regex/)
      expect(text).toContain('--multiline')
      expect(text).not.toContain(ESCAPE_HINT)
      expect(text).not.toContain('No matches found')
    })
  }
)

describe.skipIf(!CAN_LOCK)('grep 工具 —— 读不了的目录不让别处的结果作废（GR-6）', () => {
  it('GR-6 ok/a.ts 与 chmod 000 的 locked/b.ts：成功、Found 1 matches、只列 ok/a.ts（rg 此时退出 2）', async () => {
    write('ok/a.ts', 'needle\n')
    write('locked/b.ts', 'needle\n')
    lock('locked')

    const result = await grep({ pattern: 'needle' })

    expect(result.isError).not.toBe(true)
    const text = resultText(result)
    expect(text.startsWith('Found 1 matches')).toBe(true)
    expect(text).toContain('ok/a.ts:')
    expect(text).toContain('  Line 1: needle')
    expect(text).not.toContain('locked')
    expect(result.details).toMatchObject({ type: 'grep', matches: 1, truncated: false })
  })
})

describe.skipIf(!RG_AVAILABLE)('grep 工具 —— 合法模式零命中仍是 No matches found（GR-7）', () => {
  it('GR-7a 干净目录（rg 退出 1）：No matches found，details { matches: 0, truncated: false }', async () => {
    write('a.txt', 'hello\n')

    const result = await grep({ pattern: 'zzzz' })

    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toBe('No matches found')
    expect(result.details).toMatchObject({ matches: 0, truncated: false })
  })

  it.skipIf(!CAN_LOCK)(
    'GR-7b 外加一个 chmod 000 的目录（rg 退出 2、--no-messages 下 stderr 为空）：同样是 No matches found，不是拒绝',
    async () => {
      write('a.txt', 'hello\n')
      mkdirSync(join(state.dir, 'locked'))
      lock('locked')

      // 对照：同样的参数直接跑 rg —— 真是退出 2 且 stderr 空（否则这条用例没走到要钉的那条分支）
      const raw = spawnSync(
        getRgPath(),
        ['-nH', '--hidden', '--no-messages', '--regexp', 'zzzz', '--', '.'],
        {
          cwd: state.dir,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      expect(raw.status).toBe(2)
      expect(raw.stderr).toBe('')

      const result = await grep({ pattern: 'zzzz' })

      expect(result.isError).not.toBe(true)
      expect(resultText(result)).toBe('No matches found')
      expect(result.details).toMatchObject({ matches: 0, truncated: false })
    }
  )
})
