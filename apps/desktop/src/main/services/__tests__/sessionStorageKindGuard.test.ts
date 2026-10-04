/**
 * sessionStorage —— v3 JSONL 会话树只开、只建存储类型为 `harness-v3-jsonl` 的会话。
 *
 * 契约：表上 storageKind 是别的值（更新版本建的，比如 pi-durable 的存储；或者本版本根本不认识的值）
 * 的会话，绝不能拿 v3 JSONL 去开或去建 —— 降级运行时那会在它旁边凭空写出一个 `.jsonl`，两种格式
 * 各记一半。拒绝发生在任何文件操作之前，也发生在内存会话分流之前；拒绝不毒化缓存、不卡住写锁。
 * 查不到行（老测试、刚删掉的会话）按 v3 处理。
 *
 * 真实文件：临时目录当 sessions 目录（mock 掉 electron 路径），sessionRecords 是真的；
 * sessionDao 只替到 `pick` —— 背后一张「id → storageKind」表，查不到即 undefined。
 * 注意内存会话的 id 不能放进这张表：插内存会话时会 pick(id, ['id']) 核对库里有没有同 id 的行。
 *
 *   SG-1  durable、没有文件：ensure 拒绝（消息点名存储类型）；目录仍为空
 *   SG-2  durable：appendModelChange / appendThinkingLevelChange / withSessionTreeLock 都拒绝，
 *         回调一次都没跑、没有文件；锁随即释放；v3 会话的写锁照常
 *   SG-3  durable、磁盘上躺着一份合法的 v3 文件：get / readSessionRunConfig 拒绝；文件一字不动
 *   SG-4  [白盒] durable、没有文件：get → null（exists 先短路，不走 open）；运行配置全 null；不建文件
 *   SG-5  不止 durable：本版本不认识的值、空串，SG-1 / SG-3 同样拒绝
 *   SG-6  对照：显式 v3 / 查不到行 → 照常建、重开读得回来
 *   SG-7  拒绝在内存分流之前、经 sessionRecords 读：内存会话带 durable → 拒绝；不带 → 照旧内存树、无文件
 *   SG-8  拒绝不毒化缓存：把类型改回 v3 之后 ensure 照常建出文件
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dirs = vi.hoisted(() => ({ sessions: '' }))
/** 「库」里每条会话的 storageKind；不在表里 = 查不到行 */
const kinds = vi.hoisted(() => new Map<string, string>())

vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => dirs.sessions
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: (id: string) => (kinds.has(id) ? { storageKind: kinds.get(id) } : undefined)
  }
}))

import type { Session } from '../../dao/types'
import {
  appendModelChange,
  appendThinkingLevelChange,
  clearSessionTreeCacheForTests,
  drainSessionTreeLock,
  ensureSessionTree,
  getSessionTree,
  readSessionRunConfig,
  sessionFilePath,
  withSessionTreeLock
} from '../sessionStorage'
import { sessionRecords } from '../sessionRecords'

const DURABLE = 'durable-sqlite-1'
const V3 = 'harness-v3-jsonl'

/** sessions 目录里的文件 */
const files = (): string[] => readdirSync(dirs.sessions)

/** 在 ms 内落定，否则判失败（锁卡死时不让整个用例挂到超时） */
function settlesWithin<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms)
    )
  ])
}

/** 一条内存会话（用真的 sessionRecords）；id 不在 kinds 里 */
function insertEphemeral(id: string, storageKind?: Session['storageKind']): void {
  sessionRecords.insert(
    {
      id,
      title: id,
      projectId: null,
      parentId: null,
      ...(storageKind ? { storageKind } : {}),
      settings: {},
      createdAt: 1,
      updatedAt: 1,
      lastActiveAt: 1
    },
    { ephemeral: true }
  )
}

/** 先当 v3 会话写出一份合法文件（含一条 model_change），丢掉缓存，再把它的类型改成 kind */
async function staleV3FileFor(id: string, kind: string): Promise<string> {
  kinds.set(id, V3)
  await appendModelChange(id, 'openai', 'gpt-x')
  clearSessionTreeCacheForTests()
  kinds.set(id, kind)
  expect(existsSync(sessionFilePath(id))).toBe(true)
  return readFileSync(sessionFilePath(id), 'utf8')
}

beforeEach(() => {
  dirs.sessions = mkdtempSync(join(tmpdir(), 'shuvix-storage-kind-'))
  kinds.clear()
  sessionRecords.clearEphemeralForTests()
  clearSessionTreeCacheForTests()
})

afterEach(() => {
  rmSync(dirs.sessions, { recursive: true, force: true })
})

