/**
 * 会话面板「产物」页的清单（services/artifacts/listing.ts，`artifact:list` 的实现）—— 真实临时目录 +
 * 真实 store / history（真 git 提交），只把 `getSessionArtifactsDir` 指到 tmp。
 *
 *   AL-1 一个目录都没有：`[]`，而且不建任何目录
 *   AL-2 本会话的行：版本数与最近一版的时刻取自历史（逐键严格相等 —— 本会话的行**没有** subSessionTitle 这个键）
 *   AL-3 没有仓库（升级前写下、之后没被工具碰过）：v1 + 文件 mtime
 *   AL-4 有仓库、但这件没进过历史（untracked）：v1 + mtime
 *   AL-5 只有基线那一版：v1 + mtime（基线的时间是升级那一刻，不是文件写下的时候）
 *   AL-6 同一会话内按 updatedAt 倒序，同一时刻按文件名
 *   AL-7 按给定的会话顺序（子会话更新也排在后面）；子会话的空标题照留；没有产物的子会话不加行；不安全的 id 跳过
 *   AL-8 标题从内容里取（svg 的 aria-label），路径是绝对路径
 *
 * 顶桩纪律同 store.test：文件末尾有真实 home 哨兵。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { listSessionArtifacts } from '../listing'
import { artifactVersionStats, prepareArtifactHistory, recordArtifactChange } from '../history'

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
const newSession = (): string => `l${++seq}`
const dirOf = (sid: string): string => join(state.root, sid)
const pathOf = (sid: string, name: string): string => join(dirOf(sid), name)

function put(sid: string, name: string, content: string, mtime?: Date): void {
  mkdirSync(dirOf(sid), { recursive: true })
  writeFileSync(pathOf(sid, name), content, 'utf-8')
  if (mtime) utimesSync(pathOf(sid, name), mtime, mtime)
}

const mtimeOf = (sid: string, name: string): number => statSync(pathOf(sid, name)).mtimeMs

/** 只看 name / versions / updatedAt 三列（排序与回落类用例用） */
const brief = (
  rows: Awaited<ReturnType<typeof listSessionArtifacts>>
): Array<[string, number, number]> => rows.map((r) => [r.name, r.versions, r.updatedAt])

const T1 = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
const T2 = new Date(Date.UTC(2026, 5, 6, 7, 8, 9))

beforeAll(() => {
  homeBefore = homeSnapshot()
  state.root = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-artifact-listing-'))),
    'artifacts'
  )
})

