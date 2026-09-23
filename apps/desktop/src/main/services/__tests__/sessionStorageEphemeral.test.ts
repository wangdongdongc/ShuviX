/**
 * sessionStorage —— **内存会话**（sessionRecords.isEphemeral）的对话树只在内存里。
 *
 * 契约：一条内存会话的树从不 open、从不落 `.jsonl`；第一次 ensure 建出一棵内存树，之后靠共享缓存的
 * 槽找回它 —— 没有文件兜底，槽被 LRU 逐出就等于对话丢了，所以内存会话**恒钉住**，且钉住的槽不占
 * 未钉住的 LRU 名额（否则开着几条内存会话，每个旁观会话刚打开就被逐出）。会话删掉之后（wasEphemeral）
 * 迟到的写入一律拒绝：不能给一条从没落过盘的会话在磁盘上补出一个文件。
 *
 * 真实文件：临时目录当 sessions 目录（mock 掉 electron 路径），用真的 sessionRecords 标记内存会话；
 * sessionDao 只替到「插内存会话时核对 id 没被库占用」的 pick 那一层。
 *
 *   T1  ensure 之前：get → null；readSessionRunConfig 全 null；目录为空
 *   T2  ensure 返回一棵树、不写 .jsonl；get 与第二次 ensure 是同一实例
 *   T3  appendModelChange 读得回来；目录仍为空
 *   T4  两个并发的写锁追加：同一分支、父子相连、不分叉
 *   T5  LRU 永不逐出内存树：开 10 个持久会话之后，内存树还是那一个实例、entry 还在
 *   T6  10 棵内存树全留着（上限 8）；之后打开的持久树也还在缓存里（钉住的不占名额）
 *   T7  删掉之后：get → null；ensure / appendModelChange reject；仍然没有文件
 *   T8  活着的内存会话 id 在磁盘上有一个陈旧的 .jsonl：不打开、不覆盖
 *   T9  内存会话的钉住熬得过 clearSessionTreeCacheForTests
 *   T10 回归对照：从没当过内存会话的会话照旧写 .jsonl
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dirs = vi.hoisted(() => ({ sessions: '' }))

vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => dirs.sessions
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 内存会话的 insert 要先问库里有没有同 id 的行（pick）；持久会话那一侧本文件不碰表
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pick: () => undefined } }))

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  addSessionTreePin,
  appendModelChange,
  clearSessionTreeCacheForTests,
  deleteSessionFile,
  ensureSessionTree,
  getSessionTree,
  readSessionRunConfig,
  sessionFilePath,
  withSessionTreeLock
} from '../sessionStorage'
import { sessionRecords } from '../sessionRecords'

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as AgentMessage
}

/** 把一个 id 登记成活着的内存会话（用真的 sessionRecords） */
function markEphemeral(id: string): string {
  sessionRecords.insert(
    {
      id,
      title: id,
      projectId: null,
      parentId: null,
      settings: {},
      createdAt: 1,
      updatedAt: 1,
      lastActiveAt: 1
    },
    { ephemeral: true }
  )
  return id
}

/** sessions 目录里的文件 */
const files = (): string[] => readdirSync(dirs.sessions)

beforeEach(() => {
  dirs.sessions = mkdtempSync(join(tmpdir(), 'shuvix-storage-eph-'))
  sessionRecords.clearEphemeralForTests()
  clearSessionTreeCacheForTests()
})

afterEach(() => {
  sessionRecords.clearEphemeralForTests()
  clearSessionTreeCacheForTests()
  rmSync(dirs.sessions, { recursive: true, force: true })
})

describe('内存会话的树只在内存里', () => {
  it('T1 ensure 之前：get → null，运行配置全 null，目录为空', async () => {
    const t = markEphemeral('t1')
    expect(await getSessionTree(t)).toBeNull()
    expect(await readSessionRunConfig(t)).toEqual({
      provider: null,
      model: null,
      thinkingLevel: null
    })
    expect(files()).toEqual([])
  })

  it('T2 ensure 建出一棵树、不写文件；之后 get / ensure 是同一实例', async () => {
    const t = markEphemeral('t2')
    const tree = await ensureSessionTree(t, '/ws')
    expect(tree).toBeTruthy()
    expect(existsSync(sessionFilePath(t))).toBe(false)
    expect(files()).toEqual([])
    expect(await getSessionTree(t)).toBe(tree)
    expect(await ensureSessionTree(t, '/elsewhere')).toBe(tree)
  })

  it('T3 appendModelChange 读得回来，目录仍为空', async () => {
    const t = markEphemeral('t3')
    await appendModelChange(t, 'openai', 'gpt-x')
    expect(await readSessionRunConfig(t)).toMatchObject({ provider: 'openai', model: 'gpt-x' })
    expect(files()).toEqual([])
  })

  it('T4 并发写锁追加两条：同一分支、父子相连', async () => {
    const t = markEphemeral('t4')
    const append = (text: string): Promise<string> =>
      withSessionTreeLock(t, (tree) => tree.appendMessage(userMsg(text)))
    await Promise.all([append('A'), append('B')])

    const tree = (await getSessionTree(t))!
    const branch = await tree.getBranch()
    expect(branch).toHaveLength(2)
    expect(branch[1].parentId).toBe(branch[0].id)
    expect(await tree.getEntries()).toHaveLength(2)
    expect(files()).toEqual([])
  })

  it('T10 回归对照：从没当过内存会话的会话照旧写 .jsonl', async () => {
    await appendModelChange('plain', 'openai', 'gpt-x')
    expect(existsSync(sessionFilePath('plain'))).toBe(true)
    expect(readFileSync(sessionFilePath('plain'), 'utf8')).toContain('gpt-x')
  })
})

