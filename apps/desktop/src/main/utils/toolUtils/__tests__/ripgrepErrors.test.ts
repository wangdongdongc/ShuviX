/**
 * rg 拒绝执行 ≠ 没有匹配（真实 rg，POSIX）—— 钉 rgSearch 与文件列举对 rg 报错的两种口径。
 *
 * 内容搜索（rgSearch，grep 工具用）：rg 退出 2 且 stderr 有话、一行结果都没有时抛 RgUsageError，
 * message 是 rg 自己的说明（封顶 2048 字符）。旧代码把这些一律收成 `{ matches: [] }` —— 写错的正则
 * `recordRead(` 被读成「没有调用者」。但退出 2 不全是拒绝：有目录读不了时 rg 也退出 2，此时
 * 别处的结果照样有效（GR-6）；`--no-messages` 下 stderr 为空，零命中仍是零命中（见 grep.test.ts GR-7）。
 *
 * 文件列举（rgFiles / rgFilesList：文件面板、知识库扫描、技能目录）不报错：一个读不了的文件夹只是
 * 「少几个文件」，写坏的 glob 也只是空列表（LS-4 / LS-6）。但 stderr 现在是 'pipe' 而不是 'ignore'，
 * 所以必须一直读走 —— 写满 64 KB 的管道会把 rg 卡住、列举永不结束（LS-5，带对照：先证明这个夹具的
 * stderr 真的超过 64 KB）。
 *
 * 取消（GR-10）：预先取消的信号在 spawn 之前就抛 AbortError；在 rg 还没写出任何 stdout 时取消
 * （读一个没人写的 FIFO 时阻塞）—— 现状会 resolve 成空结果，grep 工具于是对一次被取消的搜索说
 * 「No matches found」。那一条是已知产品缺陷，标 skip、写明原因（修法：stdout 循环之后
 * `signal?.throwIfAborted()`）。
 *
 * rg 二进制来自 @vscode/ripgrep；Windows 或二进制缺席时整组跳过。chmod 000 的用例在 root 下没意义
 * （root 读得了），也跳过；权限在 afterEach 里先还原再删目录。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRgPath, rgFiles, rgFilesList, rgSearch, RgUsageError } from '../ripgrep'

const RG_AVAILABLE = process.platform !== 'win32' && existsSync(getRgPath())
/** chmod 000 真的挡得住读：不是 Windows、也不是 root */
const CAN_LOCK = RG_AVAILABLE && process.getuid?.() !== 0

let dir = ''
/** chmod 000 过的目录 —— afterEach 先还原权限，rmSync 才删得掉 */
let locked: string[] = []