afterAll(() => {
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

describe('listSessionArtifacts', () => {
  it('AL-1 一个目录都没有：[]，不建目录', async () => {
    const own = newSession()
    const child = newSession()
    expect(
      await listSessionArtifacts([{ sessionId: own }, { sessionId: child, subSessionTitle: 'C' }])
    ).toEqual([])
    expect(existsSync(dirOf(own))).toBe(false)
    expect(existsSync(dirOf(child))).toBe(false)
    expect(existsSync(state.root)).toBe(false)
  })

  it('AL-2 本会话的行：版本数与时刻取自历史；没有 subSessionTitle 这个键', async () => {
    const sid = newSession()
    put(sid, 'chart.svg', '<svg aria-label="Chart"/>')
    await recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    put(sid, 'chart.svg', '<svg aria-label="Chart"><rect/></svg>')
    await recordArtifactChange(sid, { toolName: 'edit', callId: 'c2' })
    const stat = (await artifactVersionStats(sid)).get('chart.svg')
    expect(stat?.versions).toBe(2)
    expect(stat?.updatedAt).toBeGreaterThan(0)

    const rows = await listSessionArtifacts([{ sessionId: sid }])
    expect(rows).toStrictEqual([
      {
        sessionId: sid,
        name: 'chart.svg',
        title: 'Chart',
        path: pathOf(sid, 'chart.svg'),
        versions: 2,
        updatedAt: stat!.updatedAt
      }
    ])
    expect('subSessionTitle' in rows[0]).toBe(false)
  })

  it('AL-3 没有仓库：v1 + 文件 mtime', async () => {
    const sid = newSession()
    put(sid, 'old.md', '# Old', T1)
    expect(existsSync(join(dirOf(sid), '.git'))).toBe(false)
    expect(brief(await listSessionArtifacts([{ sessionId: sid }]))).toEqual([
      ['old.md', 1, T1.getTime()]
    ])
  })

  it('AL-4 有仓库、这件没进过历史：v1 + mtime', async () => {
    const sid = newSession()
    put(sid, 'a.svg', '<svg/>')
    await recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })
    const committed = (await artifactVersionStats(sid)).get('a.svg')!.updatedAt
    // 工具之外写进来的（还没有下一次工具调用把它记下）
    put(sid, 'b.svg', '<svg/>', T1)

    const rows = await listSessionArtifacts([{ sessionId: sid }])
    expect(brief(rows)).toEqual([
      ['a.svg', 1, committed],
      ['b.svg', 1, T1.getTime()]
    ])
  })

  it('AL-5 只有基线那一版：v1 + mtime', async () => {
    const sid = newSession()
    put(sid, 'legacy.svg', '<svg/>', T2)
    await prepareArtifactHistory(sid)
    expect((await artifactVersionStats(sid)).get('legacy.svg')).toEqual({
      versions: 1,
      updatedAt: 0
    })
    expect(brief(await listSessionArtifacts([{ sessionId: sid }]))).toEqual([
      ['legacy.svg', 1, mtimeOf(sid, 'legacy.svg')]
    ])
    expect(mtimeOf(sid, 'legacy.svg')).toBe(T2.getTime())
  })

  it('AL-6 同一会话内 updatedAt 倒序，同一时刻按文件名', async () => {
    const sid = newSession()
    put(sid, 'b.md', '# b', T1)
    put(sid, 'c.md', '# c', T2)
    put(sid, 'a.md', '# a', T1)
    expect(brief(await listSessionArtifacts([{ sessionId: sid }]))).toEqual([
      ['c.md', 1, T2.getTime()],
      ['a.md', 1, T1.getTime()],
      ['b.md', 1, T1.getTime()]
    ])
  })

  it('AL-7 会话顺序照给定；空标题照留；没有产物的子会话不加行；不安全的 id 跳过', async () => {
    const own = newSession()
    const childA = newSession()
    const childEmpty = newSession()
    const childB = newSession()
    put(own, 'own.md', '# own', T1)
    // 子会话的更新，但仍排在本会话之后
    put(childA, 'a.md', '# a', T2)
    put(childB, 'b.md', '# b', T2)
    // 不安全的 id（`../x`）解析到的目录里也放一件：守卫漏了就会被列出来
    const escaped = join(state.root, '..', 'x')
    mkdirSync(escaped, { recursive: true })
    writeFileSync(join(escaped, 'escape.md'), '# escape', 'utf-8')

    const rows = await listSessionArtifacts([
      { sessionId: own },
      { sessionId: childA, subSessionTitle: '' },
      { sessionId: childEmpty, subSessionTitle: 'Nothing here' },
      { sessionId: '../x', subSessionTitle: 'Unsafe' },
      { sessionId: childB, subSessionTitle: 'Coder' }
    ])
    expect(rows.map((r) => [r.sessionId, r.subSessionTitle, r.name])).toEqual([
      [own, undefined, 'own.md'],
      [childA, '', 'a.md'],
      [childB, 'Coder', 'b.md']
    ])
    expect('subSessionTitle' in rows[0]).toBe(false)
    expect('subSessionTitle' in rows[1]).toBe(true)
    expect(existsSync(dirOf(childEmpty))).toBe(false)
  })

  it('AL-8 标题从内容里取（svg aria-label）、取不到用文件名主干；路径是绝对路径', async () => {
    const sid = newSession()
    put(sid, 'requests.svg', '<svg viewBox="0 0 4 4" aria-label="Requests by tier"><rect/></svg>')
    put(sid, 'notes.txt', 'plain text, no heading')
    const rows = await listSessionArtifacts([{ sessionId: sid }])
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(byName['requests.svg'].title).toBe('Requests by tier')
    expect(byName['notes.txt'].title).toBe('notes')
    for (const r of rows) {
      expect(isAbsolute(r.path)).toBe(true)
      expect(r.path).toBe(pathOf(sid, r.name))
    }
  })
})