describe('内存树恒钉住，且不占未钉住的名额', () => {
  /** 建一棵带一条 entry 的内存树，回它的实例 */
  async function seededTree(id: string): Promise<Awaited<ReturnType<typeof ensureSessionTree>>> {
    markEphemeral(id)
    await appendModelChange(id, 'openai', `model-${id}`)
    return (await getSessionTree(id))!
  }

  it('T5 开 10 个持久会话之后，内存树还是那一个实例、entry 还在', async () => {
    const tree = await seededTree('t5')
    for (let i = 0; i < 10; i++) await ensureSessionTree(`p${i}`)

    expect(await getSessionTree('t5')).toBe(tree)
    expect(await readSessionRunConfig('t5')).toMatchObject({ model: 'model-t5' })
  })

  it('T6 10 棵内存树全留着；之后打开的持久树也还在缓存里', async () => {
    const trees = new Map<string, unknown>()
    for (let i = 0; i < 10; i++) trees.set(`e${i}`, await seededTree(`e${i}`))

    for (const [id, tree] of trees) {
      expect(await getSessionTree(id)).toBe(tree)
      expect(await readSessionRunConfig(id)).toMatchObject({ model: `model-${id}` })
    }

    // 钉住的 10 个槽若也算进上限 8，这棵刚打开的持久树会在打开的同一刻被逐出，
    // 下一个读者只好再开一份分叉实例
    const persisted = await ensureSessionTree('p-after')
    expect(await getSessionTree('p-after')).toBe(persisted)
    expect(await ensureSessionTree('p-after')).toBe(persisted)
  })

  it('T9 钉住熬得过 clearSessionTreeCacheForTests（它只清可叠加的谓词）', async () => {
    addSessionTreePin(() => false)
    clearSessionTreeCacheForTests()

    const tree = await seededTree('t9')
    for (let i = 0; i < 10; i++) await ensureSessionTree(`p${i}`)

    expect(await getSessionTree('t9')).toBe(tree)
    expect(await readSessionRunConfig('t9')).toMatchObject({ model: 'model-t9' })
  })
})

describe('删掉之后与磁盘上的陈旧文件', () => {
  it('T7 删掉之后：get → null；ensure / appendModelChange reject；仍然没有文件', async () => {
    const t = markEphemeral('t7')
    await appendModelChange(t, 'openai', 'gpt-x')

    sessionRecords.deleteById(t)
    deleteSessionFile(t)

    expect(await getSessionTree(t)).toBeNull()
    await expect(ensureSessionTree(t, '/ws')).rejects.toThrow()
    await expect(appendModelChange(t, 'openai', 'gpt-y')).rejects.toThrow()
    // 失败的槽不留着：再问一次还是同样的答案，而不是一个半死的缓存
    expect(await getSessionTree(t)).toBeNull()
    await expect(ensureSessionTree(t)).rejects.toThrow()
    expect(existsSync(sessionFilePath(t))).toBe(false)
    expect(files()).toEqual([])
  })

  it('T8 活着的内存会话 id 下有陈旧的 .jsonl：不打开、不覆盖', async () => {
    const t = markEphemeral('t8')
    // 一份合法的旧文件，里面有一条 model_change —— 若被 open，readSessionRunConfig 就会读到它
    const header = {
      type: 'session',
      version: 3,
      id: t,
      timestamp: new Date().toISOString(),
      cwd: dirs.sessions
    }
    const entry = {
      type: 'model_change',
      id: 'stale-1',
      parentId: null,
      timestamp: new Date().toISOString(),
      provider: 'stale',
      modelId: 'stale-model'
    }
    const stale = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`
    writeFileSync(sessionFilePath(t), stale)

    expect(await getSessionTree(t)).toBeNull()

    const tree = await ensureSessionTree(t, '/ws')
    expect(await tree.getEntries()).toEqual([])
    expect(await readSessionRunConfig(t)).toEqual({
      provider: null,
      model: null,
      thinkingLevel: null
    })

    await appendModelChange(t, 'openai', 'gpt-x')
    expect(readFileSync(sessionFilePath(t), 'utf8')).toBe(stale)
    expect(await readSessionRunConfig(t)).toMatchObject({ provider: 'openai', model: 'gpt-x' })
  })
})
