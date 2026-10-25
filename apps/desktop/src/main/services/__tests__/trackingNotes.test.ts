/**
 * trackingNotes —— 跟踪项（实验）的主进程一侧：侧栏清单、打开 / 复用笔记本会话（隐藏载体项目 `__tracking__`）、
 * 打开目录、删掉一项（侧栏行菜单）、bot 每次触发运行结束后的宿主提交。
 *
 * dao / sessionService / electron 是替身；**fs 与 git 是真的** —— 「是不是普通的 .md」「目录还没有」只有真目录测得出来，
 * 提交走 agent-runtime 的 git op（isomorphic-git 单后端），历史用 isomorphic-git 直接读（log / listFiles / currentBranch）。
 * initOp 套了一层可数的壳（TN-13 数「已有仓库不再 init」）。跟踪项目录挂在每个用例各自的随机临时根下，默认不存在。
 *
 *   TN-1  目录还没有：清单为空，不建目录
 *   TN-2  只列顶层普通 .md（点文件 / .txt / 叫 x.md 的目录不算），标题按 trackingTitle，按修改时间倒序
 *   TN-2b 每一项带绝对路径 path = 跟踪项目录 + 文件名
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
 *   TN-19 deleteTrackingItem 入参按不可信处理：越界 / 子路径 / 反斜杠 / 隐藏 / 非 md / undefined → "Not a tracking file"；
 *         不查会话、不删、不提交、不广播，盘上的东西原样
 *   TN-20 有笔记本会话：先删会话（此刻文件还在），回 {deleted:true, sessionId}；没有：sessionId 为 null、不删会话、不插项目行
 *   TN-21 文件本来就不在（清单过期）但有会话：会话照删，回 {deleted:false, sessionId}，不提交，广播恰一次 tracking.changed；
 *         叫 x.md 的目录同样处理，目录原样
 *   TN-22 bot 提交过、之后没改过的一份：历史 = [Deleted …, first]（删前那次是「没有可提交的」），HEAD 没有它，父提交里是原文
 *   TN-23 从没提交过、目录也还不是仓库：建出仓库，历史 = [Deleted …, Before deleting …]，父提交里读得到原文；
 *         会话在建仓库之前就删了（钉顺序）
 *   TN-24 提交过、之后改过没提交：父提交里是最后那一版；[钉现状] 别的没提交的改动也一并进了「Before deleting」那次提交
 *   TN-25 指向目录外的符号链接 x.md：只删链接，目标原样
 *   TN-26 仓库坏了（.git 是一份普通文件）：抛错、文件还在、记 warn；[钉现状] 会话在提交之前已经删了
 *   TN-27 别的文件：盘上原样，HEAD 里照在
 *   TN-28 commitTrackingChanges 的返回值：真提交了 / 没有可提交的 → true，仓库坏了 → false；[钉现状] 目录不在 → true
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
    create: vi.fn((p: Record<string, unknown> | undefined) => ({ id: 's-track', ...p })),
    delete: vi.fn(async () => {})
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
  deleteTrackingItem,
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
/** 某个提交里那份文件的内容 */
const blobAt = async (oid: string, filepath: string): Promise<string> => {
  const { blob } = await git.readBlob({ fs: nodeFs, dir: trackingDir(), oid, filepath })
  return Buffer.from(blob).toString('utf8')
}
/** 某个提交树里的文件 */
const filesAt = async (oid: string): Promise<string[]> =>
  (await git.listFiles({ fs: nodeFs, dir: trackingDir(), ref: oid })).sort()
