/**
 * 临时会话（不属于任何项目）的 fork **共用源会话的工作目录** —— sessionService 这一层：`insertForkRow`
 * 写下的 `workingDirectory`、`getById` / `create`（子会话）读出来的答案，以及 `delete` 什么时候删、什么时候
 * 留着那个共用的临时工作区。
 *
 * 契约（sessionService 的 insertForkRow / delete / removeTempWorkspaceIfUnused 注释，utils/paths 的
 * tempWorkspaceOwnerOf，dao 的 existsWithWorkingDirectory）：
 *   - 无项目的源会话：fork 的 `settings.workingDirectory` = 源会话此刻解析出的工作目录（通常是它自己的
 *     `temp_workspace/<源 id>`，源会话自带了就是那一个）；项目会话的 fork 没有这个键；
 *   - fork 的 fork 指着最初那个文件夹；子会话随父会话（同一个文件夹）：临时会话的子会话共用父会话的
 *     `temp_workspace/<父 id>`，fork 下建的子会话共用 fork 借来的那一个；
 *   - 删一条会话：它自己的 `temp_workspace/<id>`，以及它借用的那一个（`workingDirectory` 正好是别的会话的
 *     `temp_workspace/<id>` 本身）—— 各自只在「主人那一行没了、也没有任何会话（库里的或活着的内存会话）
 *     的 workingDirectory 正是它」时删；用户自己的目录（md 窗口）从不删。
 *
 * 真的 SQLite（内存库跑全部迁移）、真的 sessionRecords / sessionService / sessionDao、**真的 utils/paths**
 * （electron 的 userData 与 HOME 都指到每个用例自己的临时目录）；会话运行时换成假宿主
 * （support/fakeSessionHost），其余 import 图照 sessionFork.test.ts 换成假件。`fs.rmSync` 外面包一层，
 * 只为 FW-13 能让它在临时工作区底下抛错。
 *
 *   FW-1  临时源会话 → fork 的 workingDirectory = getTempWorkspace(S) = getById(S).workingDirectory；
 *         getById(F) 同一个；projectId null、parentId 照抄；不建 temp_workspace/<F>
 *   FW-2  fork 的 fork 指着 S 的文件夹
 *   FW-3  项目源会话 → 没有 workingDirectory 键（源会话设置里带着也不抄）；getById(F) 是项目根
 *   FW-4  先删源会话 → 文件夹留着；再删 fork → 删掉（也不留 temp_workspace/<F>）
 *   FW-5  先删 fork → 留着；再删源会话 → 删掉
 *   FW-6  [S, F1, F2] 的 6 种删除次序 ×（F2 是 S 的 fork / F1 的 fork）：删两条还在，删第三条才没
 *   FW-7  F 下建的子会话 C 随 S 的文件夹；删 S 留着；删 F（级联 C）删掉；变体：S 已删，单删 C 留着，再删 F 删掉
 *   FW-8  workingDirectory 是 base / userData / base/X/sub / base/x..y / 用户目录的临时会话被删 → 哪个哨兵都在
 *   FW-9  md 窗口（内存会话）用的是用户目录（basename 像会话 id；或用户目录恰在别处的 temp_workspace/<uuid>）→ 删它都不动
 *   FW-10 md 窗口的目录正是 S 的文件夹：它活着时删 S → 留着；再删它 → 删掉（钉住现状）
 *   FW-11 md 窗口在 base/S/docs：删它什么都不删；删 S 连 docs 一起删掉（两种次序，钉住现状）
 *   FW-12 回归：没有 fork 的临时会话删掉自己的文件夹；删项目会话（及其 fork）不碰项目根
 *   FW-13 rmSync 抛错不让 delete 失败
 *   FW-14 Promise.all([delete(S), delete(F)]) → 两行都没了，文件夹删掉
 *   FW-15 settings 是坏 JSON 的一行照样删得掉（delete 先读借用的工作目录，读不出来就当没借用）
 *   FW-16 临时会话 P 的子会话 C：workingDirectory = P 的临时工作区（P 没问过也建出来），不建 temp_workspace/<C>，
 *         权限表的工作目录行就是它；删 P（级联 C）删掉；单删 C 留着，再删 P 删掉；内存父会话同样；
 *         项目父会话不写键也不建 temp_workspace/<P>；父指针落空 → 退回 C 自己的临时工作区
 *
 * bot 会话只归属 bot，项目只是它的工作位置（引用 `settings.workProject` + 路径快照 `settings.workingDirectory`，
 * chat-protocol `projectContextIdOf`）：
 *   BW-1  create({bot, workProject}) → projectId null、引用 + 快照；getById 是项目根；不在 findByProjectId 里；
 *         权限表的工作目录行是项目根；workProject 先于 projectId；旧入口只给 projectId 也记成引用；笔记本 bot 仍是成员
 *   BW-2  项目行被删 → 会话还在，退回快照；项目改路径 → 快照跟着搬（projectService.update），之后再删项目退回的是新路径；
 *         别的会话（成员、临时、引用别的项目）的设置不动
 *   BW-3  子会话、fork 抄引用与快照；项目删了之后的 fork / 子会话用快照；临时 bot 会话的子会话共用父会话的临时工作区
 *   BW-4  项目根里的哨兵文件经得起删 bot 会话、它的子会话与 fork（项目在或不在都一样）
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFakeHost } from './support/fakeSessionHost'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  userData: '',
  projectRoot: '',
  /** 假的项目表（projectDao 桩读写它）：每个用例重置成只有 p1 */
  projects: {} as Record<string, { path: string; settings: Record<string, unknown> }>,
  /** 非空时，sessionService 删这个目录底下的东西会抛错（FW-13） */
  rmThrowsUnder: ''
}))

