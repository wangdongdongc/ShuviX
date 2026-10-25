/**
 * trackingNotes —— 跟踪项（实验）的主进程一侧：侧栏清单、打开 / 复用笔记本会话（隐藏载体项目 `__tracking__`）、
 * 打开目录、bot 每次触发运行结束后的宿主提交。
 *
 * dao / sessionService / electron 是替身；**fs 与 git 是真的** —— 「是不是普通的 .md」「目录还没有」只有真目录测得出来，
 * 提交走 agent-runtime 的 git op（isomorphic-git 单后端），历史用 isomorphic-git 直接读（log / listFiles / currentBranch）。
 * initOp 套了一层可数的壳（TN-13 数「已有仓库不再 init」）。跟踪项目录挂在每个用例各自的随机临时根下，默认不存在。
 *
 *   TN-1  目录还没有：清单为空，不建目录
 *   TN-2  只列顶层普通 .md（点文件 / .txt / 叫 x.md 的目录不算），标题按 trackingTitle，按修改时间倒序
 *   TN-3  读不了的那份跳过，其余照列
 *   TN-4  openTrackingNote 入参按不可信处理：不是跟踪项文件名 / 文件不在 / 是目录 → 抛错，不碰数据库
 *   TN-5  第一次打开：插隐藏项目行、建笔记本会话（文件名 / 标题），工作目录 = 跟踪项目录；不发 project.changed
 *   TN-6  再次打开复用同一条会话，标题入参被忽略
 *   TN-7  项目行 path 漂移：补 path，不重插
 *   TN-8  openTrackingFolder：目录不在先建，再 shell.openPath
 *   TN-9  commitTrackingChanges：目录不在 → 不碰 git、不广播
 *   TN-10 第一次提交：init（main 分支），整棵树提交，署名 ShuviX Tracking，说明照给；广播 tracking.changed
 *   TN-11 没有变更：不多一条提交、不记 warn，照样广播
 *   TN-12 改过的与删掉的都进提交（删掉的不在 HEAD 树里）；子目录也收
 *   TN-13 已有 .git 不再 init；仓库坏了只记 warn、不抛，照样广播
 *   TN-14 [钉现状] 目录里一个指向目录外的符号链接 x.md 能通过 openTrackingNote（statSync 跟随链接）
 *   TN-15 ensureTrackingDir：目录不在（父目录也不在）→ 逐级建出来；不 init、不广播
 *   TN-16 目录已在：里面的文件原样，不记 warn
 *   TN-17 那个路径是一份普通文件：不抛，记一条 warn，文件原样
 *   TN-18 建好空目录、bot 什么都没写就提交：不记 warn、没有提交，照样广播一次
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { TRACKING_PROJECT_ID } from '@shuvix/chat-protocol/trackingNotes'
import type { Project, Session } from '../../types'

const tmp = vi.hoisted(() => ({ base: '' }))
const warn = vi.hoisted(() => vi.fn())
const trackingDir = (): string => join(tmp.base, 'tracking')

vi.mock('../../utils/paths', () => ({
  getDefaultTrackingDir: () => `${tmp.base}/tracking`
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn, error: () => {}, debug: () => {} })
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: { findById: vi.fn(), insert: vi.fn(), update: vi.fn() }
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { findByProjectAndNotebookPath: vi.fn(), findById: vi.fn() }
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    create: vi.fn((p: Record<string, unknown> | undefined) => ({ id: 's-track', ...p }))
  }
}))
// git op 保持真实实现，initOp 外面套一层可数的壳
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return { ...actual, initOp: vi.fn(actual.initOp) }
})

import { shell } from 'electron'
import { initOp } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { appEventBus } from '../../utils/appEventBus'
import { sessionService } from '../sessionService'
import {
  commitTrackingChanges,
  ensureTrackingDir,
  ensureTrackingProject,
  listTrackingItems,
  openTrackingFolder,
  openTrackingNote
} from '../trackingNotes'

const publish = vi.spyOn(appEventBus, 'publish')

/** 往跟踪项目录里放一份文件（父目录按需建） */
const put = (rel: string, text: string): string => {
  const path = join(trackingDir(), rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}
/** 把文件的修改时间拨到某一秒（列表按它排序） */
const touchAt = (rel: string, sec: number): void => {
  utimesSync(join(trackingDir(), rel), sec, sec)
}
const trackingRow = (over: Partial<Project> = {}): Project => ({
  id: TRACKING_PROJECT_ID,
  name: 'Tracking',
  path: trackingDir(),
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over
})
const sessionRow = (over: Partial<Session> = {}): Session =>
  ({
    id: 'existing',
    title: 'Alpha bug',
    projectId: TRACKING_PROJECT_ID,
    parentId: null,
    settings: { notebookPath: 'a.md' },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...over
  }) as Session

/** HEAD 上的提交（新→旧） */
const history = async (): Promise<Awaited<ReturnType<typeof git.log>>> =>
  git.log({ fs: nodeFs, dir: trackingDir() })
/** HEAD 树里的文件 */
const headFiles = async (): Promise<string[]> =>
  (await git.listFiles({ fs: nodeFs, dir: trackingDir(), ref: 'HEAD' })).sort()
const headBlob = async (filepath: string): Promise<string> => {
  const oid = await git.resolveRef({ fs: nodeFs, dir: trackingDir(), ref: 'HEAD' })
  const { blob } = await git.readBlob({ fs: nodeFs, dir: trackingDir(), oid, filepath })
  return Buffer.from(blob).toString('utf8')
}
const trackingChangedCount = (): number =>
  publish.mock.calls.filter(([e]) => e.type === 'tracking.changed').length

beforeEach(() => {
  vi.clearAllMocks()
  tmp.base = join(tmpdir(), `shuvix-tracking-${process.pid}-${Math.random().toString(36).slice(2)}`)
  vi.mocked(projectDao.findById).mockReturnValue(undefined)
  vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(undefined)
  vi.mocked(sessionDao.findById).mockReturnValue(undefined)
})

afterEach(() => {
  rmSync(tmp.base, { recursive: true, force: true })
})

describe('侧栏清单', () => {
  it('TN-1 目录还没有：清单为空；查询不建目录', () => {
    expect(listTrackingItems()).toEqual([])
    expect(existsSync(trackingDir())).toBe(false)
  })

  it('TN-2 只列顶层普通 .md（点文件 / .txt / 叫 x.md 的目录不算）；标题取第一个一级标题，没有就是文件名；按修改时间倒序', () => {
    put(
      'a.md',
      '---\nshuvix: track v1\nshuvix-id: 0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10\n---\n\n# Alpha bug\n\n进展\n'
    )
    put('b.md', '没有标题的一份\n')
    put('C.MD', '## 二级标题不算\n# Gamma\n')
    put('.h.md', '# hidden\n')
    put('n.txt', '# not md\n')
    mkdirSync(join(trackingDir(), 'x.md'))
    put('sub/deep.md', '# 子目录里的不列\n')
    touchAt('a.md', 1_700_000_000)
    touchAt('b.md', 1_700_000_200)
    touchAt('C.MD', 1_700_000_100)

    const items = listTrackingItems()
    expect(items.map((i) => [i.fileName, i.title])).toEqual([
      ['b.md', 'b'],
      ['C.MD', 'Gamma'],
      ['a.md', 'Alpha bug']
    ])
    expect(items.map((i) => Math.round(i.updatedAt / 1000))).toEqual([
      1_700_000_200, 1_700_000_100, 1_700_000_000
    ])
  })

  it('TN-3 读不了的那份跳过（无读权限 / 悬空的符号链接），其余照列', () => {
    put('a.md', '# Alpha\n')
    symlinkSync(join(tmp.base, 'nowhere.md'), join(trackingDir(), 'dangling.md'))
    const locked = put('locked.md', '# Locked\n')
    chmodSync(locked, 0o000)
    try {
      const names = listTrackingItems().map((i) => i.fileName)
      expect(names).toContain('a.md')
      expect(names).not.toContain('dangling.md')
      // root 读得了无权限文件：只有非 root 时这一行才有意义
      if (process.getuid?.() !== 0) expect(names).not.toContain('locked.md')
    } finally {
      chmodSync(locked, 0o644)
    }
  })
})

describe('打开一份跟踪项', () => {
  it('TN-4 不是跟踪项文件名 → "Not a tracking file"；文件不在 / 是目录 → "Tracking file not found"；都不碰数据库', () => {
    put('a.txt', 'x')
    put('.h.md', '# h')
    mkdirSync(join(tmp.base, 'bots'), { recursive: true })
    writeFileSync(join(tmp.base, 'bots', 'daily.md'), '# daily')
    for (const name of ['../bots/daily.md', 'a.txt', '.h.md', 'sub/a.md', 'sub\\a.md', '']) {
      expect(() => openTrackingNote(name), name).toThrow(/Not a tracking file/)
    }
    mkdirSync(join(trackingDir(), 'x.md'))
    for (const name of ['missing.md', 'x.md']) {
      expect(() => openTrackingNote(name), name).toThrow(/Tracking file not found/)
    }
    expect(projectDao.findById).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()
  })

  it('TN-5 第一次打开：插隐藏项目行（path = 跟踪项目录）、建笔记本会话（文件名 / 标题），回工作目录；不发 project.changed', () => {
    put('a.md', '# Alpha bug\n')
    put('b.md', 'x\n')

    const session = openTrackingNote('a.md', '  Alpha bug  ')
    expect(vi.mocked(projectDao.insert).mock.calls[0][0]).toMatchObject({
      id: TRACKING_PROJECT_ID,
      name: 'Tracking',
      path: trackingDir()
    })
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: TRACKING_PROJECT_ID,
      notebookPath: 'a.md',
      title: 'Alpha bug'
    })
    expect(session).toMatchObject({ id: 's-track', workingDirectory: trackingDir() })

    // 没给标题 / 全空白 → 去掉 .md 的文件名
    openTrackingNote('b.md')
    openTrackingNote('b.md', '   ')
    expect(
      vi
        .mocked(sessionService.create)
        .mock.calls.slice(1)
        .map((c) => c[0]?.title)
    ).toEqual(['b', 'b'])
    expect(publish).not.toHaveBeenCalled()
  })

  it('TN-6 再次打开：按 (项目 id, 文件名) 复用那条会话；标题入参被忽略、不 create', () => {
    put('a.md', '# Alpha bug\n')
    vi.mocked(projectDao.findById).mockReturnValue(trackingRow())
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(sessionRow())

    const session = openTrackingNote('a.md', '另一个标题')
    expect(session).toMatchObject({
      id: 'existing',
      title: 'Alpha bug',
      workingDirectory: trackingDir()
    })
    expect(sessionDao.findByProjectAndNotebookPath).toHaveBeenCalledWith(
      TRACKING_PROJECT_ID,
      'a.md'
    )
    expect(sessionService.create).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(projectDao.update).not.toHaveBeenCalled()
  })

  it('TN-7 隐藏项目行的 path 漂移（home 迁移）：补 path，不重插', () => {
    vi.mocked(projectDao.findById).mockReturnValue(
      trackingRow({ path: '/old/home/.shuvix/tracking' })
    )
    expect(ensureTrackingProject().path).toBe(trackingDir())
    expect(projectDao.update).toHaveBeenCalledWith(TRACKING_PROJECT_ID, { path: trackingDir() })
    expect(projectDao.insert).not.toHaveBeenCalled()
  })

  it('TN-14 [钉现状] 目录里指向目录外的符号链接 x.md 能通过 openTrackingNote（statSync 跟随链接）', () => {
    mkdirSync(join(tmp.base, 'outside'), { recursive: true })
    writeFileSync(join(tmp.base, 'outside', 'secret.md'), '# outside\n')
    mkdirSync(trackingDir(), { recursive: true })
    symlinkSync(join(tmp.base, 'outside', 'secret.md'), join(trackingDir(), 'x.md'))

    expect(openTrackingNote('x.md')).toMatchObject({ id: 's-track' })
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: TRACKING_PROJECT_ID,
      notebookPath: 'x.md',
      title: 'x'
    })
  })
})

