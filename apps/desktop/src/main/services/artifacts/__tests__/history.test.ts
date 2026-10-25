/**
 * 会话产物的版本历史（services/artifacts/history.ts）—— 真实临时目录 + 真实 isomorphic-git，只把
 * `getSessionArtifactsDir` 指到 tmp；`artifacts.changed` 从真实的 appEventBus 上订阅；提交用系统 git 读回
 * （与 gitOps.test 同一个做法：别拿被测实现读自己写的东西）。
 *
 *   AH-1  目录不在：prepare / record / stats 都是空操作，不建目录、不发事件
 *   AH-2  这次调用新建的目录：一次提交（署名 `ShuviX <artifacts@shuvix.local>`、标题 `artifact: a.svg`、
 *         trailer `Tool-Call-Id` + 毫秒 `Recorded-At`），一个事件
 *   AH-3  升级前的旧目录（2 个文件）：prepare 提交一版基线（不发事件、没有 Recorded-At）；改一个 + record →
 *         第二版只含它；stats：改过的 2 版、没改的 1 版，**只有基线那一版的 updatedAt 是 0**（清单回落 mtime）
 *   AH-4  已有第一个提交：再 prepare 不再提交
 *   AH-5  两个并行的 prepare：只有一版基线
 *   AH-6  没变化连 record 两次：1 次提交 1 个事件；模块重载（签名缓存丢了）后干净目录上 record：不提交、不发事件
 *   AH-7  删掉一件 + record：一版 D 提交 + 事件
 *   AH-8  删掉又建回同名的一件：版本数只算新的这一段（1）
 *   AH-9  两个文件、两次 record 并行（Promise.all）：不 reject，≤2 次提交，事件数 ≤ 提交数，HEAD 两件都在，工作区干净
 *   AH-10 不安全的会话 id（`''`、`..`、`a/b`、`../x`）：照常 resolve，什么都不碰，stats 为空
 *   AH-11 git 出错绝不抛（`.git` 是个普通文件）：resolve、记 warn、不发事件；修好之后下一次 record 照常提交
 *   AH-12 7 个文件：标题列 5 个 + `(+2)`；工具名为空 → `tool: …`
 *   AH-13 同一秒里两版：updatedAt 取后一版的 Recorded-At（毫秒），不是 git 的整秒作者时间
 *   AH-14 stats → 提交 → stats：历史缓存在提交处作废，新的一版数得到
 *   AH-15 空的旧目录：prepare 只 init、不提交；第一次写 + record → 1 次提交 + 事件
 *   AH-16 init 成功但没有第一个提交（`.git` 在、分支 ref 不在、文件在）：下一次 prepare 补上基线
 *         （AH-16b 是它的一个变体 —— 文件已经暂存 —— 产品现状不符，暂时 skip，见那条用例）
 *
 * 引用钉版本用的 blob 两个入口（storeArtifactBlob / readArtifactBlob，pins.ts 调）：
 *   HB-1  目录不在 / 不安全的会话 id：store → null，什么都不建；read → null
 *   HB-2  目录在、还不是仓库：store 先 init、只进对象库**不提交**、不发事件；之后的 prepare 照样提交基线
 *   HB-3  store 与 record 在同一目录上并发（串行队列）：两个都成，blob 读得回、提交一版、一个事件
 *   HB-4  read：没有仓库 → null；松散对象被删了 → null；有的照原样读回（unicode / CRLF）
 *
 * 模块级的表（串行队列、目录签名、历史缓存）每条用例都要清零：`vi.resetModules()` 之后重新 import
 * history 与 appEventBus（总线也是模块单例，重载之后要订新的那个）。
 *
 * 顶桩纪律同 store.test：漏顶 `getSessionArtifactsDir` 的表现是往真实 home 写盘、建仓库，所以文件末尾
 * 有一道真实 home 哨兵。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import { addOp, initOp, type GitFsClient } from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({ root: '', warns: [] as string[] }))

// 纯 factory，不走 importActual：utils/paths 顶层 `import { app } from 'electron'`
vi.mock('../../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (msg: string) => {
      state.warns.push(String(msg))
    }
  })
}))

type HistoryModule = typeof import('../history')

let history: HistoryModule
let events: AppEvent[]
let unsubscribe: (() => void) | undefined

/** 清零模块级的表，重新 import，并订阅新的那条总线 */
async function reload(): Promise<void> {
  unsubscribe?.()
  vi.resetModules()
  history = await import('../history')
  const { appEventBus } = await import('../../../utils/appEventBus')
  events = []
  const off = appEventBus.subscribe((e) => {
    events.push(e)
  })
  unsubscribe = () => {
    off()
  }
}