const mocks = vi.hoisted(() => ({
  listChanged: vi.fn<() => void>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => holder.userData,
    getAppPath: () => holder.userData,
    isPackaged: false
  }
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const rmSync: typeof actual.rmSync = (path, options) => {
    if (holder.rmThrowsUnder && String(path).startsWith(holder.rmThrowsUnder)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${String(path)}'`), {
        code: 'EBUSY'
      })
    }
    return actual.rmSync(path, options)
  }
  return { ...actual, rmSync, default: { ...actual, rmSync } }
})
vi.mock('../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return holder.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (holder.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => holder.db } }
})
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: () => [],
    findEnabled: () => [],
    findEnabledModels: () => []
  }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: () => undefined } }))
vi.mock('../../dao/projectDao', () => ({
  projectDao: {
    pick: (id: string) => (holder.projects[id] ? { ...holder.projects[id] } : undefined),
    // projectService.update / delete 落到这两个（BW-2）
    update: (id: string, patch: { path?: string }) => {
      if (holder.projects[id] && patch.path !== undefined) holder.projects[id].path = patch.path
    },
    deleteById: (id: string) => {
      delete holder.projects[id]
    }
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string>) =>
    vars?.title !== undefined ? `${vars.title} · fork` : key
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: mocks.listChanged,
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn(async () => {}) } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: (tools: string[]) => tools }))
vi.mock('../agentService', () => ({
  agentService: { getProfile: (name: string) => ({ name }), isSessionProfile: () => true }
}))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
// 会话权限表（services/acl）是真的（落在同一个内存库的 session_acl 上）：建会话 / fork 时按会话的工作目录
// 派生行 —— 读工作目录走的是真的 getTempWorkspace，所以哪些文件夹被建出来也算在它头上。派生行要的
// 「会话自己的目录」按 id 拼（真的那份要 realpath）；知识库与技能目录一个都没有
vi.mock('../sandbox', () => ({
  cleanupSession: vi.fn(),
  sessionOwnDirsView: (sid: string, workingDirectory: string) => ({
    workdir: workingDirectory,
    workspaceUnsuitable: null,
    tmp: `/sandbox-tmp/${sid}`,
    artifacts: `/artifacts/${sid}`,
    toolResults: `/tool-results/${sid}`
  }),
  settingDirForAcl: () => null
}))
vi.mock('../knowledge/sessionBundle', () => ({ enabledTargets: () => [] }))
vi.mock('../skillService', () => ({ skillService: { enabledSkillRoots: () => [] } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session, SessionSettings } from '../../dao/types'
import { getTempWorkspace, getTempWorkspaceBase } from '../../utils/paths'
import { sessionRecords } from '../sessionRecords'
import { sessionAcl } from '../acl'
import { clearMemoryAclForTests } from '../acl/store'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

let sessionService: (typeof import('../sessionService'))['sessionService']
let projectService: (typeof import('../projectService'))['projectService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ projectService } = await import('../projectService'))
})

let root: string
const ORIGINAL_HOME = process.env.HOME

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  root = mkdtempSync(join(tmpdir(), 'shuvix-fork-ws-'))
  holder.userData = join(root, 'userData')
  mkdirSync(holder.userData, { recursive: true })
  holder.projectRoot = join(root, 'project-root')
  mkdirSync(holder.projectRoot, { recursive: true })
  writeFileSync(join(holder.projectRoot, 'README.md'), '# project\n')
  holder.projects = { p1: { path: holder.projectRoot, settings: {} } }
  holder.rmThrowsUnder = ''
  process.env.HOME = join(root, 'home')
  sessionRecords.clearEphemeralForTests()
  // 权限表的对账记忆是进程级的：每个用例一个新库，同一个会话 id 得重新对一次
  sessionAcl.forgetReconciled()
  clearMemoryAclForTests()
  resetFakeHost()
  mocks.listChanged.mockReset()
})