const messages = async (): Promise<string[]> =>
  (await history()).map((c) => c.commit.message.trim())
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

  it('TN-2b 每一项带绝对路径：path = 跟踪项目录 + 文件名', () => {
    put('a.md', '# Alpha\n')
    put('B.MD', '# Beta\n')
    const items = listTrackingItems()
    expect(items).toHaveLength(2)
    for (const i of items) expect(i.path).toBe(join(trackingDir(), i.fileName))
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
    await expect(commitTrackingChanges('third')).resolves.toBe(false)
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

describe('删掉一项（deleteTrackingItem）', () => {
  const sessionFor = (fileName: string, id = `nb-${fileName}`): Session =>
    sessionRow({ id, settings: { notebookPath: fileName } })

  it('TN-19 不是跟踪项文件名 → "Not a tracking file"；不查会话、不删、不提交、不广播，盘上原样', async () => {
    put('x.txt', 'x')
    put('.h.md', '# h\n')
    put('a/b.md', '# nested\n')
    writeFileSync(join(tmp.base, 'x.md'), '# outside\n')
    for (const name of ['../x.md', 'a/b.md', 'a\\b.md', '.h.md', 'x.txt', undefined]) {
      await expect(deleteTrackingItem(name as unknown as string), String(name)).rejects.toThrow(
        /Not a tracking file/
      )
    }
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.delete).not.toHaveBeenCalled()
    expect(initOp).not.toHaveBeenCalled()
    expect(existsSync(join(trackingDir(), '.git'))).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(readFileSync(join(tmp.base, 'x.md'), 'utf8')).toBe('# outside\n')
    expect(readFileSync(join(trackingDir(), 'x.txt'), 'utf8')).toBe('x')
    expect(readFileSync(join(trackingDir(), '.h.md'), 'utf8')).toBe('# h\n')
    expect(readFileSync(join(trackingDir(), 'a/b.md'), 'utf8')).toBe('# nested\n')
  })

  it('TN-20 有笔记本会话：先删会话（此刻文件还在），回 {deleted:true, sessionId}；查找按 (__tracking__, 文件名)', async () => {
    const file = put('a.md', '# Alpha\n')
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(sessionFor('a.md', 'nb-a'))
    const fileAtSessionDelete: boolean[] = []
    vi.mocked(sessionService.delete).mockImplementation(async () => {
      fileAtSessionDelete.push(existsSync(file))
    })

    await expect(deleteTrackingItem('a.md')).resolves.toEqual({ deleted: true, sessionId: 'nb-a' })
    expect(sessionDao.findByProjectAndNotebookPath).toHaveBeenCalledWith(
      TRACKING_PROJECT_ID,
      'a.md'
    )
    expect(vi.mocked(sessionService.delete).mock.calls).toEqual([['nb-a']])
    expect(fileAtSessionDelete).toEqual([true])
    expect(existsSync(file)).toBe(false)
  })

  it('TN-20 没有笔记本会话：sessionId 为 null，不删会话、不碰项目行', async () => {
    const file = put('a.md', '# Alpha\n')
    await expect(deleteTrackingItem('a.md')).resolves.toEqual({ deleted: true, sessionId: null })
    expect(sessionService.delete).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })

  it('TN-21 文件本来就不在但有会话：会话照删，回 {deleted:false, sessionId}，不提交，广播恰一次 tracking.changed', async () => {
    put('b.md', '# Beta\n')
    await commitTrackingChanges('first')
    vi.mocked(initOp).mockClear()
    publish.mockClear()
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(
      sessionFor('gone.md', 'nb-gone')
    )

    await expect(deleteTrackingItem('gone.md')).resolves.toEqual({
      deleted: false,
      sessionId: 'nb-gone'
    })
    expect(vi.mocked(sessionService.delete).mock.calls).toEqual([['nb-gone']])
    expect(await messages()).toEqual(['first'])
    expect(initOp).not.toHaveBeenCalled()
    expect(publish.mock.calls).toEqual([[{ type: 'tracking.changed' }]])
    expect(warn).not.toHaveBeenCalled()
  })

  it('TN-21 目录都还没有：同样 {deleted:false}，不建目录、不建仓库，广播恰一次', async () => {
    await expect(deleteTrackingItem('gone.md')).resolves.toEqual({
      deleted: false,
      sessionId: null
    })
    expect(existsSync(trackingDir())).toBe(false)
    expect(initOp).not.toHaveBeenCalled()
    expect(trackingChangedCount()).toBe(1)
  })

  it('TN-21 叫 x.md 的目录：按「不在」处理 —— 会话照删、{deleted:false}、不提交，目录与里面的东西原样', async () => {
    put('x.md/inner.md', '# inner\n')
    put('b.md', '# Beta\n')
    await commitTrackingChanges('first')
    publish.mockClear()
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(sessionFor('x.md', 'nb-x'))

    await expect(deleteTrackingItem('x.md')).resolves.toEqual({
      deleted: false,
      sessionId: 'nb-x'
    })
    expect(vi.mocked(sessionService.delete).mock.calls).toEqual([['nb-x']])
    expect(statSync(join(trackingDir(), 'x.md')).isDirectory()).toBe(true)
    expect(readFileSync(join(trackingDir(), 'x.md/inner.md'), 'utf8')).toBe('# inner\n')
    expect(await messages()).toEqual(['first'])
    expect(trackingChangedCount()).toBe(1)
  })

  it('TN-22 bot 提交过、之后没改过：历史 = [Deleted, first]，HEAD 没有它，父提交里是原文', async () => {
    put('a.md', '# Alpha\n\n- 进展\n')
    await commitTrackingChanges('first')

    await expect(deleteTrackingItem('a.md')).resolves.toMatchObject({ deleted: true })
    const log = await history()
    expect(log.map((c) => c.commit.message.trim())).toEqual(['Deleted a.md (by the user)', 'first'])
    expect(log[0].commit.author.name).toBe('ShuviX Tracking')
    expect(await headFiles()).toEqual([])
    expect(log[0].commit.parent).toEqual([log[1].oid])
    expect(await blobAt(log[1].oid, 'a.md')).toBe('# Alpha\n\n- 进展\n')
    expect(existsSync(join(trackingDir(), 'a.md'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('TN-23 从没提交过、也还不是仓库：建出仓库（main），历史 = [Deleted, Before deleting]，父提交里读得到原文；会话先于建仓库删掉', async () => {
    put('a.md', '# Alpha draft\n')
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(sessionFor('a.md', 'nb-a'))
    const repoAtSessionDelete: boolean[] = []
    vi.mocked(sessionService.delete).mockImplementation(async () => {
      repoAtSessionDelete.push(existsSync(join(trackingDir(), '.git')))
    })

    await expect(deleteTrackingItem('a.md')).resolves.toEqual({ deleted: true, sessionId: 'nb-a' })
    expect(repoAtSessionDelete).toEqual([false])
    expect(initOp).toHaveBeenCalledTimes(1)
    expect(await git.currentBranch({ fs: nodeFs, dir: trackingDir() })).toBe('main')
    const log = await history()
    expect(log.map((c) => c.commit.message.trim())).toEqual([
      'Deleted a.md (by the user)',
      'Before deleting a.md'
    ])
    expect(await headFiles()).toEqual([])
    expect(await filesAt(log[1].oid)).toEqual(['a.md'])
    expect(await blobAt(log[1].oid, 'a.md')).toBe('# Alpha draft\n')
    expect(warn).not.toHaveBeenCalled()
  })

  it('TN-24 提交过、之后改过没提交：父提交里是最后那一版；[钉现状] 别的没提交的改动也一并进了那次提交', async () => {
    put('a.md', '# Alpha v1\n')
    put('b.md', '# Beta v1\n')
    await commitTrackingChanges('first')
    put('a.md', '# Alpha v2\n\n- 用户刚改的\n')
    put('b.md', '# Beta v2\n')
    put('c.md', '# Gamma new\n')

    await deleteTrackingItem('a.md')
    const log = await history()
    expect(log.map((c) => c.commit.message.trim())).toEqual([
      'Deleted a.md (by the user)',
      'Before deleting a.md',
      'first'
    ])
    expect(await blobAt(log[1].oid, 'a.md')).toBe('# Alpha v2\n\n- 用户刚改的\n')
    expect(await blobAt(log[2].oid, 'a.md')).toBe('# Alpha v1\n')
    // 「Before deleting」那次提交的是整棵树：b 的改动与新的 c 也在里面
    expect(await filesAt(log[1].oid)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(await blobAt(log[1].oid, 'b.md')).toBe('# Beta v2\n')
    expect(await blobAt(log[1].oid, 'c.md')).toBe('# Gamma new\n')
    // 删除那次只拿掉 a
    expect(await headFiles()).toEqual(['b.md', 'c.md'])
    expect(await headBlob('b.md')).toBe('# Beta v2\n')
  })

  it('TN-25 指向目录外的符号链接 x.md：只删链接，目标原样', async () => {
    const target = join(tmp.base, 'outside', 'secret.md')
    mkdirSync(join(tmp.base, 'outside'), { recursive: true })
    writeFileSync(target, '# outside\n')
    mkdirSync(trackingDir(), { recursive: true })
    const link = join(trackingDir(), 'x.md')
    symlinkSync(target, link)

    await expect(deleteTrackingItem('x.md')).resolves.toMatchObject({ deleted: true })
    expect(() => nodeFs.lstatSync(link)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('# outside\n')
    expect((await messages())[0]).toBe('Deleted x.md (by the user)')
  })

  it('TN-26 仓库坏了（.git 是普通文件）：抛错、文件还在、记 warn；[钉现状] 会话在提交之前已经删了', async () => {
    const file = put('a.md', '# Alpha\n')
    writeFileSync(join(trackingDir(), '.git'), 'not a repository')
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(sessionFor('a.md', 'nb-a'))

    await expect(deleteTrackingItem('a.md')).rejects.toThrow(
      /Could not record a\.md .*it was not deleted/
    )
    expect(readFileSync(file, 'utf8')).toBe('# Alpha\n')
    expect(warn).toHaveBeenCalled()
    expect(vi.mocked(sessionService.delete).mock.calls).toEqual([['nb-a']])
    expect(readFileSync(join(trackingDir(), '.git'), 'utf8')).toBe('not a repository')
    expect(initOp).not.toHaveBeenCalled()
  })

  it('TN-27 别的文件：盘上原样，HEAD 里照在', async () => {
    put('a.md', '# Alpha\n')
    put('b.md', '# Beta\n')
    put('notes/c.md', '# Gamma\n')
    await commitTrackingChanges('first')

    await deleteTrackingItem('a.md')
    expect(readFileSync(join(trackingDir(), 'b.md'), 'utf8')).toBe('# Beta\n')
    expect(readFileSync(join(trackingDir(), 'notes/c.md'), 'utf8')).toBe('# Gamma\n')
    expect(await headFiles()).toEqual(['b.md', 'notes/c.md'])
    expect(await headBlob('b.md')).toBe('# Beta\n')
    expect(await headBlob('notes/c.md')).toBe('# Gamma\n')
    expect(listTrackingItems().map((i) => i.fileName)).toEqual(['b.md'])
  })
})

describe('commitTrackingChanges 的返回值', () => {
  it('TN-28 真提交了 → true；没有可提交的 → true；仓库坏了 → false；[钉现状] 目录不在 → true', async () => {
    await expect(commitTrackingChanges('nothing here')).resolves.toBe(true)
    expect(existsSync(trackingDir())).toBe(false)

    put('a.md', '# Alpha\n')
    await expect(commitTrackingChanges('first')).resolves.toBe(true)
    expect(await messages()).toEqual(['first'])

    await expect(commitTrackingChanges('second')).resolves.toBe(true)
    expect(await messages()).toEqual(['first'])
    expect(warn).not.toHaveBeenCalled()

    rmSync(join(trackingDir(), '.git'), { recursive: true, force: true })
    writeFileSync(join(trackingDir(), '.git'), 'not a repository')
    await expect(commitTrackingChanges('third')).resolves.toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})