describe('v3 树注册表的存储类型守卫', () => {
  it('SG-1 durable、没有文件：ensure 拒绝；目录仍为空（连只有头的文件都没有）', async () => {
    kinds.set('d', DURABLE)

    await expect(ensureSessionTree('d', '/ws')).rejects.toThrow(/durable-sqlite-1/)

    expect(files()).toEqual([])
  })

  it('SG-2 durable：三个写入口都拒绝，回调没跑、没有文件；锁随即释放', async () => {
    kinds.set('d', DURABLE)
    const cb = vi.fn(async () => 'ran')

    await expect(appendModelChange('d', 'openai', 'gpt-x')).rejects.toThrow(/durable-sqlite-1/)
    await expect(appendThinkingLevelChange('d', 'high')).rejects.toThrow(/durable-sqlite-1/)
    await expect(withSessionTreeLock('d', cb)).rejects.toThrow(/durable-sqlite-1/)

    expect(cb).not.toHaveBeenCalled()
    expect(files()).toEqual([])
    // 拒绝没有把锁留在手里：排空立即落定
    await expect(settlesWithin(drainSessionTreeLock('d'))).resolves.toBeUndefined()

    // 别的（v3）会话的写锁照常
    kinds.set('v', V3)
    await expect(
      settlesWithin(withSessionTreeLock('v', (tree) => tree.appendModelChange('openai', 'gpt-y')))
    ).resolves.toEqual(expect.any(String))
    expect(await readSessionRunConfig('v')).toMatchObject({ provider: 'openai', model: 'gpt-y' })
  })

  it('SG-3 durable、磁盘上躺着一份合法的 v3 文件：get / readSessionRunConfig 拒绝；文件一字不动', async () => {
    const before = await staleV3FileFor('d', DURABLE)

    await expect(getSessionTree('d')).rejects.toThrow(/durable-sqlite-1/)
    await expect(readSessionRunConfig('d')).rejects.toThrow(/durable-sqlite-1/)
    await expect(ensureSessionTree('d')).rejects.toThrow(/durable-sqlite-1/)

    expect(readFileSync(sessionFilePath('d'), 'utf8')).toBe(before)
    expect(files()).toEqual(['d.jsonl'])
  })

  it('SG-4 [白盒] durable、没有文件：get → null（exists 先短路）；运行配置全 null；不建文件', async () => {
    // 钉的是现状：读路径在「没有文件」时根本走不到 open，于是也走不到守卫 —— 没东西可读，
    // 回 null 与拒绝在这里都不会写出文件；改成拒绝时同步改这一条
    kinds.set('d', DURABLE)

    expect(await getSessionTree('d')).toBeNull()
    expect(await readSessionRunConfig('d')).toEqual({
      provider: null,
      model: null,
      thinkingLevel: null
    })
    expect(files()).toEqual([])
  })

  it.each([
    ['本版本不认识的值', 'durable-sqlite-9'],
    ['空串', '']
  ])('SG-5 %s：同样拒绝（守卫认的是「不是 v3」，不是某个具体值）', async (_label, kind) => {
    const message = kind || /storage/
    kinds.set('fresh', kind)
    await expect(ensureSessionTree('fresh', '/ws')).rejects.toThrow(message)
    expect(files()).toEqual([])

    const before = await staleV3FileFor('stale', kind)
    await expect(getSessionTree('stale')).rejects.toThrow(message)
    await expect(readSessionRunConfig('stale')).rejects.toThrow(message)
    expect(readFileSync(sessionFilePath('stale'), 'utf8')).toBe(before)
    expect(files()).toEqual(['stale.jsonl'])
  })

  it('SG-6 对照：显式 v3 → 照常建、重开读得回来', async () => {
    kinds.set('v', V3)
    await appendModelChange('v', 'openai', 'gpt-x')
    expect(existsSync(sessionFilePath('v'))).toBe(true)

    clearSessionTreeCacheForTests()
    const reopened = await getSessionTree('v')
    expect(reopened).not.toBeNull()
    expect(await readSessionRunConfig('v')).toMatchObject({ provider: 'openai', model: 'gpt-x' })
  })

  it('SG-6 对照：查不到行 → 按 v3 处理，照常建、重开读得回来', async () => {
    expect(kinds.has('m')).toBe(false)
    const created = await ensureSessionTree('m', '/ws')
    expect(created).not.toBeNull()
    expect(existsSync(sessionFilePath('m'))).toBe(true)

    clearSessionTreeCacheForTests()
    expect(await getSessionTree('m')).not.toBeNull()
  })

  it('SG-7 内存会话带 durable → 拒绝（守卫在内存分流之前，经 sessionRecords 读）', async () => {
    insertEphemeral('memD', DURABLE)

    await expect(ensureSessionTree('memD')).rejects.toThrow(/durable-sqlite-1/)
    expect(files()).toEqual([])
  })

  it('SG-7 对照：内存会话不带存储类型 → 照旧一棵内存树，不写文件', async () => {
    insertEphemeral('mem')

    const tree = await ensureSessionTree('mem')
    await tree.appendModelChange('openai', 'gpt-x')
    expect(await ensureSessionTree('mem')).toBe(tree)
    expect(await readSessionRunConfig('mem')).toMatchObject({ provider: 'openai', model: 'gpt-x' })
    expect(files()).toEqual([])
  })

  it('SG-8 拒绝不毒化缓存：类型改回 v3 之后 ensure 照常建出文件', async () => {
    kinds.set('d', DURABLE)
    await expect(ensureSessionTree('d', '/ws')).rejects.toThrow(/durable-sqlite-1/)

    kinds.set('d', V3)
    const tree = await ensureSessionTree('d', '/ws')
    expect(tree).not.toBeNull()
    expect(existsSync(sessionFilePath('d'))).toBe(true)
    expect(await getSessionTree('d')).toBe(tree)
  })
})