afterEach(() => {
  holder.rmThrowsUnder = ''
  process.env.HOME = ORIGINAL_HOME
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

// ─── 小工具 ─────────────────────────────────────

const base = (): string => getTempWorkspaceBase()
const tempOf = (id: string): string => join(base(), id)

/** 一条普通的临时会话（create 出来的，不属于项目），id 由调用方定好记 */
function createTemp(id: string, patch: { parentId?: string } = {}): string {
  return sessionService.create({ title: id, ...patch }, { id }).id
}

/** 源会话的工作目录（getById 解析，真的 getTempWorkspace 会把它建出来）里放一个哨兵文件 */
function seedSentinel(sessionId: string): string {
  const dir = sessionService.getById(sessionId)!.workingDirectory as string
  writeFileSync(join(dir, 'keep.txt'), sessionId)
  return dir
}

/** insertForkRow(源会话此刻的行, forkId) */
function forkOf(sourceId: string, forkId: string): string {
  const source = sessionRecords.findById(sourceId)
  if (!source) throw new Error(`no source ${sourceId}`)
  return sessionService.insertForkRow(source, forkId).id
}

/** 越过 create 直接插一行（任意 settings） */
function insertRaw(id: string, patch: Partial<Session> = {}, ephemeral = false): string {
  sessionRecords.insert(
    {
      id,
      title: id,
      projectId: null,
      parentId: null,
      storageKind: 'durable-sqlite-1',
      settings: { enabledTools: [] },
      createdAt: 1,
      updatedAt: 1,
      lastActiveAt: 1,
      ...patch
    },
    { ephemeral }
  )
  return id
}

/** 一个目录连同哨兵文件还在 */
function expectKept(dir: string, content?: string): void {
  expect(existsSync(dir)).toBe(true)
  if (content !== undefined) expect(readFileSync(join(dir, 'keep.txt'), 'utf-8')).toBe(content)
}

function writeSentinel(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'keep.txt'), content)
  return dir
}

// ─── FW-1..3：fork 的那一行 ─────────────────────────

describe('FW-1..3 the fork row points at the source working folder', () => {
  it('FW-1 temp source → settings.workingDirectory = getTempWorkspace(S) = getById(S).workingDirectory; getById(F) the same; projectId null, parentId null; no temp_workspace/<F>', () => {
    const S = createTemp('S')
    const fork = sessionService.insertForkRow(sessionRecords.findById(S)!, 'F')

    const sDir = sessionService.getById(S)!.workingDirectory
    expect(sDir).toBe(tempOf(S))
    expect(fork.settings.workingDirectory).toBe(sDir)
    expect(fork.settings.workingDirectory).toBe(getTempWorkspace(S))

    const stored = sessionRecords.findById('F')!
    expect(stored.settings.workingDirectory).toBe(sDir)
    expect(stored.projectId).toBeNull()
    expect(stored.parentId).toBeNull()
    expect(sessionService.getById('F')!.workingDirectory).toBe(sDir)
    // 共用的文件夹在（fork 一打开就能用），fork 自己的临时工作区从没被建出来
    expect(existsSync(sDir as string)).toBe(true)
    expect(existsSync(tempOf('F'))).toBe(false)
  })

  it('FW-1 the folder is resolved even when nobody asked for the source working dir before the fork', () => {
    const S = createTemp('S')
    expect(existsSync(tempOf(S))).toBe(false)
    forkOf(S, 'F')
    expect(sessionRecords.findById('F')!.settings.workingDirectory).toBe(tempOf(S))
    expect(existsSync(tempOf(S))).toBe(true)
    expect(existsSync(tempOf('F'))).toBe(false)
  })

  it('FW-1 temp sub-session source → parentId copied, and the fork shares the folder the child shares with its parent', () => {
    const P = createTemp('P')
    const C = createTemp('C', { parentId: P })
    forkOf(C, 'F')
    const stored = sessionRecords.findById('F')!
    expect(stored.parentId).toBe(P)
    expect(stored.projectId).toBeNull()
    expect(stored.settings.workingDirectory).toBe(tempOf(P))
    expect(sessionService.getById('F')!.workingDirectory).toBe(tempOf(P))
    expect(existsSync(tempOf(C))).toBe(false)
    expect(existsSync(tempOf('F'))).toBe(false)
  })

  it('FW-2 a fork of a fork points at the original folder, not at the first fork', () => {
    const S = createTemp('S')
    forkOf(S, 'F1')
    forkOf('F1', 'F2')
    expect(sessionRecords.findById('F2')!.settings.workingDirectory).toBe(tempOf(S))
    expect(sessionService.getById('F2')!.workingDirectory).toBe(tempOf(S))
    expect(existsSync(tempOf('F1'))).toBe(false)
    expect(existsSync(tempOf('F2'))).toBe(false)
  })

  it('FW-3 project source → no workingDirectory key even when the source settings carry one; getById(F) is the project root', () => {
    const S = sessionService.create({ projectId: 'p1' }, { id: 'S' }).id
    sessionRecords.updateSettings(S, { workingDirectory: '/somewhere/else' })
    expect(sessionRecords.findById(S)!.settings.workingDirectory).toBe('/somewhere/else')

    const fork = sessionService.insertForkRow(sessionRecords.findById(S)!, 'F')
    expect(fork.settings).not.toHaveProperty('workingDirectory')
    expect(sessionRecords.findById('F')!.settings).not.toHaveProperty('workingDirectory')
    expect(sessionRecords.findById('F')!.projectId).toBe('p1')
    expect(sessionService.getById('F')!.workingDirectory).toBe(holder.projectRoot)
    expect(existsSync(tempOf(S))).toBe(false)
    expect(existsSync(tempOf('F'))).toBe(false)
  })
})

