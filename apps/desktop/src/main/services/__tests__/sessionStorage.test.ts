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

import {
  getSessionTree,
  ensureSessionTree,
  deleteSessionFile,
  setSessionTreePinned,
  sessionFilePath,
  readSessionRunConfig,
  appendModelChange,
  clearSessionTreeCacheForTests
} from '../sessionStorage'

beforeEach(() => {
  dirs.sessions = mkdtempSync(join(tmpdir(), 'shuvix-storage-'))
  setSessionTreePinned(() => false)
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
    setSessionTreePinned((id) => id === 'pinned')
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
