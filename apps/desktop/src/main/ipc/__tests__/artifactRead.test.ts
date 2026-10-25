/**
 * `artifact:read`（ipc/filesHandlers.ts）—— ```artifact 引用围栏的数据通道：按**名字**取一件的
 * 当前内容。真实临时目录 + 真实 store，只把 electron / 会话表 / 其余 files:* 依赖换成替身。
 *
 * 三件事钉在这里：
 *  - **围栏里只该有名字**（路径不进转写），所以回包必须自带 `title` 与 `content` ——
 *    渲染端拿着这三样就能画出卡片，不再回头问第二次。
 *  - **沿会话树往下找一层**：产物目录跟着**产出它的那场会话**走，而 `work` 基座的分工正是把
 *    具体活交给 `coding` 子会话 —— 子代理画的图，父会话终答里的引用必须展示得出来。
 *    嵌套只有一层，所以不递归（IR-6 把「只找一层」钉住）。
 *  - **`name` 拿不到目录之外的文件**：今天 name 是与 readdir 结果比字符串、天然安全，
 *    这条守的是「别有人为省一次 readdir 改成 `join(dir, name)`」。
 *
 * 钉版本（services/artifacts/pins.ts）之后多了一路：带上围栏所在回复的 `messageId` 时按需 import 会话宿主
 * （这里换成只有 `peek` 的桩）取钉下的那一版。IR-8 不带 messageId 仍是同步值；IR-9 带了就是 Promise，
 * 会话没开 / peek 或宿主抛错都回落当前内容；IR-10 子会话下探照旧；IR-11 真 durable 会话上钉过 → 那一版。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>(),
  children: new Map<string, Array<{ id: string }>>(),
  /** 会话宿主的 peek（按需加载的那个 sessionHost 上） */
  peek: vi.fn<(sessionId: string) => unknown>(),
  /** getSessionHost 本身抛错（宿主还没起来之类） */
  hostThrows: false
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
// 带 messageId 的读按需 import 会话宿主（它带着整套运行时依赖）：换成只有 peek 的桩
vi.mock('../../services/sessionHost', () => ({
  getSessionHost: () => {
    if (state.hostThrows) throw new Error('session host not ready')
    return { peek: (sessionId: string) => state.peek(sessionId) }
  }
}))