const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

let seq = 0
const newSession = (): string => `h${++seq}`
const dirOf = (sid: string): string => join(state.root, sid)

/** 在会话目录里写一个文件（目录不在就建） */
function put(sid: string, name: string, content: string): void {
  mkdirSync(dirOf(sid), { recursive: true })
  writeFileSync(join(dirOf(sid), name), content, 'utf-8')
}

/** 系统 git（只读用；固定身份免得宿主机的全局配置掺进来） */
function git(dir: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', '-C', dir, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

interface Commit {
  oid: string
  author: string
  subject: string
  body: string
  /** 作者时间（秒） */
  authorSec: number
}

/** 目录里的提交（新的在前）；不是仓库或一个提交都没有 → [] */
function commits(dir: string): Commit[] {
  if (!existsSync(join(dir, '.git'))) return []
  let out: string
  try {
    out = git(dir, ['log', '--format=%H%x1f%an <%ae>%x1f%at%x1f%s%x1f%b%x1e'])
  } catch {
    return []
  }
  return out
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [oid, author, at, subject, body] = rec.split('\x1f')
      return { oid, author, subject, body: body.trim(), authorSec: Number(at) }
    })
}

/** 某个提交相对父提交的 name-status（`A\ta.svg` …，按路径排） */
function nameStatus(dir: string, rev = 'HEAD'): string[] {
  return git(dir, ['show', '--name-status', '--format=', rev])
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => a.split('\t')[1].localeCompare(b.split('\t')[1]))
}

const changed = (sid: string): AppEvent => ({ type: 'artifacts.changed', sessionIds: [sid] })

const statsObject = async (sid: string): Promise<Record<string, unknown>> =>
  Object.fromEntries(await history.artifactVersionStats(sid))

beforeAll(() => {
  homeBefore = homeSnapshot()
  state.root = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-artifact-history-'))),
    'artifacts'
  )
  mkdirSync(state.root, { recursive: true })
})

