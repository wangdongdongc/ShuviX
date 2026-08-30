/**
 * sessionStorage registry 单测 —— 进程内共享会话树缓存的核心不变量：
 *   同一会话的并发/先后读取共享同一次加载；写读共用一个实例；
 *   删除逐出；LRU 只回收未钉住的；open 失败不缓存死 Promise。
 *
 * 真实文件：在临时目录里用 pi 的 JsonlSessionStorage 实际落盘（mock 掉 electron 路径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dirs = vi.hoisted(() => ({ sessions: '' }))

vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => dirs.sessions
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  getSessionTree,
  ensureSessionTree,
  deleteSessionFile,
  addSessionTreePin,
  sessionFilePath,
  readSessionRunConfig,
  appendModelChange,
  withSessionTreeLock,
  drainSessionTreeLock,
  clearSessionTreeCacheForTests
} from '../sessionStorage'

/** 一条最小 user 消息 */
function userMsg(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as AgentMessage
}

/** 让出若干轮事件循环 —— 无锁实现会在这段空窗里把两个回调交错跑完 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  dirs.sessions = mkdtempSync(join(tmpdir(), 'shuvix-storage-'))
  /* 钉住谓词由 clearSessionTreeCacheForTests 清空 */
  clearSessionTreeCacheForTests()
})

afterEach(() => {
  rmSync(dirs.sessions, { recursive: true, force: true })
})

describe('sessionStorage registry', () => {
  it('文件不存在：getSessionTree 返回 null 且不创建文件；ensureSessionTree 创建', async () => {
    expect(await getSessionTree('a')).toBeNull()
    expect(existsSync(sessionFilePath('a'))).toBe(false)

    const created = await ensureSessionTree('a', '/ws')
    expect(existsSync(sessionFilePath('a'))).toBe(true)
    expect(await getSessionTree('a')).toBe(created)
  })

  it('并发读取共享同一次加载（在途 Promise 去重）', async () => {
    await ensureSessionTree('a')
    deleteSessionFileCacheOnly() // 仅清缓存，保留文件，强制下次真实 open

    const [s1, s2, s3] = await Promise.all([
      getSessionTree('a'),
      getSessionTree('a'),
      getSessionTree('a')
    ])
    expect(s1).not.toBeNull()
    expect(s1).toBe(s2)
    expect(s2).toBe(s3)
  })

  it('写读共用一个实例：经共享树追加后，读取端立即可见（无需重开文件）', async () => {
    await appendModelChange('a', 'openai', 'gpt-x')
    const config = await readSessionRunConfig('a')
    expect(config).toMatchObject({ provider: 'openai', model: 'gpt-x' })

    // 读到的树与写入方是同一个对象
    expect(await getSessionTree('a')).toBe(await ensureSessionTree('a'))
  })

  it('空 cwd 创建的文件重开可读（pi open 校验 header cwd 非空，创建时须兜底）', async () => {
    // 真实路径：未发过消息的会话上切模型 —— 调用方没有 cwd 可传
    await appendModelChange('cfg', 'openai', 'gpt-x')
    clearSessionTreeCacheForTests() // 模拟重启（丢内存缓存，强制重新 open 文件）
    const config = await readSessionRunConfig('cfg')
    expect(config).toMatchObject({ provider: 'openai', model: 'gpt-x' })
  })

  it('deleteSessionFile 删文件并逐出缓存', async () => {
    await ensureSessionTree('a')
    deleteSessionFile('a')
    expect(existsSync(sessionFilePath('a'))).toBe(false)
    expect(await getSessionTree('a')).toBeNull()

    // 重建后是新实例
    const rebuilt = await ensureSessionTree('a')
    expect(rebuilt).not.toBeNull()
  })

  it('LRU 只逐出未钉住的：钉住的会话保持同一实例', async () => {
    addSessionTreePin((id) => id === 'pinned')
    const pinned = await ensureSessionTree('pinned')
    const first = await ensureSessionTree('s0')

    // 塞满超过上限（MAX_UNPINNED=8）的未钉住会话，触发逐出
    for (let i = 1; i <= 9; i++) await ensureSessionTree(`s${i}`)

    // 钉住的还是同一实例；最早的未钉住会话已被逐出（重新 get 得到新实例）
    expect(await getSessionTree('pinned')).toBe(pinned)
    expect(await getSessionTree('s0')).not.toBe(first)
  })

  it('open 失败不缓存死 Promise：文件修复后可重试成功', async () => {
    writeFileSync(sessionFilePath('bad'), 'not-json\n')
    await expect(getSessionTree('bad')).rejects.toThrow()

    // 换成合法 header 后重试成功（若缓存了 rejected Promise 这里会一直失败）
    writeFileSync(
      sessionFilePath('bad'),
      `${JSON.stringify({ type: 'session', version: 3, id: 'bad', timestamp: new Date().toISOString(), cwd: dirs.sessions })}\n`
    )
    expect(await getSessionTree('bad')).not.toBeNull()
  })
})