import { registerFilesHandlers } from '../filesHandlers'
import { attachIpcAdapter } from '../ipcAdapter'
import { writeArtifact } from '../../services/artifacts/store'
import { pinFinalReply } from '../../services/artifacts/pins'
import {
  appendEntries,
  assistantDraft,
  userDraft
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/digest'
import {
  makeHost,
  registerHostCleanup
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'

registerHostCleanup()

const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

interface ArtifactRow {
  name: string
  title: string
  content: string
}

const read = (sessionId: string, name: string): ArtifactRow | null => {
  const handler = state.handlers.get('artifact:read')
  expect(handler, 'artifact:read 未注册').toBeDefined()
  return handler!({ sender: { id: 1 } }, { sessionId, name }) as ArtifactRow | null
}

let seq = 0
let sid = ''

beforeAll(() => {
  homeBefore = homeSnapshot()
  state.root = join(realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-artifact-ipc-'))), 'artifacts')
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
  state.peek.mockReset()
  state.hostThrows = false
})

/** 带 messageId 的那一路：原样交回 handler 的返回值（应当是 Promise） */
const readAt = (sessionId: string, name: string, messageId: string): unknown => {
  const handler = state.handlers.get('artifact:read')
  expect(handler, 'artifact:read 未注册').toBeDefined()
  return handler!({ sender: { id: 1 } }, { sessionId, name, messageId })
}

describe('artifact:read', () => {
  it('IR-1 命中 ⇒ name / title / content 三项齐全（渲染端一次就画得出卡片）', () => {
    writeArtifact({
      sessionId: sid,
      title: 'Requests by tier',
      ext: 'svg',
      content: '<svg aria-label="Requests by tier"><rect/></svg>'
    })
    // 不带 messageId 就是当前内容：pinned false / latest true；sessionId 是产物所在的会话
    expect(read(sid, 'requests-by-tier.svg')).toEqual({
      sessionId: sid,
      name: 'requests-by-tier.svg',
      title: 'Requests by tier',
      content: '<svg aria-label="Requests by tier"><rect/></svg>',
      pinned: false,
      latest: true
    })
  })

  it('IR-2 取不到 ⇒ null（渲染端据此显示「找不到」而不是空白）', () => {
    expect(read(sid, 'nope.svg')).toBeNull()
    writeArtifact({ sessionId: sid, title: 'Only', ext: 'svg', content: '<svg/>' })
    expect(read(sid, 'other.svg')).toBeNull()
    expect(read(sid, '')).toBeNull()
  })

  it('IR-3 按标题也能取（模型可能在围栏里写标题而不是文件名）', () => {
    writeArtifact({
      sessionId: sid,
      title: 'Latency p99',
      ext: 'svg',
      content: '<svg aria-label="Latency p99"/>'
    })
    expect(read(sid, 'Latency p99')?.name).toBe('latency-p99.svg')
    expect(read(sid, 'latency P99')?.name).toBe('latency-p99.svg')
  })

  it('IR-4 `name` 取不到目录之外的文件（`../`、绝对路径、嵌套路径都不行）', () => {
    // name 是与 readdir 结果比字符串，所以天然安全；这条守的是「别为省一次 readdir
    // 改成 join(dir, name)」—— 那一改，渲染端给的任意路径就都能读了
    writeArtifact({ sessionId: sid, title: 'Inside', ext: 'svg', content: '<svg/>' })
    const outside = join(state.root, '..', 'secret.txt')
    writeFileSync(outside, 'top secret', 'utf-8')
    const sibling = `${sid}-other`
    writeArtifact({ sessionId: sibling, title: 'Sibling', ext: 'svg', content: '<svg/>' })

    for (const name of [
      '../secret.txt',
      '../../secret.txt',
      outside,
      join(state.root, sibling, 'sibling.svg'),
      `../${sibling}/sibling.svg`,
      './inside.svg'
    ]) {
      expect(read(sid, name), name).toBeNull()
    }
    // 目录内那件照常取得到（守卫没有把正常路径一起挡掉）
    expect(read(sid, 'inside.svg')?.name).toBe('inside.svg')
  })

  it('IR-5 父会话读得到**子会话**的 artifact（子代理画的图要在父会话里展示得出来）', () => {
    const child = `${sid}-coding`
    state.children.set(sid, [{ id: child }])
    writeArtifact({
      sessionId: child,
      title: 'Drawn by the sub-agent',
      ext: 'svg',
      content: '<svg aria-label="Drawn by the sub-agent"/>'
    })
    expect(read(sid, 'drawn-by-the-sub-agent.svg')).toEqual({
      sessionId: child,
      name: 'drawn-by-the-sub-agent.svg',
      title: 'Drawn by the sub-agent',
      content: '<svg aria-label="Drawn by the sub-agent"/>',
      pinned: false,
      latest: true
    })
    // 按标题走同一条下探
    expect(read(sid, 'Drawn by the sub-agent')?.name).toBe('drawn-by-the-sub-agent.svg')
  })

  it('IR-6 本会话优先于子会话；只往下找一层，不递归', () => {
    const child = `${sid}-child`
    const grandchild = `${sid}-grandchild`
    state.children.set(sid, [{ id: child }])
    state.children.set(child, [{ id: grandchild }])
    // 同名两件：本会话那件必须赢（候选列表里它排第一）
    writeArtifact({ sessionId: sid, title: 'Shared', ext: 'svg', content: 'MINE' })
    writeArtifact({ sessionId: child, title: 'Shared', ext: 'svg', content: 'CHILD' })
    writeArtifact({ sessionId: grandchild, title: 'Deep', ext: 'svg', content: 'DEEP' })

    expect(read(sid, 'shared.svg')?.content).toBe('MINE')
    expect(read(child, 'shared.svg')?.content).toBe('CHILD')
    // 孙会话不在候选里（嵌套只有一层）—— 从子会话问才拿得到
    expect(read(sid, 'deep.svg')).toBeNull()
    expect(read(child, 'deep.svg')?.content).toBe('DEEP')
  })

  it('IR-7 取的是盘上**当前**内容（`edit` 之后再发一条同名引用就是新版）', () => {
    const made = writeArtifact({ sessionId: sid, title: 'Live', ext: 'svg', content: 'v1' })
    expect(read(sid, made.name)?.content).toBe('v1')
    writeFileSync(made.path, 'v2', 'utf-8')
    expect(read(sid, made.name)?.content).toBe('v2')
  })

  it('IR-8 不带 messageId：同步交回一个值（不是 Promise），带上 sessionId / pinned / latest；不碰会话宿主', () => {
    writeArtifact({
      sessionId: sid,
      title: 'Sync',
      ext: 'svg',
      content: '<svg aria-label="Sync"/>'
    })
    const handler = state.handlers.get('artifact:read')!
    const out = handler({ sender: { id: 1 } }, { sessionId: sid, name: 'sync.svg' })
    expect(out).not.toBeInstanceOf(Promise)
    expect(typeof (out as { then?: unknown }).then).toBe('undefined')
    expect(out).toEqual({
      sessionId: sid,
      name: 'sync.svg',
      title: 'Sync',
      content: '<svg aria-label="Sync"/>',
      pinned: false,
      latest: true
    })
    // 取不到也是同步的 null
    expect(handler({ sender: { id: 1 } }, { sessionId: sid, name: 'nope.svg' })).toBeNull()
    expect(state.peek).not.toHaveBeenCalled()
  })

  it('IR-9 带 messageId：交回 Promise；会话没开（peek → undefined）/ peek 抛错 / 宿主抛错 → 当前内容', async () => {
    writeArtifact({ sessionId: sid, title: 'Async', ext: 'svg', content: 'v1' })
    const current = {
      sessionId: sid,
      name: 'async.svg',
      // 内容里没有标题：回落文件名主干
      title: 'async',
      content: 'v1',
      pinned: false,
      latest: true
    }

    state.peek.mockResolvedValue(undefined)
    const pending = readAt(sid, 'async.svg', '7')
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toEqual(current)
    expect(state.peek).toHaveBeenCalledWith(sid)

    state.peek.mockRejectedValue(new Error('peek failed'))
    await expect(readAt(sid, 'async.svg', '7')).resolves.toEqual(current)
    state.peek.mockImplementation(() => {
      throw new Error('peek threw')
    })
    await expect(readAt(sid, 'async.svg', '7')).resolves.toEqual(current)

    state.hostThrows = true
    await expect(readAt(sid, 'async.svg', '7')).resolves.toEqual(current)

    // 不是十进制数字串的 messageId 也走这一路，照样是当前内容
    state.hostThrows = false
    state.peek.mockResolvedValue(undefined)
    await expect(readAt(sid, 'async.svg', 'abc')).resolves.toEqual(current)
    await expect(readAt(sid, 'missing.svg', '7')).resolves.toBeNull()
  })

  it('IR-10 带 messageId、没钉过：子会话的照样往下找一层（sessionId 是子会话）', async () => {
    const child = `${sid}-coding`
    state.children.set(sid, [{ id: child }])
    writeArtifact({
      sessionId: child,
      title: 'Kid',
      ext: 'svg',
      content: '<svg aria-label="Kid"/>'
    })
    state.peek.mockResolvedValue(undefined)
    await expect(readAt(sid, 'kid.svg', '3')).resolves.toEqual({
      sessionId: child,
      name: 'kid.svg',
      title: 'Kid',
      content: '<svg aria-label="Kid"/>',
      pinned: false,
      latest: true
    })
  })

  it('IR-11 带 messageId、会话开着、那条回复钉过：交回钉下的那一版（之后改了 → latest false）', async () => {
    const made = writeArtifact({
      sessionId: sid,
      title: 'Pinned',
      ext: 'svg',
      content: '<svg aria-label="Pinned"/>'
    })
    const t = await makeHost({ ephemeral: ['ir-pins'] })
    const session = await t.open('ir-pins')
    const [, answer] = await appendEntries(session, [
      userDraft('show', 1),
      assistantDraft('```artifact\npinned.svg\n```', 2)
    ])
    await pinFinalReply(session, sid)
    state.peek.mockResolvedValue(session)
    const mid = String(answer!.id)

    const pinned = {
      sessionId: sid,
      name: 'pinned.svg',
      title: 'Pinned',
      content: '<svg aria-label="Pinned"/>',
      pinned: true,
      latest: true
    }
    await expect(readAt(sid, 'pinned.svg', mid)).resolves.toEqual(pinned)
    writeFileSync(made.path, '<svg aria-label="Changed"/>', 'utf-8')
    await expect(readAt(sid, 'pinned.svg', mid)).resolves.toEqual({ ...pinned, latest: false })
    // 不带 messageId 就是现在的样子
    expect(read(sid, 'pinned.svg')?.content).toBe('<svg aria-label="Changed"/>')
  })
})