// ─── FW-4..7：删除次序 ─────────────────────────

describe('FW-4..7 the shared folder lives until its last user is deleted', () => {
  it('FW-4 source first → kept; then the fork → removed, and no temp_workspace/<F> left', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    forkOf(S, 'F')

    await sessionService.delete(S)
    expect(sessionRecords.findById(S)).toBeUndefined()
    expectKept(sDir, S)
    // fork 照旧在那儿工作
    expect(sessionService.getById('F')!.workingDirectory).toBe(sDir)

    await sessionService.delete('F')
    expect(sessionRecords.findById('F')).toBeUndefined()
    expect(existsSync(sDir)).toBe(false)
    expect(existsSync(tempOf('F'))).toBe(false)
  })

  it('FW-5 fork first → kept; then the source → removed', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    forkOf(S, 'F')

    await sessionService.delete('F')
    expectKept(sDir, S)
    expect(existsSync(tempOf('F'))).toBe(false)

    await sessionService.delete(S)
    expect(existsSync(sDir)).toBe(false)
  })

  const ORDERS: Array<[string, string, string]> = [
    ['S', 'F1', 'F2'],
    ['S', 'F2', 'F1'],
    ['F1', 'S', 'F2'],
    ['F1', 'F2', 'S'],
    ['F2', 'S', 'F1'],
    ['F2', 'F1', 'S']
  ]
  it.each(
    (['S', 'F1'] as const).flatMap((f2Source) =>
      ORDERS.map((order) => [f2Source, order.join(' → '), order] as const)
    )
  )(
    'FW-6 F2 forked from %s, delete order %s: kept after two deletes, gone after the third',
    async (f2Source, _label, order) => {
      createTemp('S')
      const sDir = seedSentinel('S')
      forkOf('S', 'F1')
      forkOf(f2Source, 'F2')
      expect(sessionRecords.findById('F2')!.settings.workingDirectory).toBe(sDir)

      await sessionService.delete(order[0])
      expectKept(sDir, 'S')
      await sessionService.delete(order[1])
      expectKept(sDir, 'S')
      await sessionService.delete(order[2])
      expect(existsSync(sDir)).toBe(false)
      for (const id of ['S', 'F1', 'F2']) {
        expect(sessionRecords.findById(id)).toBeUndefined()
        if (id !== 'S') expect(existsSync(tempOf(id))).toBe(false)
      }
    }
  )

  it("FW-7 a sub-session C created under the fork inherits S's folder; deleting S keeps it; deleting F (cascading C) removes it", async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    forkOf(S, 'F')
    const C = sessionService.create({ parentId: 'F' }, { id: 'C' }).id
    expect(sessionRecords.findById(C)!.settings.workingDirectory).toBe(sDir)
    expect(sessionService.getById(C)!.workingDirectory).toBe(sDir)
    expect(existsSync(tempOf(C))).toBe(false)

    await sessionService.delete(S)
    expectKept(sDir, S)

    await sessionService.delete('F')
    expect(sessionRecords.findById('F')).toBeUndefined()
    expect(sessionRecords.findById(C)).toBeUndefined()
    expect(existsSync(sDir)).toBe(false)
    expect(existsSync(tempOf('F'))).toBe(false)
    expect(existsSync(tempOf(C))).toBe(false)
  })

  it('FW-7 variant: S gone, deleting C alone keeps the folder (F still uses it); then deleting F removes it', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    forkOf(S, 'F')
    const C = sessionService.create({ parentId: 'F' }, { id: 'C' }).id

    await sessionService.delete(S)
    await sessionService.delete(C)
    expect(sessionRecords.findById(C)).toBeUndefined()
    expectKept(sDir, S)

    await sessionService.delete('F')
    expect(existsSync(sDir)).toBe(false)
  })
})

// ─── FW-8 / FW-9：不是临时工作区的目录从不删 ─────────────────