function write(rel: string, content: string): void {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

function lock(rel: string): void {
  const p = join(dir, rel)
  chmodSync(p, 0o000)
  locked.push(p)
}

/** 抛出的那个值（没抛 → undefined） */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
  } catch (err) {
    return err
  }
  return undefined
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-rg-errors-'))
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
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe.skipIf(!RG_AVAILABLE)(
  'rgSearch —— rg 拒绝执行时抛 RgUsageError（GR-1 / GR-4 / GR-11）',
  () => {
    it('GR-1 写错的正则 `recordRead(` → RgUsageError，message 是 rg 自己的 regex parse error / unclosed group', async () => {
      write('a.ts', 'recordRead(x)\n')

      const err = await rejection(rgSearch({ cwd: dir, pattern: 'recordRead(' }))

      expect(err).toBeInstanceOf(RgUsageError)
      expect((err as Error).name).toBe('RgUsageError')
      expect((err as Error).message.startsWith('rg: regex parse error')).toBe(true)
      expect((err as Error).message).toContain('unclosed group')
    })

    it("GR-4 写坏的 include glob（'[a' / '{a'）→ RgUsageError，message 带 error parsing glob；不是空结果", async () => {
      write('a.ts', 'needle\n')

      for (const include of ['[a', '{a']) {
        const err = await rejection(rgSearch({ cwd: dir, pattern: 'needle', include }))
        expect(err, include).toBeInstanceOf(RgUsageError)
        expect((err as Error).message, include).toContain('error parsing glob')
      }
    })

    it('GR-11 rg 的说明很长（约 5 KB）时：交出去的 message 仍以 rg: regex parse error 开头、不超过 2048 字符', async () => {
      write('a.txt', 'hello\n')
      const pattern = 'x'.repeat(5000) + '('

      // 对照：同一个模式直接跑 rg，stderr 确实超过上限（否则这条用例什么也没钉住）
      const raw = spawnSync(getRgPath(), ['--regexp', pattern, '--', '.'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      expect(raw.status).toBe(2)
      expect(raw.stderr.length).toBeGreaterThan(2048)

      const err = await rejection(rgSearch({ cwd: dir, pattern }))

      expect(err).toBeInstanceOf(RgUsageError)
      expect((err as Error).message.startsWith('rg: regex parse error')).toBe(true)
      expect((err as Error).message.length).toBeLessThanOrEqual(2048)
    })
  }
)

describe.skipIf(!CAN_LOCK)('rgSearch —— 有目录读不了时别处的结果照样交回（GR-6）', () => {
  it('GR-6 ok/a.ts 与 chmod 000 的 locked/b.ts 都有 needle → 恰好一条 ok/a.ts:1（rg 此时退出 2，但不是拒绝）', async () => {
    write('ok/a.ts', 'needle\n')
    write('locked/b.ts', 'needle\n')
    lock('locked')

    const result = await rgSearch({ cwd: dir, pattern: 'needle' })

    expect(result).toEqual({
      matches: [{ path: 'ok/a.ts', lineNum: 1, lineText: 'needle' }],
      truncated: false
    })
  })
})

describe.skipIf(!RG_AVAILABLE)('rgSearch —— 取消（GR-10）', () => {
  it('GR-10a 预先取消的信号 → AbortError（不是 RgUsageError，也不是空结果）', async () => {
    write('a.txt', 'x\n')
    const controller = new AbortController()
    controller.abort()

    const err = await rejection(rgSearch({ cwd: dir, pattern: 'x', signal: controller.signal }))

    expect(err).toBeDefined()
    expect((err as Error).name).toBe('AbortError')
    expect(err).not.toBeInstanceOf(RgUsageError)
  })

  // 取消落在 rg 写出任何 stdout 之前：stdout 循环一轮都没进，循环里的取消检查也就没跑；进程被杀后
  // close 的退出码是 null（不是 2），reportErrors 也不抛 —— 循环之后那一句检查不在，rgSearch 就会
  // resolve 成 { matches: [], truncated: false }，grep 工具对一次被取消的搜索报「No matches found」
  it('GR-10b rg 阻塞在一个没人写的 FIFO 上、约 200 ms 后取消 → AbortError，rg 进程随之结束', async () => {
    const fifo = join(dir, 'p')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    // 独一无二的模式：pgrep -f 凭它认出这次的 rg 进程
    const pattern = `shuvix-gr10-${process.pid}-${Date.now()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 200)
    try {
      const err = await rejection(
        rgSearch({ cwd: dir, target: 'p', pattern, signal: controller.signal })
      )
      expect(err).toBeDefined()
      expect((err as Error).name).toBe('AbortError')
      expect(err).not.toBeInstanceOf(RgUsageError)

      let alive = true
      for (let i = 0; i < 20 && alive; i++) {
        alive = spawnSync('pgrep', ['-f', pattern]).status === 0
        if (alive) await new Promise((r) => setTimeout(r, 50))
      }
      expect(alive).toBe(false)
    } finally {
      clearTimeout(timer)
      // rg 若还挂在 FIFO 上（用例失败时）：杀掉它，别让它留在后台
      spawnSync('pkill', ['-f', pattern])
    }
  }, 10_000)
})

describe.skipIf(!CAN_LOCK)('文件列举 —— 读不了的目录照旧只是少几个文件（LS-4 / LS-5）', () => {
  it('LS-4 ok.txt 与 chmod 000 的 locked/z.txt：rgFilesList 与逐个迭代 rgFiles 都不抛，恰好 [ok.txt]', async () => {
    write('ok.txt', 'ok\n')
    write('locked/z.txt', 'z\n')
    lock('locked')

    expect(await rgFilesList({ cwd: dir })).toEqual({ files: ['ok.txt'], truncated: false })

    const iterated: string[] = []
    for await (const file of rgFiles({ cwd: dir })) iterated.push(file)
    expect(iterated).toEqual(['ok.txt'])
  })

  it('LS-5 两千个 chmod 000 子目录（stderr 远超 64 KB 的 Permission denied）：列举照样在几秒内结束，回 [ok.txt]', async () => {
    write('ok.txt', 'ok\n')
    for (let i = 0; i < 2000; i++) {
      const name = `locked-directory-${String(i).padStart(4, '0')}`
      mkdirSync(join(dir, name))
      lock(name)
    }

    // 对照：rgFiles 不带 --no-messages，这个夹具让 rg 的 stderr 超过一个管道缓冲（64 KB）——
    // 不读走 stderr 时 rg 会卡在写上
    const raw = spawnSync(getRgPath(), ['--files', '--hidden'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    })
    expect(raw.stderr).toContain('Permission denied')
    expect(Buffer.byteLength(raw.stderr)).toBeGreaterThan(64 * 1024)

    const started = Date.now()
    expect(await rgFilesList({ cwd: dir })).toEqual({ files: ['ok.txt'], truncated: false })
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)
})

describe.skipIf(!RG_AVAILABLE)('文件列举 —— 写坏的 glob 不报错（LS-6）', () => {
  it("LS-6 glob ['[a'] → { files: [], truncated: false }，不抛（只有内容搜索报 rg 的错）", async () => {
    write('a.md', '# a\n')

    expect(await rgFilesList({ cwd: dir, glob: ['[a'] })).toEqual({ files: [], truncated: false })
  })
})
