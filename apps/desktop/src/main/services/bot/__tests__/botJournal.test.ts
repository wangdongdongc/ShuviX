/**
 * bot 决策记录（设计 §9）的单测 —— 真 fs + 临时目录。
 *
 * **刻意不 mock fs**：这一层的全部风险都在文件语义上 —— 追加而不是覆盖、目录名净化后
 * 不得逃出 `.runs`、剪枝必须放过 decisions.jsonl、行数检查每 200 次才做一遍。
 * 换成假 fs 就只剩下「调了哪个函数」，一条也测不到。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { join, resolve, sep } from 'path'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  return { bots: `${tmp}/shuvix-botjournal-${process.pid}` }
})

vi.mock('../../../utils/paths', () => ({ getDefaultBotsDir: () => dirs.bots }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  appendBotDecision,
  botRunsDir,
  pruneBotRuns,
  resetDecisionCounterForTests,
  safeBotDirName,
  type BotDecisionRecord
} from '../botJournal'

/** 与实现里的 DECISIONS_KEEP_LINES 对齐（该常量未导出） */
const KEEP_LINES = 5000

function record(botName: string, over: Partial<BotDecisionRecord> = {}): void {
  appendBotDecision({
    kind: 'run_end',
    sessionId: 's1',
    botName,
    ticketId: 'bt-1',
    ...over
  })
}

function decisionsFile(botName: string): string {
  return join(botRunsDir(botName), 'decisions.jsonl')
}

function realLines(file: string): string[] {
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean)
}

/** 预置一份超限的 decisions.jsonl（每行是可辨认的哨兵） */
function seedDecisions(botName: string, count: number): void {
  const dir = botRunsDir(botName)
  mkdirSync(dir, { recursive: true })
  const body = Array.from({ length: count }, (_, i) => JSON.stringify({ seeded: i })).join('\n')
  writeFileSync(join(dir, 'decisions.jsonl'), `${body}\n`)
}

/** 造 n 个 run journal 文件，mtime 按序递增（i 越小越旧） */
function seedRuns(botName: string, n: number): string[] {
  const dir = botRunsDir(botName)
  mkdirSync(dir, { recursive: true })
  const names: string[] = []
  for (let i = 0; i < n; i++) {
    const name = `run-${String(i).padStart(4, '0')}.jsonl`
    const path = join(dir, name)
    writeFileSync(path, '{}\n')
    const t = 1_600_000_000 + i * 60
    utimesSync(path, t, t)
    names.push(name)
  }
  return names
}

beforeEach(() => {
  rmSync(dirs.bots, { recursive: true, force: true })
  mkdirSync(dirs.bots, { recursive: true })
  resetDecisionCounterForTests()
})

afterAll(() => {
  rmSync(dirs.bots, { recursive: true, force: true })
})

describe('safeBotDirName / botRunsDir —— `..` 不得逃出 .runs', () => {
  it.each([
    ['..', '_unknown'],
    ['../evil', '-evil'],
    ['a/b', 'a-b'],
    ['a\\b', 'a-b'],
    ['.hidden', 'hidden'],
    ['a:b*c?"<>|', 'a-b-c-----'],
    ['', '_unknown'],
    ['scout', 'scout']
  ])('净化 %s → %s', (input, expected) => {
    expect(safeBotDirName(input)).toBe(expected)
  })

  it.each(['..', '../evil', '../../etc', 'a/b', '', '.hidden'])(
    '恶意名 %s 的 botRunsDir 仍在 .runs 之内',
    (name) => {
      const root = join(dirs.bots, '.runs') + sep
      expect(resolve(botRunsDir(name)).startsWith(root)).toBe(true)
    }
  )
})

describe('appendBotDecision', () => {
  it('追加而不是覆盖，每行是带 ts 的 JSON', () => {
    record('scout', { kind: 'claim_won', messageSeq: 1 })
    record('scout', { kind: 'run_end', messageSeq: 1 })

    const lines = realLines(decisionsFile('scout')).map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: 'claim_won', botName: 'scout', messageSeq: 1 })
    expect(typeof lines[0].ts).toBe('number')
    expect(lines[1].kind).toBe('run_end')
  })

  it('目录懒创建（首次写自动 mkdir）', () => {
    expect(existsSync(botRunsDir('scout'))).toBe(false)
    record('scout')
    expect(existsSync(decisionsFile('scout'))).toBe(true)
  })

  it('写失败不抛（可观测性不该拖垮业务路径）', () => {
    // 让 `.runs/<bot>` 是一个文件 —— mkdir 必失败
    mkdirSync(join(dirs.bots, '.runs'), { recursive: true })
    writeFileSync(join(dirs.bots, '.runs', 'failbot'), 'not a dir')

    expect(() => record('failbot')).not.toThrow()
  })
})

describe('pruneBotRuns', () => {
  it('按 mtime 保留最新的 200 个', () => {
    seedRuns('scout', 250)
    pruneBotRuns('scout')

    const left = readdirSync(botRunsDir('scout')).sort()
    expect(left).toHaveLength(200)
    expect(left[0]).toBe('run-0050.jsonl') // 最旧的 50 个被剪掉
    expect(left.at(-1)).toBe('run-0249.jsonl')
  })

  it('decisions.jsonl 永不被剪，也不占配额', () => {
    seedRuns('scout', 250)
    const decisions = decisionsFile('scout')
    writeFileSync(decisions, '{"seeded":true}\n')
    utimesSync(decisions, 1, 1) // mtime 最旧 —— 按通配剪枝的实现会第一个删它

    pruneBotRuns('scout')
    expect(existsSync(decisions)).toBe(true)
    // 恰好 200 个 run（不是 199 —— decisions.jsonl 不占配额）
    expect(readdirSync(botRunsDir('scout')).filter((f) => f.startsWith('run-'))).toHaveLength(200)
  })

  it('目录不存在时不抛；非 .jsonl 文件不被删', () => {
    expect(() => pruneBotRuns('never-ran')).not.toThrow()

    seedRuns('scout', 250)
    writeFileSync(join(botRunsDir('scout'), 'notes.txt'), 'keep me')
    pruneBotRuns('scout')
    expect(existsSync(join(botRunsDir('scout'), 'notes.txt'))).toBe(true)
  })
})

describe('decisions.jsonl 的行数收口', () => {
  it('每 200 次追加才检查一次行数', () => {
    seedDecisions('scout', 6000)
    for (let i = 0; i < 199; i++) record('scout', { messageSeq: i })
    expect(realLines(decisionsFile('scout')).length).toBe(6199)

    record('scout', { messageSeq: 199 }) // 第 200 条触发检查
    expect(realLines(decisionsFile('scout')).length).toBeLessThan(6000)
  })

  it('截断保留尾部：恰好留下 DECISIONS_KEEP_LINES 条', () => {
    seedDecisions('scout', 6000)
    for (let i = 0; i < 200; i++) record('scout', { messageSeq: i, detail: { i } })

    const lines = realLines(decisionsFile('scout'))
    expect(lines).toHaveLength(KEEP_LINES)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ messageSeq: 199 })
    expect(lines[0]).not.toContain('"seeded":0')
  })

  it('计数器是模块全局而非按文件', () => {
    seedDecisions('a', 6000)
    seedDecisions('b', 6000)
    for (let i = 0; i < 199; i++) record('a', { messageSeq: i })
    record('b') // 第 200 条 —— 被检查/截断的是 b 的文件

    expect(realLines(decisionsFile('a')).length).toBe(6199)
    expect(realLines(decisionsFile('b')).length).toBe(KEEP_LINES)
  })
})