describe('FW-8/9 folders that are not exactly some session temp workspace are never removed', () => {
  /** 一圈哨兵：base 本身、userData、一个没有行的会话文件夹里的子目录、名字不安全的兄弟、另一个没有行的会话文件夹、用户目录 */
  function seedSentinels(): Record<string, string> {
    return {
      base: writeSentinel(base(), 'base'),
      userData: writeSentinel(holder.userData, 'userData'),
      goneSub: writeSentinel(join(base(), 'GONE', 'sub'), 'goneSub'),
      gone: writeSentinel(join(base(), 'GONE'), 'gone'),
      unsafe: writeSentinel(`${base()}/x..y`, 'unsafe'),
      other: writeSentinel(join(base(), 'OTHER'), 'other'),
      user: writeSentinel(join(root, 'Users', 'me', 'docs'), 'user')
    }
  }

  it.each<[string, (s: Record<string, string>) => string]>([
    ['the temp_workspace base itself', (s) => s.base!],
    ['<userData>', (s) => s.userData!],
    ['a subfolder of a session folder whose row is gone', (s) => s.goneSub!],
    ['a base child whose name is not a safe session id', (s) => s.unsafe!],
    ['a user folder', (s) => s.user!]
  ])(
    'FW-8 a temp row whose workingDirectory is %s → deleting it leaves every sentinel in place',
    async (_label, pick) => {
      const sentinels = seedSentinels()
      insertRaw('R', { settings: { enabledTools: [], workingDirectory: pick(sentinels) } })

      await sessionService.delete('R')

      expect(sessionRecords.findById('R')).toBeUndefined()
      for (const [name, dir] of Object.entries(sentinels)) expectKept(dir, name)
      expect(existsSync(tempOf('R'))).toBe(false)
    }
  )

  it('FW-9 a markdown window (in-memory session) on a user folder with a uuid-like name → deleting it leaves the folder, and the same-named base child, alone', async () => {
    const UUID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b'
    const userDir = writeSentinel(join(root, 'Users', 'me', UUID), 'user')
    writeFileSync(join(userDir, 'a.md'), '# mine\n')
    const sameName = writeSentinel(tempOf(UUID), 'same-name')

    const M = sessionService.create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: userDir }
    )
    expect(sessionRecords.isEphemeral(M.id)).toBe(true)
    await sessionService.delete(M.id)

    expectKept(userDir, 'user')
    expect(readFileSync(join(userDir, 'a.md'), 'utf-8')).toBe('# mine\n')
    expectKept(sameName, 'same-name')
    expect(existsSync(tempOf(M.id))).toBe(false)
  })

  it('FW-9 a markdown window whose user folder is literally <elsewhere>/temp_workspace/<uuid> → left alone', async () => {
    const UUID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5c'
    const userDir = writeSentinel(join(root, 'other', 'temp_workspace', UUID), 'user')
    const sameName = writeSentinel(tempOf(UUID), 'same-name')

    const M = sessionService.create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: userDir }
    )
    await sessionService.delete(M.id)

    expectKept(userDir, 'user')
    expectKept(sameName, 'same-name')
  })
})

// ─── FW-10 / FW-11：md 窗口与临时工作区重叠（钉住现状） ─────────────────

describe('FW-10/11 markdown windows overlapping a temp workspace (current behaviour)', () => {
  it("FW-10 a markdown window whose folder is exactly S's: deleting S while it is open keeps the folder; deleting the window then removes it", async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    const M = sessionService.create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: sDir }
    )

    await sessionService.delete(S)
    expectKept(sDir, S)

    await sessionService.delete(M.id)
    expect(existsSync(sDir)).toBe(false)
  })

  it('FW-11 a markdown window at <S folder>/docs: deleting the window removes nothing; deleting S then removes the folder', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    const docs = writeSentinel(join(sDir, 'docs'), 'docs')
    const M = sessionService.create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: docs }
    )

    await sessionService.delete(M.id)
    expectKept(sDir, S)
    expectKept(docs, 'docs')

    await sessionService.delete(S)
    expect(existsSync(sDir)).toBe(false)
  })

  it("FW-11 deleting S while a markdown window is open at <S folder>/docs removes S's folder including docs; the window's delete afterwards still resolves", async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    const docs = writeSentinel(join(sDir, 'docs'), 'docs')
    const M = sessionService.create(
      { title: 'a.md', notebookPath: 'a.md' },
      { ephemeral: true, workingDirectory: docs }
    )

    await sessionService.delete(S)
    expect(existsSync(sDir)).toBe(false)
    expect(existsSync(docs)).toBe(false)

    await expect(sessionService.delete(M.id)).resolves.toBeUndefined()
    expect(sessionRecords.findById(M.id)).toBeUndefined()
  })
})

// ─── FW-12..15：回归与边角 ─────────────────