beforeEach(async () => {
  state.warns = []
  await reload()
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  unsubscribe?.()
  // 哨兵：整个文件跑完，真实 home 的内容必须与开跑前逐项相等
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

/** 系统 git 读一个 blob（不经被测实现） */
const catBlob = (dir: string, oid: string): string => git(dir, ['cat-file', 'blob', oid])

describe('prepareArtifactHistory / recordArtifactChange —— 每次工具调用前后', () => {
  it('AH-1 目录不在：三个入口都是空操作，不建目录、不发事件', async () => {
    const sid = newSession()
    await history.prepareArtifactHistory(sid)
    await history.recordArtifactChange(sid, { toolName: 'bash', callId: 'c1' })
    expect((await history.artifactVersionStats(sid)).size).toBe(0)
    expect(existsSync(dirOf(sid))).toBe(false)
    expect(events).toEqual([])
    expect(state.warns).toEqual([])
  })

  it('AH-2 这次调用新建的目录：一次提交（宿主署名、`artifact: a.svg`、两条 trailer），一个事件', async () => {
    const sid = newSession()
    // 执行之前目录还不在 → 没有基线
    await history.prepareArtifactHistory(sid)
    expect(existsSync(dirOf(sid))).toBe(false)

    put(sid, 'a.svg', '<svg aria-label="A"/>')
    const before = Date.now()
    await history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'call_1' })
    const after = Date.now()

    const log = commits(dirOf(sid))
    expect(log).toHaveLength(1)
    expect(log[0].author).toBe('ShuviX <artifacts@shuvix.local>')
    expect(log[0].subject).toBe('artifact: a.svg')
    expect(log[0].body).toContain('Tool-Call-Id: call_1')
    const at = /^Recorded-At: (.+)$/m.exec(log[0].body)?.[1]
    expect(at, log[0].body).toBeDefined()
    // 毫秒精度的 ISO 时间（git 作者时间只到秒，同一秒里的两版靠它排先后）
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    const ms = Date.parse(at!)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
    expect(nameStatus(dirOf(sid))).toEqual(['A\ta.svg'])

    expect(events).toEqual([changed(sid)])
    expect(await statsObject(sid)).toEqual({ 'a.svg': { versions: 1, updatedAt: ms } })
  })

  it('AH-3 旧目录：基线一版（不发事件、没有 Recorded-At）；改一件只提交它；只有基线那一版的 updatedAt 是 0', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg aria-label="A"/>')
    put(sid, 'b.md', '# B')

    await history.prepareArtifactHistory(sid)
    let log = commits(dirOf(sid))
    expect(log).toHaveLength(1)
    expect(log[0].subject).toMatch(/^Baseline: /)
    expect(log[0].author).toBe('ShuviX <artifacts@shuvix.local>')
    expect(log[0].body).not.toMatch(/Recorded-At/)
    expect(nameStatus(dirOf(sid))).toEqual(['A\ta.svg', 'A\tb.md'])
    expect(events).toEqual([])

    // 这次调用改了其中一件（换个长度：签名按大小 + mtime 认）
    put(sid, 'a.svg', '<svg aria-label="A"><rect/></svg>')
    await history.recordArtifactChange(sid, { toolName: 'edit', callId: 'call_e' })
    log = commits(dirOf(sid))
    expect(log).toHaveLength(2)
    expect(log[0].subject).toBe('edit: a.svg')
    expect(nameStatus(dirOf(sid))).toEqual(['M\ta.svg'])
    expect(events).toEqual([changed(sid)])

    const recorded = Date.parse(/^Recorded-At: (.+)$/m.exec(log[0].body)![1])
    expect(await statsObject(sid)).toEqual({
      'a.svg': { versions: 2, updatedAt: recorded },
      // 只有基线：时间交回 0，由清单回落到文件的 mtime
      'b.md': { versions: 1, updatedAt: 0 }
    })
  })

  it('AH-4 已经有第一个提交：再 prepare 不再提交', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    await history.prepareArtifactHistory(sid)
    expect(commits(dirOf(sid))).toHaveLength(1)
    // 文件又变了也不归 prepare 管（那是 record 的事）
    put(sid, 'a.svg', '<svg><g/></svg>')
    await history.prepareArtifactHistory(sid)
    await history.prepareArtifactHistory(sid)
    expect(commits(dirOf(sid))).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('AH-5 两个并行的 prepare：只有一版基线', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    put(sid, 'b.svg', '<svg/>')
    await Promise.all([history.prepareArtifactHistory(sid), history.prepareArtifactHistory(sid)])
    const log = commits(dirOf(sid))
    expect(log).toHaveLength(1)
    expect(log[0].subject).toMatch(/^Baseline: /)
    expect(events).toEqual([])
  })

  it('AH-6 没变化连 record 两次：1 次提交 1 个事件；签名缓存丢了之后干净目录上 record：不提交、不发事件', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    await history.recordArtifactChange(sid, { toolName: 'write', callId: 'c1' })
    await history.recordArtifactChange(sid, { toolName: 'read', callId: 'c2' })
    expect(commits(dirOf(sid))).toHaveLength(1)
    expect(events).toEqual([changed(sid)])

    // 重启：签名与历史缓存都在内存里，没了 —— 走一遍 add，干净则什么都不提交
    await reload()
    await history.recordArtifactChange(sid, { toolName: 'read', callId: 'c3' })
    expect(commits(dirOf(sid))).toHaveLength(1)
    expect(events).toEqual([])
    expect(state.warns).toEqual([])
  })

  it('AH-7 删掉一件 + record：一版 D 提交 + 事件', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    put(sid, 'b.md', '# B')
    await history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    events.length = 0

    rmSync(join(dirOf(sid), 'b.md'))
    await history.recordArtifactChange(sid, { toolName: 'bash', callId: 'c2' })
    const log = commits(dirOf(sid))
    expect(log).toHaveLength(2)
    expect(log[0].subject).toBe('bash: b.md')
    expect(nameStatus(dirOf(sid))).toEqual(['D\tb.md'])
    expect(events).toEqual([changed(sid)])
    expect([...(await history.artifactVersionStats(sid)).keys()]).toEqual(['a.svg'])
  })

  it('AH-8 删掉又建回同名的一件：版本数只算新的这一段', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    await history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    put(sid, 'a.svg', '<svg><g/></svg>')
    await history.recordArtifactChange(sid, { toolName: 'edit', callId: 'c2' })
    expect((await history.artifactVersionStats(sid)).get('a.svg')?.versions).toBe(2)

    rmSync(join(dirOf(sid), 'a.svg'))
    await history.recordArtifactChange(sid, { toolName: 'bash', callId: 'c3' })
    expect((await history.artifactVersionStats(sid)).has('a.svg')).toBe(false)

    put(sid, 'a.svg', '<svg aria-label="new life"/>')
    await history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'c4' })
    expect(commits(dirOf(sid))).toHaveLength(4)
    expect((await history.artifactVersionStats(sid)).get('a.svg')?.versions).toBe(1)
  })

  it('AH-9 两次 record 并行：不 reject，≤2 次提交，事件数 ≤ 提交数，HEAD 两件都在，工作区干净', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    const first = history.recordArtifactChange(sid, { toolName: 'write', callId: 'c1' })
    put(sid, 'b.svg', '<svg/>')
    const second = history.recordArtifactChange(sid, { toolName: 'write', callId: 'c2' })
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])

    const log = commits(dirOf(sid))
    expect(log.length).toBeGreaterThanOrEqual(1)
    expect(log.length).toBeLessThanOrEqual(2)
    expect(events.length).toBeLessThanOrEqual(log.length)
    expect(events.every((e) => JSON.stringify(e) === JSON.stringify(changed(sid)))).toBe(true)
    expect(git(dirOf(sid), ['ls-tree', '--name-only', 'HEAD']).split('\n').filter(Boolean)).toEqual(
      ['a.svg', 'b.svg']
    )
    expect(git(dirOf(sid), ['status', '--porcelain']).trim()).toBe('')
    expect(state.warns).toEqual([])
  })

  it('AH-10 不安全的会话 id：照常 resolve，什么都不碰，stats 为空', async () => {
    // 各自解析到的目录里事先放好文件：守卫要是漏了，那里就会长出一个 .git
    const parent = join(state.root, '..')
    writeFileSync(join(parent, 'outside.txt'), 'x')
    put('a/b', 'nested.svg', '<svg/>')
    mkdirSync(join(parent, 'x'), { recursive: true })
    writeFileSync(join(parent, 'x', 'sibling.svg'), '<svg/>')
    writeFileSync(join(state.root, 'root-level.svg'), '<svg/>')
    const snapshot = (): string[] =>
      [state.root, parent, join(state.root, 'a', 'b'), join(parent, 'x')].map((d) =>
        readdirSync(d).sort().join(',')
      )
    const before = snapshot()

    for (const id of ['', '..', 'a/b', '../x']) {
      await expect(history.prepareArtifactHistory(id), id).resolves.toBeUndefined()
      await expect(
        history.recordArtifactChange(id, { toolName: 'bash', callId: 'c' }),
        id
      ).resolves.toBeUndefined()
      expect((await history.artifactVersionStats(id)).size, id).toBe(0)
    }

    expect(snapshot()).toEqual(before)
    for (const d of [state.root, parent, join(state.root, 'a', 'b'), join(parent, 'x')]) {
      expect(existsSync(join(d, '.git')), d).toBe(false)
    }
    expect(events).toEqual([])

    rmSync(join(parent, 'outside.txt'))
    rmSync(join(parent, 'x'), { recursive: true })
    rmSync(join(state.root, 'a'), { recursive: true })
    rmSync(join(state.root, 'root-level.svg'))
  })

  // `.git` 是普通文件时 isomorphic-git 把它当 gitdir 指针读（取第 9 个字符起的内容，相对目录拼路径）：
  // 内容写成随便一句话，它会在产物目录里按那半句话建一个子目录、把 index 和对象写进去 —— 于是这里
  // 让指针指进一个**文件**下面，任何写入都是 ENOTDIR，失败干干净净，不往目录里留东西。
  it.each([
    [
      '`.git` 是普通文件（指针指不到可写处）',
      (dir: string): void => writeFileSync(join(dir, '.git'), 'gitdir: a.svg/not-a-dir\n')
    ],
    [
      '`.git/index` 被写坏',
      (dir: string): void => {
        mkdirSync(join(dir, '.git'), { recursive: true })
        writeFileSync(join(dir, '.git', 'index'), 'garbage, not a dircache')
      }
    ]
  ])(
    'AH-11 git 出错绝不抛（%s）：resolve、记 warn、不发事件；修好之后 record 照常提交',
    async (_label, breakRepo) => {
      const sid = newSession()
      put(sid, 'a.svg', '<svg/>')
      breakRepo(dirOf(sid))

      await expect(history.prepareArtifactHistory(sid)).resolves.toBeUndefined()
      await expect(
        history.recordArtifactChange(sid, { toolName: 'write', callId: 'c1' })
      ).resolves.toBeUndefined()
      await expect(history.artifactVersionStats(sid)).resolves.toEqual(new Map())
      expect(state.warns.length).toBeGreaterThan(0)
      expect(events).toEqual([])
      expect(readdirSync(dirOf(sid)).sort()).toEqual(['.git', 'a.svg'])

      // 修好（坏掉的 `.git` 拿掉）：失败那次没记签名，所以下一次 record 不会被「没变」短路
      rmSync(join(dirOf(sid), '.git'), { recursive: true, force: true })
      await history.recordArtifactChange(sid, { toolName: 'write', callId: 'c2' })
      const log = commits(dirOf(sid))
      expect(log).toHaveLength(1)
      expect(log[0].subject).toBe('write: a.svg')
      expect(events).toEqual([changed(sid)])
    }
  )

  it('AH-12 7 个文件：标题列 5 个 + `(+2)`；工具名为空 → `tool: …`', async () => {
    const sid = newSession()
    for (const n of ['g', 'f', 'e', 'd', 'c', 'b', 'a']) put(sid, `${n}.txt`, n)
    await history.recordArtifactChange(sid, { toolName: 'bash', callId: 'c1' })
    expect(commits(dirOf(sid))[0].subject).toBe('bash: a.txt, b.txt, c.txt, d.txt, e.txt (+2)')

    put(sid, 'a.txt', 'aa')
    await history.recordArtifactChange(sid, { toolName: '', callId: 'c2' })
    expect(commits(dirOf(sid))[0].subject).toBe('tool: a.txt')
  })

  it('AH-13 同一秒里两版：updatedAt 取后一版的 Recorded-At（毫秒）', async () => {
    const sid = newSession()
    // 只假 Date：git 的作者时间与 Recorded-At 都从它取；定时器照真的走（isomorphic-git 要用）
    vi.useFakeTimers({ toFake: ['Date'] })
    const T0 = Date.UTC(2026, 9, 24, 10, 0, 0)
    vi.setSystemTime(T0 + 100)
    put(sid, 'a.svg', '<svg/>')
    await history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    vi.setSystemTime(T0 + 700)
    put(sid, 'a.svg', '<svg><rect/></svg>')
    await history.recordArtifactChange(sid, { toolName: 'edit', callId: 'c2' })

    const log = commits(dirOf(sid))
    expect(log).toHaveLength(2)
    // git 自己分不出先后：两版的作者时间是同一秒
    expect(log[0].authorSec).toBe(log[1].authorSec)
    expect(await statsObject(sid)).toEqual({ 'a.svg': { versions: 2, updatedAt: T0 + 700 } })
  })

  it('AH-14 stats → 提交 → stats：新的一版数得到（历史缓存在提交处作废）', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    await history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    expect((await history.artifactVersionStats(sid)).get('a.svg')?.versions).toBe(1)

    put(sid, 'a.svg', '<svg><g/></svg>')
    await history.recordArtifactChange(sid, { toolName: 'edit', callId: 'c2' })
    expect((await history.artifactVersionStats(sid)).get('a.svg')?.versions).toBe(2)
  })

  it('AH-15 空的旧目录：prepare 只 init 不提交；第一次写 + record → 1 次提交 + 事件', async () => {
    const sid = newSession()
    mkdirSync(dirOf(sid), { recursive: true })
    await history.prepareArtifactHistory(sid)
    expect(existsSync(join(dirOf(sid), '.git'))).toBe(true)
    expect(commits(dirOf(sid))).toEqual([])
    expect(events).toEqual([])

    put(sid, 'a.svg', '<svg/>')
    await history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    const log = commits(dirOf(sid))
    expect(log).toHaveLength(1)
    expect(log[0].subject).toBe('artifact: a.svg')
    expect(events).toEqual([changed(sid)])
  })

  it('AH-16 init 成功但没有第一个提交（`.git` 在、分支 ref 不在、文件在）：下一次 prepare 补上基线', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    put(sid, 'b.md', '# B')
    // 上一回只走到 init（基线提交失败 / 进程在中间退出）
    const out = await initOp({ fs: nodeFs as unknown as GitFsClient, dir: dirOf(sid) }, {}, {})
    expect(out.details?.error).toBeUndefined()
    expect(existsSync(join(dirOf(sid), '.git'))).toBe(true)
    expect(existsSync(join(dirOf(sid), '.git', 'refs', 'heads', 'main'))).toBe(false)

    await history.prepareArtifactHistory(sid)
    const log = commits(dirOf(sid))
    expect(log).toHaveLength(1)
    expect(log[0].subject).toMatch(/^Baseline: /)
    expect(nameStatus(dirOf(sid))).toEqual(['A\ta.svg', 'A\tb.md'])
    expect(existsSync(join(dirOf(sid), '.git', 'refs', 'heads', 'main'))).toBe(true)
    expect(events).toEqual([])
  })

  // 上一回 add 成功、commit 没走到（进程在两步之间退出）时，文件已在暂存区：addOp 的 `.` 展开不再报它
  // （details.paths 为空），只有 commit 看得见 —— commitAll 因此暂存为空也照样去提交。
  it('AH-16b add 成功、commit 没走到（文件已暂存）：下一次 prepare 补上基线', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    const env = { fs: nodeFs as unknown as GitFsClient, dir: dirOf(sid) }
    await initOp(env, {}, {})
    const added = await addOp(env, {}, { paths: ['.'] })
    expect(added.details?.paths).toEqual(['a.svg'])

    await history.prepareArtifactHistory(sid)
    const log = commits(dirOf(sid))
    expect(log, git(dirOf(sid), ['status', '--porcelain'])).toHaveLength(1)
    expect(log[0].subject).toMatch(/^Baseline: /)
    expect(git(dirOf(sid), ['status', '--porcelain']).trim()).toBe('')
  })
})