/** 仅逐出缓存、保留文件：借 deleteSessionFile 的逐出语义 + 文件回填 */
function deleteSessionFileCacheOnly(): void {
  const path = sessionFilePath('a')
  const backup = existsSync(path) ? readFileSync(path, 'utf8') : null
  deleteSessionFile('a')
  if (backup !== null) writeFileSync(path, backup)
}

describe('withSessionTreeLock —— 树写入串行化', () => {
  it('并发调用的进出序严格不交错（无锁实现会跑出 A-in/B-in/A-out/B-out）', async () => {
    const log: string[] = []
    const body = (tag: string) => async () => {
      log.push(`${tag}-in`)
      await tick()
      log.push(`${tag}-out`)
    }
    await Promise.all([withSessionTreeLock('lk', body('A')), withSessionTreeLock('lk', body('B'))])
    expect(log).toEqual(['A-in', 'A-out', 'B-in', 'B-out'])
  })

  it('对照组：不经锁的并发 appendMessage 会同父分叉，先写的那条掉出分支', async () => {
    // 锁要防的正是这个 bug：pi 的 appendMessage 在 getLeafId 与 appendEntry 之间可被抢占
    const tree = await ensureSessionTree('fork', dirs.sessions)
    await Promise.all([tree.appendMessage(userMsg('A')), tree.appendMessage(userMsg('B'))])

    expect(await tree.getEntries()).toHaveLength(2)
    expect(await tree.getBranch()).toHaveLength(1)
  })

  it('正对照：经写锁并发 append 两条，同一分支上都在且父子相连', async () => {
    const append = (text: string): Promise<string> =>
      withSessionTreeLock('ok', (tree) => tree.appendMessage(userMsg(text)), dirs.sessions)
    await Promise.all([append('A'), append('B')])

    const branch = await (await ensureSessionTree('ok')).getBranch()
    expect(branch).toHaveLength(2)
    expect(branch[1].parentId).toBe(branch[0].id)
  })

  it('树以形参交付，且形参就是共享缓存里的那一个实例（禁止跨锁缓存引用）', async () => {
    let handed: unknown = null
    await withSessionTreeLock(
      'same',
      async (tree) => {
        handed = tree
      },
      dirs.sessions
    )
    expect(handed).toBe(await ensureSessionTree('same'))
  })

  it('回调抛错也释放锁：后续调用正常完成，串行性不被毒化', async () => {
    await expect(
      withSessionTreeLock('boom', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const log: string[] = []
    const body = (tag: string) => async () => {
      log.push(`${tag}-in`)
      await tick()
      log.push(`${tag}-out`)
    }
    await Promise.all([
      withSessionTreeLock('boom', body('A')),
      withSessionTreeLock('boom', body('B'))
    ])
    expect(log).toEqual(['A-in', 'A-out', 'B-in', 'B-out'])
  })

  it('锁按 sessionId 分道：一个会话卡住不阻塞另一个', async () => {
    let releaseA: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseA = r
    })
    const slow = withSessionTreeLock('sa', () => gate)

    let doneB = false
    await withSessionTreeLock('sb', async () => {
      doneB = true
    })
    expect(doneB).toBe(true)

    releaseA()
    await slow
  })
})