describe('FW-12..15 regressions and corners', () => {
  it('FW-12 a plain temp session with no fork removes its own folder (with its files)', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    await sessionService.delete(S)
    expect(existsSync(sDir)).toBe(false)
  })

  it('FW-12 a temp session whose folder was never created leaves none behind after its delete', async () => {
    const S = createTemp('S')
    expect(existsSync(tempOf(S))).toBe(false)
    await sessionService.delete(S)
    expect(existsSync(tempOf(S))).toBe(false)
  })

  it('FW-12 deleting a project session, and a fork of it, leaves the project root intact', async () => {
    const S = sessionService.create({ projectId: 'p1' }, { id: 'S' }).id
    forkOf(S, 'F')
    await sessionService.delete('F')
    await sessionService.delete(S)
    expect(readFileSync(join(holder.projectRoot, 'README.md'), 'utf-8')).toBe('# project\n')
    expect(existsSync(tempOf(S))).toBe(false)
    expect(existsSync(tempOf('F'))).toBe(false)
  })

  it('FW-13 rmSync throwing does not fail the delete (the row is gone, the folder simply stays)', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    holder.rmThrowsUnder = base()

    await expect(sessionService.delete(S)).resolves.toBeUndefined()
    expect(sessionRecords.findById(S)).toBeUndefined()
    // rmSync 真的被叫到并抛了：文件夹还在
    expectKept(sDir, S)
  })

  it('FW-13 the same for the borrowed folder: deleting the last fork while rmSync throws still resolves', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    forkOf(S, 'F')
    await sessionService.delete(S)
    holder.rmThrowsUnder = base()

    await expect(sessionService.delete('F')).resolves.toBeUndefined()
    expect(sessionRecords.findById('F')).toBeUndefined()
    expectKept(sDir, S)
  })

  it('FW-14 Promise.all([delete(S), delete(F)]) → both rows gone and the folder removed', async () => {
    const S = createTemp('S')
    const sDir = seedSentinel(S)
    forkOf(S, 'F')

    await Promise.all([sessionService.delete(S), sessionService.delete('F')])

    expect(sessionRecords.findById(S)).toBeUndefined()
    expect(sessionRecords.findById('F')).toBeUndefined()
    expect(existsSync(sDir)).toBe(false)
    expect(existsSync(tempOf('F'))).toBe(false)
  })

  // delete 在删行之前经 sessionRecords.pickSettings 读 workingDirectory，而 sessionDao.pickSettings 用
  // `settings -> '$.key'`，对坏 JSON 抛 "malformed JSON" —— delete 接住它、当没借用什么，照样删完。
  it('FW-15 a row whose settings JSON is corrupt can still be deleted', async () => {
    insertRaw('R', { settings: {} as SessionSettings })
    ;(holder.db as DatabaseSync)
      .prepare('UPDATE sessions SET settings = ? WHERE id = ?')
      .run('{bad', 'R')

    await sessionService.delete('R')
    expect(sessionRecords.findById('R')).toBeUndefined()
  })
})

// ─── FW-16：临时会话的子会话共用父会话的临时工作区 ─────────────────

describe("FW-16 a temp session's sub-session shares the parent's temp workspace", () => {
  it('FW-16 create → settings.workingDirectory = getById(P).workingDirectory; getById(C) the same; the folder exists even if P never asked; no temp_workspace/<C>', () => {
    const P = createTemp('P')
    expect(existsSync(tempOf(P))).toBe(false)
    const C = createTemp('C', { parentId: P })

    expect(sessionRecords.findById(C)!.settings.workingDirectory).toBe(tempOf(P))
    expect(sessionService.getById(P)!.workingDirectory).toBe(tempOf(P))
    expect(sessionService.getById(C)!.workingDirectory).toBe(tempOf(P))
    expect(existsSync(tempOf(P))).toBe(true)
    expect(existsSync(tempOf(C))).toBe(false)
  })

  it("FW-16 the child's permission table derives its working-directory row from the shared folder", () => {
    const P = createTemp('P')
    const C = createTemp('C', { parentId: P })
    const row = sessionAcl.entries(C).find((e) => e.source === 'workdir')!
    expect(row.target).toBe(tempOf(P))
    expect(row.access).toBe('write')
  })

  it('FW-16 deleting the parent (cascading the child) removes the folder with what the child wrote', async () => {
    const P = createTemp('P')
    const pDir = seedSentinel(P)
    const C = createTemp('C', { parentId: P })
    writeFileSync(join(sessionService.getById(C)!.workingDirectory as string, 'child.txt'), C)
    expect(readFileSync(join(pDir, 'child.txt'), 'utf-8')).toBe(C)

    await sessionService.delete(P)
    expect(sessionRecords.findById(P)).toBeUndefined()
    expect(sessionRecords.findById(C)).toBeUndefined()
    expect(existsSync(pDir)).toBe(false)
    expect(existsSync(tempOf(C))).toBe(false)
  })

  it('FW-16 deleting the child alone keeps the folder; then deleting the parent removes it', async () => {
    const P = createTemp('P')
    const pDir = seedSentinel(P)
    const C = createTemp('C', { parentId: P })

    await sessionService.delete(C)
    expect(sessionRecords.findById(C)).toBeUndefined()
    expectKept(pDir, P)

    await sessionService.delete(P)
    expect(existsSync(pDir)).toBe(false)
  })

  it('FW-16 an in-memory parent: the child is in-memory too and shares the folder; deleting the parent removes it', async () => {
    const P = sessionService.create({ title: 'P' }, { id: 'P', ephemeral: true }).id
    const C = createTemp('C', { parentId: P })
    expect(sessionRecords.isEphemeral(C)).toBe(true)
    expect(sessionRecords.findById(C)!.settings.workingDirectory).toBe(tempOf(P))
    const pDir = seedSentinel(P)

    await sessionService.delete(P)
    expect(sessionRecords.findById(C)).toBeUndefined()
    expect(existsSync(pDir)).toBe(false)
    expect(existsSync(tempOf(C))).toBe(false)
  })

  it("FW-16 a project parent → no workingDirectory key and no temp_workspace/<P>; the child's folder is the project root", () => {
    const P = sessionService.create({ projectId: 'p1' }, { id: 'P' }).id
    const C = createTemp('C', { parentId: P })
    expect(sessionRecords.findById(C)!.settings).not.toHaveProperty('workingDirectory')
    expect(sessionService.getById(C)!.workingDirectory).toBe(holder.projectRoot)
    expect(existsSync(tempOf(P))).toBe(false)
    expect(existsSync(tempOf(C))).toBe(false)
  })

  it('FW-16 a parent pointer to a missing row → no workingDirectory key; the child falls back to its own temp workspace', () => {
    const C = createTemp('C', { parentId: 'ghost' })
    expect(sessionRecords.findById(C)!.settings).not.toHaveProperty('workingDirectory')
    expect(sessionService.getById(C)!.workingDirectory).toBe(tempOf(C))
    expect(existsSync(tempOf('ghost'))).toBe(false)
  })
})

