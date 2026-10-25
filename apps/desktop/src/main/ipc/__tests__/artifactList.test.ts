/**
 * `artifact:list`（ipc/filesHandlers.ts）—— 会话面板「产物」页的清单通道。脚手架照 artifactRead.test：
 * 真实临时目录 + 真实 store / listing / history，只把 electron / 会话表 / 其余 files:* 依赖换成替身。
 *
 *   IL-1 本会话的在前，再按 `findChildren` 的顺序列直接子会话的，各带那场子会话的标题
 *   IL-2 只往下找一层：孙会话的产物不在父会话的清单里（从子会话问才有）
 *   IL-3 不安全的会话 id：`[]`，什么都不碰
 *
 * 往下找一层的口径与 `artifact:read` 相同（目录跟着产出它的会话走，`work` 把具体活交给子会话）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>(),
  children: new Map<string, Array<{ id: string; title: string }>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: () => undefined }
}))
vi.mock('../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { findChildren: (id: string) => state.children.get(id) ?? [] }
}))
vi.mock('../../services/filesWatcherService', () => ({
  scanSessionFiles: vi.fn(),
  scanSessionDir: vi.fn(),
  watchSessionFile: vi.fn(),
  unwatchSessionFile: vi.fn()
}))
vi.mock('../../services/filePreviewService', () => ({
  previewSessionFile: vi.fn(),
  writeSessionFile: vi.fn(),
  resolveSessionFilePath: vi.fn()
}))
vi.mock('../../services/previewWindowService', () => ({
  openFileInWindow: vi.fn()
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { registerFilesHandlers } from '../filesHandlers'
import { attachIpcAdapter } from '../ipcAdapter'
import { writeArtifact } from '../../services/artifacts/store'
import { recordArtifactChange } from '../../services/artifacts/history'

const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

const list = async (sessionId: string): Promise<SessionArtifact[]> => {
  const handler = state.handlers.get('artifact:list')
  expect(handler, 'artifact:list 未注册').toBeDefined()
  return (await handler!({ sender: { id: 1 } }, { sessionId })) as SessionArtifact[]
}

let seq = 0
let sid = ''

beforeAll(() => {
  homeBefore = homeSnapshot()
  state.root = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-artifact-list-ipc-'))),
    'artifacts'
  )
  registerFilesHandlers()
  attachIpcAdapter()
})

afterAll(() => {
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

beforeEach(() => {
  sid = `s${++seq}`
  state.children.clear()
})

describe('artifact:list', () => {
  it('IL-1 本会话在前，再按 findChildren 的顺序列直接子会话，各带子会话标题', async () => {
    const second = `${sid}-second`
    const first = `${sid}-first`
    const idle = `${sid}-idle`
    // findChildren 给的顺序（创建顺序）：first、idle（没有产物）、second
    state.children.set(sid, [
      { id: first, title: 'Coding' },
      { id: idle, title: 'Nothing drawn' },
      { id: second, title: 'Review' }
    ])
    writeArtifact({ sessionId: second, title: 'Second', ext: 'md', content: '# Second' })
    writeArtifact({ sessionId: first, title: 'First', ext: 'md', content: '# First' })
    const mine = writeArtifact({
      sessionId: sid,
      title: 'Mine',
      ext: 'svg',
      content: '<svg aria-label="Mine"/>'
    })
    await recordArtifactChange(sid, { toolName: 'artifact', callId: 'c1' })

    const rows = await list(sid)
    expect(rows.map((r) => [r.sessionId, r.subSessionTitle, r.name, r.title])).toEqual([
      [sid, undefined, 'mine.svg', 'Mine'],
      [first, 'Coding', 'first.md', 'First'],
      [second, 'Review', 'second.md', 'Second']
    ])
    expect('subSessionTitle' in rows[0]).toBe(false)
    expect(rows[0]).toMatchObject({ path: mine.path, versions: 1 })
    expect(rows[0].updatedAt).toBeGreaterThan(0)
  })

  it('IL-2 只往下找一层：孙会话的产物不在父会话的清单里', async () => {
    const child = `${sid}-child`
    const grandchild = `${sid}-grandchild`
    state.children.set(sid, [{ id: child, title: 'Child' }])
    state.children.set(child, [{ id: grandchild, title: 'Grandchild' }])
    writeArtifact({ sessionId: child, title: 'Kid', ext: 'md', content: '# Kid' })
    writeArtifact({ sessionId: grandchild, title: 'Deep', ext: 'md', content: '# Deep' })

    expect((await list(sid)).map((r) => [r.sessionId, r.name])).toEqual([[child, 'kid.md']])
    // 从子会话问才拿得到
    expect((await list(child)).map((r) => [r.sessionId, r.subSessionTitle, r.name])).toEqual([
      [child, undefined, 'kid.md'],
      [grandchild, 'Grandchild', 'deep.md']
    ])
  })

  it('IL-3 不安全的会话 id：[]，什么都不碰', async () => {
    const escaped = join(state.root, '..', 'escaped')
    mkdirSync(escaped, { recursive: true })
    writeFileSync(join(escaped, 'secret.md'), '# Secret', 'utf-8')
    const before = readdirSync(escaped).sort()

    for (const id of ['../escaped', '..', 'a/b', '']) {
      expect(await list(id), id).toEqual([])
    }
    expect(readdirSync(escaped).sort()).toEqual(before)
  })
})