describe('drainSessionTreeLock —— 会师语义', () => {
  it('等在飞写入结束才落定', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let written = false
    const writing = withSessionTreeLock('dr', async () => {
      await gate
      written = true
    })

    let drained = false
    const draining = drainSessionTreeLock('dr').then(() => {
      drained = true
    })
    await tick()
    expect(drained).toBe(false)

    release()
    await draining
    expect(written).toBe(true)
    await writing
  })

  it('空闲会话上立即落定，不阻塞', async () => {
    await expect(
      Promise.race([
        drainSessionTreeLock('idle').then(() => 'drained'),
        new Promise((r) => setTimeout(() => r('timeout'), 1000))
      ])
    ).resolves.toBe('drained')
  })

  it('drain 不是禁写闸：其后排队进来的写入照常执行', async () => {
    // 语义弱于注释宣称的「此后不会再有人写这棵树」—— 它只排空此刻的队列。
    // 钉住这条，免得后人把它读成 invalidateAgent 那种解绑
    await drainSessionTreeLock('after')
    await withSessionTreeLock('after', (tree) => tree.appendMessage(userMsg('之后写的')))
    expect(await (await ensureSessionTree('after')).getBranch()).toHaveLength(1)
  })

  it('drain 无副作用：从未写过的会话不会因此被建出空 jsonl', async () => {
    // drain 曾借 withSessionTreeLock 实现，而后者的锁体是 ensureSessionTree —— 会建文件。
    // clearMessages / delete 随后就 unlink，净效果为零；但 gateway.abort 不会，
    // 于是「新建会话按一下停止」就在磁盘上留下一个空文件，违反 getSessionTree 立的规矩。
    // 现在没有在飞写入就直接返回
    expect(existsSync(sessionFilePath('never-written'))).toBe(false)
    await drainSessionTreeLock('never-written')
    expect(existsSync(sessionFilePath('never-written'))).toBe(false)
  })
})

describe('addSessionTreePin —— 可叠加的钉住判定', () => {
  /** 塞满 LRU（上限 8 个未钉住槽），逼出逐出 */
  async function floodUnpinned(): Promise<void> {
    for (let i = 0; i <= 8; i++) await ensureSessionTree(`flood${i}`)
  }

  it.each([
    ['先 p1 后 p2', ['p1', 'p2']],
    ['先 p2 后 p1', ['p2', 'p1']]
  ])('两个谓词任一为真即不被逐出（注册顺序无关：%s）', async (_n, order) => {
    for (const id of order) addSessionTreePin((s) => s === id)
    const p1 = await ensureSessionTree('p1')
    const p2 = await ensureSessionTree('p2')
    await floodUnpinned()

    // 覆盖式 setter 会让后注册者吃掉前一个 —— 那时先注册的那个会拿到新实例
    expect(await ensureSessionTree('p1')).toBe(p1)
    expect(await ensureSessionTree('p2')).toBe(p2)
  })

  it('只注册一个谓词时，未命中的会话照常被逐出（叠加不等于恒真）', async () => {
    addSessionTreePin((s) => s === 'p1')
    const p1 = await ensureSessionTree('p1')
    const victim = await ensureSessionTree('flood0')
    await floodUnpinned()

    expect(await ensureSessionTree('p1')).toBe(p1)
    expect(await ensureSessionTree('flood0')).not.toBe(victim)
  })

  it('clearSessionTreeCacheForTests 一并清空谓词（测试隔离）', async () => {
    addSessionTreePin((s) => s === 'p1')
    await ensureSessionTree('p1')
    clearSessionTreeCacheForTests()

    const p1 = await ensureSessionTree('p1')
    await floodUnpinned()
    expect(await ensureSessionTree('p1')).not.toBe(p1)
  })

  it('谓词是同步纯内存判断：逐出检查时对每个缓存槽各问一次', async () => {
    const seen: string[] = []
    addSessionTreePin((id) => {
      seen.push(id)
      return id === 'p1'
    })
    await ensureSessionTree('p1')
    await floodUnpinned()

    // 谓词若读盘/异步，这里问到的这些 id 就得挨个等 I/O —— 逐出路径是同步的，做不到
    expect(seen).toContain('p1')
    expect(new Set(seen).size).toBeGreaterThan(1)
  })
})