// ─── BW-1..4：bot 会话引用工作项目 ─────────────────

/** 一条选了项目 `projectId` 当工作位置的 bot 会话 */
function createBot(id: string, workProject?: string): string {
  return sessionService.create({ title: id, bot: 'scout', workProject }, { id }).id
}

/** 再加一个项目（p1 之外），根目录里放一份 README 当哨兵 */
function addProject(id: string): string {
  const dir = join(root, `project-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), `# ${id}\n`)
  holder.projects[id] = { path: dir, settings: {} }
  return dir
}

describe('BW-1..4 a bot session references its work project instead of belonging to it', () => {
  it('BW-1 create({bot, workProject}) → projectId null, reference + path snapshot; getById is the project root; not a member of the project', () => {
    const B = createBot('B', 'p1')
    const stored = sessionRecords.findById(B)!
    expect(stored.projectId).toBeNull()
    expect(stored.settings.bot).toBe('scout')
    expect(stored.settings.workProject).toBe('p1')
    expect(stored.settings.workingDirectory).toBe(holder.projectRoot)
    expect(sessionService.getById(B)!.workingDirectory).toBe(holder.projectRoot)
    // 成员关系只看 projectId：按项目列会话（侧栏分组、项目删除的级联）看不见它
    expect(sessionRecords.findByProjectId('p1').map((s) => s.id)).not.toContain(B)
    // 权限表的工作目录行同样是项目根（acl/workdir 经 projectContextIdOf）
    const row = sessionAcl.entries(B).find((e) => e.source === 'workdir')!
    expect(row.target).toBe(holder.projectRoot)
    // 临时工作区从没被建出来
    expect(existsSync(tempOf(B))).toBe(false)
  })

  it('BW-1 workProject beats projectId; the old entry that only passes projectId is converted to a reference too', () => {
    const p2 = addProject('p2')
    const both = sessionService.create(
      { title: 'both', bot: 'scout', workProject: 'p2', projectId: 'p1' },
      { id: 'BOTH' }
    ).id
    expect(sessionRecords.findById(both)!.projectId).toBeNull()
    expect(sessionRecords.findById(both)!.settings.workProject).toBe('p2')
    expect(sessionService.getById(both)!.workingDirectory).toBe(p2)

    const legacy = sessionService.create(
      { title: 'old', bot: 'scout', projectId: 'p1' },
      { id: 'OLD' }
    ).id
    expect(sessionRecords.findById(legacy)!.projectId).toBeNull()
    expect(sessionRecords.findById(legacy)!.settings.workProject).toBe('p1')
    expect(sessionService.getById(legacy)!.workingDirectory).toBe(holder.projectRoot)
    expect(sessionRecords.findByProjectId('p1')).toEqual([])
  })

  it('BW-1 a missing project → temporary: no reference, no snapshot, its own temp workspace', () => {
    const B = createBot('B', 'nope')
    const stored = sessionRecords.findById(B)!
    expect(stored.projectId).toBeNull()
    expect(stored.settings).not.toHaveProperty('workProject')
    expect(stored.settings).not.toHaveProperty('workingDirectory')
    expect(sessionService.getById(B)!.workingDirectory).toBe(tempOf(B))
  })

  it('BW-1 a notebook bot (bot file opened as a notebook) stays a member of its carrier project', () => {
    const N = sessionService.create(
      { title: 'n', bot: 'scout', notebookPath: 'scout.md', projectId: 'p1' },
      { id: 'N' }
    ).id
    const stored = sessionRecords.findById(N)!
    expect(stored.projectId).toBe('p1')
    expect(stored.settings).not.toHaveProperty('workProject')
    expect(sessionRecords.findByProjectId('p1').map((s) => s.id)).toEqual([N])
    expect(sessionService.getById(N)!.workingDirectory).toBe(holder.projectRoot)
  })

  it('BW-2 the project row deleted → the session survives and falls back to its path snapshot', () => {
    const B = createBot('B', 'p1')
    projectService.delete('p1')
    expect(holder.projects.p1).toBeUndefined()

    const stored = sessionRecords.findById(B)!
    expect(stored).toBeDefined()
    expect(stored.settings.workProject).toBe('p1')
    expect(sessionService.getById(B)!.workingDirectory).toBe(holder.projectRoot)
    const row = sessionAcl.entries(B).find((e) => e.source === 'workdir')!
    expect(row.target).toBe(holder.projectRoot)
  })

  it('BW-2 the project moved (projectService.update path) → the snapshot follows; deleting the project afterwards falls back to the new path', () => {
    const B = createBot('B', 'p1')
    const C = sessionService.create({ parentId: B }, { id: 'C' }).id
    const moved = join(root, 'moved-root')
    mkdirSync(moved, { recursive: true })

    projectService.update('p1', { path: moved })
    expect(sessionRecords.findById(B)!.settings.workingDirectory).toBe(moved)
    expect(sessionRecords.findById(C)!.settings.workingDirectory).toBe(moved)
    expect(sessionService.getById(B)!.workingDirectory).toBe(moved)

    projectService.delete('p1')
    expect(sessionService.getById(B)!.workingDirectory).toBe(moved)
    expect(sessionService.getById(C)!.workingDirectory).toBe(moved)
  })

  it('BW-2 a path change leaves other sessions alone: members, temp sessions and references to another project', () => {
    const p2 = addProject('p2')
    const member = sessionService.create({ projectId: 'p1' }, { id: 'M' }).id
    const temp = createTemp('T')
    sessionRecords.updateSettings(temp, { workingDirectory: '/elsewhere' })
    const other = createBot('O', 'p2')
    const before = {
      member: JSON.stringify(sessionRecords.findById(member)!.settings),
      temp: JSON.stringify(sessionRecords.findById(temp)!.settings),
      other: JSON.stringify(sessionRecords.findById(other)!.settings)
    }

    projectService.update('p1', { path: join(root, 'moved-root') })

    expect(JSON.stringify(sessionRecords.findById(member)!.settings)).toBe(before.member)
    expect(JSON.stringify(sessionRecords.findById(temp)!.settings)).toBe(before.temp)
    expect(JSON.stringify(sessionRecords.findById(other)!.settings)).toBe(before.other)
    expect(sessionRecords.findById(other)!.settings.workingDirectory).toBe(p2)
  })

  it('BW-3 a sub-session and a fork copy the reference and the snapshot; neither is a member', () => {
    const B = createBot('B', 'p1')
    const C = sessionService.create({ parentId: B }, { id: 'C' }).id
    forkOf(B, 'F')

    for (const id of [C, 'F']) {
      const stored = sessionRecords.findById(id)!
      expect(stored.projectId, id).toBeNull()
      expect(stored.settings.workProject, id).toBe('p1')
      expect(stored.settings.workingDirectory, id).toBe(holder.projectRoot)
      expect(sessionService.getById(id)!.workingDirectory, id).toBe(holder.projectRoot)
      expect(existsSync(tempOf(id)), id).toBe(false)
    }
    expect(sessionRecords.findById('F')!.settings.bot).toBe('scout')
    // 子会话不带 bot（BSess-Sub），但带着工作位置
    expect(sessionRecords.findById(C)!.settings).not.toHaveProperty('bot')
    expect(sessionRecords.findByProjectId('p1')).toEqual([])
  })

  it('BW-3 after the project is deleted, a fork and a new sub-session use the snapshot', () => {
    const B = createBot('B', 'p1')
    projectService.delete('p1')
    forkOf(B, 'F')
    const C = sessionService.create({ parentId: B }, { id: 'C' }).id

    for (const id of ['F', C]) {
      const stored = sessionRecords.findById(id)!
      expect(stored.settings.workProject, id).toBe('p1')
      expect(stored.settings.workingDirectory, id).toBe(holder.projectRoot)
      expect(sessionService.getById(id)!.workingDirectory, id).toBe(holder.projectRoot)
    }
  })

  it("BW-3 a temp bot session's child shares the parent's temp workspace", () => {
    const T = createBot('T')
    expect(sessionRecords.findById(T)!.settings).not.toHaveProperty('workProject')
    const C = sessionService.create({ parentId: T }, { id: 'C' }).id
    const stored = sessionRecords.findById(C)!
    expect(stored.settings).not.toHaveProperty('workProject')
    expect(stored.settings.workingDirectory).toBe(tempOf(T))
    expect(sessionService.getById(C)!.workingDirectory).toBe(tempOf(T))
    expect(existsSync(tempOf(C))).toBe(false)
  })

  it('BW-4 a sentinel in the project root survives deleting the bot session, its child and its fork', async () => {
    const B = createBot('B', 'p1')
    sessionService.create({ parentId: B }, { id: 'C' })
    forkOf(B, 'F')
    writeSentinel(holder.projectRoot, 'project')

    await sessionService.delete('F')
    await sessionService.delete(B)
    expect(sessionRecords.findById('C')).toBeUndefined()
    expectKept(holder.projectRoot, 'project')
    expect(readFileSync(join(holder.projectRoot, 'README.md'), 'utf-8')).toBe('# project\n')
  })

  it('BW-4 the same once the project is deleted (the snapshot points at the old root)', async () => {
    const B = createBot('B', 'p1')
    forkOf(B, 'F')
    writeSentinel(holder.projectRoot, 'project')
    projectService.delete('p1')

    await sessionService.delete(B)
    await sessionService.delete('F')
    expectKept(holder.projectRoot, 'project')
    expect(readFileSync(join(holder.projectRoot, 'README.md'), 'utf-8')).toBe('# project\n')
  })
})