describe('storeArtifactBlob / readArtifactBlob —— 引用钉版本的内容', () => {
  it('HB-1 目录不在 / 不安全的会话 id：store → null，什么都不建；read → null', async () => {
    const sid = newSession()
    await expect(history.storeArtifactBlob(sid, '<svg/>')).resolves.toBeNull()
    expect(existsSync(dirOf(sid))).toBe(false)
    await expect(history.readArtifactBlob(sid, 'a'.repeat(40))).resolves.toBeNull()

    const parent = join(state.root, '..')
    const before = [state.root, parent].map((d) => readdirSync(d).sort().join(','))
    for (const id of ['', '..', 'a/b', '../x']) {
      await expect(history.storeArtifactBlob(id, 'x'), id).resolves.toBeNull()
      await expect(history.readArtifactBlob(id, 'a'.repeat(40)), id).resolves.toBeNull()
    }
    expect([state.root, parent].map((d) => readdirSync(d).sort().join(','))).toEqual(before)
    expect(existsSync(join(state.root, '.git'))).toBe(false)
    expect(existsSync(join(parent, '.git'))).toBe(false)
    expect(events).toEqual([])
    expect(state.warns).toEqual([])
  })

  it('HB-2 还不是仓库：store 先 init、只进对象库不提交、不发事件；之后的 prepare 照样提交基线', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg aria-label="A"/>')
    const oid = await history.storeArtifactBlob(sid, '<svg aria-label="A"/>')
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(join(dirOf(sid), '.git'))).toBe(true)
    expect(catBlob(dirOf(sid), oid!)).toBe('<svg aria-label="A"/>')
    // 不进任何提交，工作区里那件仍是未跟踪的
    expect(commits(dirOf(sid))).toEqual([])
    expect(existsSync(join(dirOf(sid), '.git', 'refs', 'heads', 'main'))).toBe(false)
    expect(git(dirOf(sid), ['status', '--porcelain']).trim()).toBe('?? a.svg')
    expect(events).toEqual([])

    // 基线看的是「有没有第一个提交」，不是 `.git` 在不在：store 建的仓库挡不住它
    await history.prepareArtifactHistory(sid)
    const log = commits(dirOf(sid))
    expect(log).toHaveLength(1)
    expect(log[0].subject).toMatch(/^Baseline: /)
    expect(nameStatus(dirOf(sid))).toEqual(['A\ta.svg'])
    // 存过的 blob 还在
    expect(await history.readArtifactBlob(sid, oid!)).toBe('<svg aria-label="A"/>')
    expect(state.warns).toEqual([])
  })

  it('HB-3 store 与 record 在同一目录上并发：两个都成，blob 读得回、一次提交、一个事件', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    const content = '<svg aria-label="pinned"><rect/></svg>'
    const [oid, recorded] = await Promise.all([
      history.storeArtifactBlob(sid, content),
      history.recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    ])
    expect(recorded).toBeUndefined()
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    expect(catBlob(dirOf(sid), oid!)).toBe(content)
    expect(await history.readArtifactBlob(sid, oid!)).toBe(content)
    const log = commits(dirOf(sid))
    expect(log).toHaveLength(1)
    expect(log[0].subject).toBe('artifact: a.svg')
    expect(events).toEqual([changed(sid)])
    expect(git(dirOf(sid), ['status', '--porcelain']).trim()).toBe('')
    expect(state.warns).toEqual([])

    // 反过来的次序（record 先排队）也一样
    put(sid, 'a.svg', '<svg><g/></svg>')
    const [, oid2] = await Promise.all([
      history.recordArtifactChange(sid, { toolName: 'edit', callId: 'c2' }),
      history.storeArtifactBlob(sid, 'second')
    ])
    expect(catBlob(dirOf(sid), oid2!)).toBe('second')
    expect(commits(dirOf(sid))).toHaveLength(2)
    expect(state.warns).toEqual([])
  })

  it('HB-4 read：没有仓库 → null；松散对象被删了 → null；有的原样读回', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    // 目录在、还不是仓库
    expect(await history.readArtifactBlob(sid, 'a'.repeat(40))).toBeNull()
    expect(existsSync(join(dirOf(sid), '.git'))).toBe(false)

    const text = '中文 · ünïcødé\r\nline 2\r\n'
    const oid = await history.storeArtifactBlob(sid, text)
    expect(await history.readArtifactBlob(sid, oid!)).toBe(text)
    // 库里没有的 oid
    expect(await history.readArtifactBlob(sid, 'f'.repeat(40))).toBeNull()

    // 松散对象被删了（仓库被人动过）
    const objectFile = join(dirOf(sid), '.git', 'objects', oid!.slice(0, 2), oid!.slice(2))
    expect(existsSync(objectFile)).toBe(true)
    nodeFs.chmodSync(objectFile, 0o644)
    rmSync(objectFile)
    expect(await history.readArtifactBlob(sid, oid!)).toBeNull()
    // 再存一次就又有了
    expect(await history.storeArtifactBlob(sid, text)).toBe(oid)
    expect(await history.readArtifactBlob(sid, oid!)).toBe(text)
  })
})