describe('打开目录', () => {
  it('TN-8 目录还没有：先建出来，再交给 shell.openPath', async () => {
    expect(existsSync(trackingDir())).toBe(false)
    await openTrackingFolder()
    expect(existsSync(trackingDir())).toBe(true)
    expect(shell.openPath).toHaveBeenCalledWith(trackingDir())
  })
})

describe('宿主提交（commitTrackingChanges）', () => {
  it('TN-9 目录不在（这次没写任何跟踪项）：不碰 git、不建目录、不广播', async () => {
    await commitTrackingChanges('Daily · 10-24 18:00 (session s1)')
    expect(initOp).not.toHaveBeenCalled()
    expect(existsSync(trackingDir())).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('TN-10 第一次提交：init（main 分支），整棵树进提交，署名 ShuviX Tracking，说明照给；广播一次 tracking.changed', async () => {
    put('a.md', '# Alpha\n')
    put('b.md', '# Beta\n')

    await commitTrackingChanges('Daily · 10-24 18:00 (session s1)')

    expect(initOp).toHaveBeenCalledTimes(1)
    expect(await git.currentBranch({ fs: nodeFs, dir: trackingDir() })).toBe('main')
    const log = await history()
    expect(log).toHaveLength(1)
    expect(log[0].commit.message.trim()).toBe('Daily · 10-24 18:00 (session s1)')
    expect(log[0].commit.author.name).toBe('ShuviX Tracking')
    expect(log[0].commit.author.email).toBe('tracking@shuvix.local')
    expect(await headFiles()).toEqual(['a.md', 'b.md'])
    expect(publish.mock.calls).toEqual([[{ type: 'tracking.changed' }]])
    expect(warn).not.toHaveBeenCalled()
  })

  it('TN-11 没有变更：不多一条提交，「nothing to commit」不记 warn，照样广播', async () => {
    put('a.md', '# Alpha\n')
    await commitTrackingChanges('first')
    publish.mockClear()

    await commitTrackingChanges('second')
    expect((await history()).map((c) => c.commit.message.trim())).toEqual(['first'])
    expect(warn).not.toHaveBeenCalled()
    expect(publish.mock.calls).toEqual([[{ type: 'tracking.changed' }]])
  })

  it('TN-12 改过的与删掉的都进提交（删掉的不在 HEAD 树里）；子目录里的文件也收', async () => {
    put('a.md', '# Alpha\n')
    put('b.md', '# Beta\n')
    await commitTrackingChanges('first')

    put('a.md', '# Alpha\n\n- 有进展了，尺寸也变了\n')
    unlinkSync(join(trackingDir(), 'b.md'))
    put('notes/c.md', '# Gamma\n')
    await commitTrackingChanges('second')

    const log = await history()
    expect(log.map((c) => c.commit.message.trim())).toEqual(['second', 'first'])
    expect(await headFiles()).toEqual(['a.md', 'notes/c.md'])
    expect(await headBlob('a.md')).toBe('# Alpha\n\n- 有进展了，尺寸也变了\n')
    expect(warn).not.toHaveBeenCalled()
  })

  it('TN-13 已有 .git 不再 init，历史接着长；仓库坏了只记 warn、不抛，照样广播', async () => {
    put('a.md', '# Alpha\n')
    await commitTrackingChanges('first')
    expect(initOp).toHaveBeenCalledTimes(1)

    put('a.md', '# Alpha v2\n')
    await commitTrackingChanges('second')
    expect(initOp).toHaveBeenCalledTimes(1)
    expect((await history()).map((c) => c.commit.message.trim())).toEqual(['second', 'first'])

    // 坏仓库：.git 是一份普通文件
    rmSync(join(trackingDir(), '.git'), { recursive: true, force: true })
    writeFileSync(join(trackingDir(), '.git'), 'not a repository')
    publish.mockClear()
    await expect(commitTrackingChanges('third')).resolves.toBeUndefined()
    expect(initOp).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    expect(trackingChangedCount()).toBe(1)
  })
})

describe('运行前建好目录（ensureTrackingDir）', () => {
  it('TN-15 目录不在（连父目录也不在）：逐级建出来，是空目录；不 init（没有 .git）、不广播、不记 warn', () => {
    expect(existsSync(tmp.base)).toBe(false)
    ensureTrackingDir()
    expect(statSync(trackingDir()).isDirectory()).toBe(true)
    expect(readdirSync(trackingDir())).toEqual([])
    expect(existsSync(join(trackingDir(), '.git'))).toBe(false)
    expect(initOp).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('TN-16 目录已在：里面的文件（含子目录）原样，不记 warn；连调两次也一样', () => {
    put('a.md', '# Alpha\n')
    put('notes/b.md', '# Beta\n')
    ensureTrackingDir()
    ensureTrackingDir()
    expect(readdirSync(trackingDir()).sort()).toEqual(['a.md', 'notes'])
    expect(readFileSync(join(trackingDir(), 'a.md'), 'utf8')).toBe('# Alpha\n')
    expect(readFileSync(join(trackingDir(), 'notes/b.md'), 'utf8')).toBe('# Beta\n')
    expect(warn).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('TN-17 那个路径是一份普通文件：不抛，记一条 warn，文件原样', () => {
    mkdirSync(tmp.base, { recursive: true })
    writeFileSync(trackingDir(), 'not a folder')
    expect(() => ensureTrackingDir()).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(statSync(trackingDir()).isFile()).toBe(true)
    expect(readFileSync(trackingDir(), 'utf8')).toBe('not a folder')
    expect(publish).not.toHaveBeenCalled()
  })

  it('TN-18 建好空目录、这次运行什么都没写就提交：不记 warn、没有提交（HEAD 解析不出），照样广播一次 tracking.changed', async () => {
    ensureTrackingDir()
    await commitTrackingChanges('Daily · 10-25 18:00 (session s1)')
    expect(warn).not.toHaveBeenCalled()
    await expect(git.resolveRef({ fs: nodeFs, dir: trackingDir(), ref: 'HEAD' })).rejects.toThrow()
    expect(trackingChangedCount()).toBe(1)
  })
})
