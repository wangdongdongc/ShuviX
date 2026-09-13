/**
 * registryNotes —— 四个注册表目录（bot / agent / 安全策略 / 工作流）的 md「怎么打开」与
 * 「写完告诉谁」。
 *
 * 打开与 knowledgeNotes 同一套做法，测法也照它：每个目录一个隐藏承载项目（固定 id、path =
 * 该目录）按需插入、历史行漂移自愈；一份文件至多一条笔记本会话，重复打开复用；**文件名在碰
 * 任何东西之前先过白名单** —— 它来自渲染进程，而打开的是一条会往盘上写的笔记本会话。
 * 写入回执只有 bot 目录要（改名迁移 + bot.changed），其余目录每次用到都现扫，不该被打扰。
 *
 * dao / sessionService / botService 是替身；**fs 是真的** —— 「存在且是普通文件」只有真目录
 * 测得出来（一个叫 `looks-like.md` 的目录就是这么漏过去的，RN-9）。四个目录挂在每个用例各自的
 * 随机临时根下，默认都**不存在**（RN-1：插项目行不该顺手把目录建出来）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  type RegistryNoteKind
} from '@shuvix/chat-protocol/registryNotes'
import type { Project, Session } from '../../types'

/** 临时根 + 四个注册表目录。paths 替身与用例共用这一份，两边拼出的路径逐字相同 */
const tmp = vi.hoisted(() => {
  const state = { base: '' }
  const subdir = { bot: 'bots', agent: 'agents', policy: 'policies', workflow: 'workflows' }
  return {
    state,
    dirOf: (kind: keyof typeof subdir): string => `${state.base}/${subdir[kind]}`
  }
})

vi.mock('../../utils/paths', () => ({
  getDefaultBotsDir: () => tmp.dirOf('bot'),
  getDefaultAgentsDir: () => tmp.dirOf('agent'),
  getDefaultPoliciesDir: () => tmp.dirOf('policy'),
  getDefaultWorkflowsDir: () => tmp.dirOf('workflow')
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: { findById: vi.fn(), insert: vi.fn(), update: vi.fn() }
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { findByProjectAndNotebookPath: vi.fn() }
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    create: vi.fn((p: Record<string, unknown> | undefined) => ({ id: 's-new', ...p }))
  }
}))
vi.mock('../botService', () => ({
  botService: { noteWriting: vi.fn(), noteWritten: vi.fn() }
}))

import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { appEventBus } from '../../utils/appEventBus'
import { sessionService } from '../sessionService'
import { botService } from '../botService'
import { ensureRegistryNoteProject, observeRegistryWrite, openRegistryNote } from '../registryNotes'

const publish = vi.spyOn(appEventBus, 'publish')

const KINDS = ['bot', 'agent', 'policy', 'workflow'] as const
const { dirOf } = tmp

/** 各注册表隐藏项目的名字（项目列表里看不见，只在日志与调试里认得出是谁） */
const NAMES: Record<RegistryNoteKind, string> = {
  bot: 'Bots',
  agent: 'Agents',
  policy: 'Policies',
  workflow: 'Workflows'
}

/** 一行与当前目录一致的隐藏项目（over 用来制造漂移） */
const registryRow = (kind: RegistryNoteKind, over: Partial<Project> = {}): Project => ({
  id: REGISTRY_NOTE_PROJECT_IDS[kind],
  name: NAMES[kind],
  path: dirOf(kind),
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 100,
  updatedAt: 200,
  ...over
})

/** 放一份真文件（父目录按需建） */
const putFile = (path: string, text = '---\nname: x\n---\n\nbody\n'): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** 某个替身第一次被调用的全局序号（比先后用） */
const firstCall = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]

beforeEach(() => {
  vi.clearAllMocks()
  // RN-10 给 noteWritten 装过实现：连实现一起清掉，不让它漏进后面的用例
  vi.mocked(botService.noteWriting).mockReset()
  vi.mocked(botService.noteWritten).mockReset()
  tmp.state.base = join(
    tmpdir(),
    `shuvix-registry-notes-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  vi.mocked(projectDao.findById).mockReturnValue(undefined)
  vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(undefined)
})

afterEach(() => {
  rmSync(tmp.state.base, { recursive: true, force: true })
})

describe('ensureRegistryNoteProject', () => {
  it.each(KINDS)(
    'RN-1 首次（%s）：findById 无 → insert 一行隐藏项目（固定 id / 名 / path = 该注册表目录 / 空提示词 / 空配置 / 未归档 / 两个时间戳相同），返回的就是插进去的那个对象；不 update、不广播、不建目录',
    (kind) => {
      const before = Date.now()
      const project = ensureRegistryNoteProject(kind)
      const after = Date.now()

      expect(projectDao.insert).toHaveBeenCalledTimes(1)
      const inserted = vi.mocked(projectDao.insert).mock.calls[0][0]
      expect(inserted).toEqual({
        id: REGISTRY_NOTE_PROJECT_IDS[kind],
        name: NAMES[kind],
        path: dirOf(kind),
        systemPrompt: '',
        settings: {},
        archivedAt: 0,
        createdAt: expect.any(Number),
        updatedAt: inserted.createdAt
      })
      expect(inserted.createdAt).toBeGreaterThanOrEqual(before)
      expect(inserted.createdAt).toBeLessThanOrEqual(after)
      expect(project).toBe(inserted)

      expect(projectDao.update).not.toHaveBeenCalled()
      // 项目列表里看不见它：发 project.changed 只会让所有窗口白重拉一遍列表
      expect(publish).not.toHaveBeenCalled()
      // 目录归新建文件时懒建 —— 首次打开设置页不该往 ~/.shuvix 里撒四个空目录
      expect(existsSync(dirOf(kind))).toBe(false)
    }
  )

  it('RN-2 已有且一致的行原样返回（同一个对象）；不 insert、不 update', () => {
    const row = registryRow('bot')
    vi.mocked(projectDao.findById).mockReturnValue(row)

    expect(ensureRegistryNoteProject('bot')).toBe(row)
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(projectDao.update).not.toHaveBeenCalled()
  })

  it('RN-3 自愈：path 漂移只补 path、name 漂移只补 name、都漂移一次 update 带两键；返回值合并补丁、其余字段保留；不 insert', () => {
    const id = REGISTRY_NOTE_PROJECT_IDS.policy
    const root = dirOf('policy')

    // (a) home 目录迁移：只有 path 不一致
    const moved = registryRow('policy', { path: '/old/home/.shuvix/policies' })
    vi.mocked(projectDao.findById).mockReturnValue(moved)
    let out = ensureRegistryNoteProject('policy')
    expect(projectDao.update).toHaveBeenCalledTimes(1)
    expect(projectDao.update).toHaveBeenLastCalledWith(id, { path: root })
    expect(out).toEqual({ ...moved, path: root })

    // (b) 只有 name 不一致
    const renamed = registryRow('policy', { name: 'Security Policies' })
    vi.mocked(projectDao.findById).mockReturnValue(renamed)
    out = ensureRegistryNoteProject('policy')
    expect(projectDao.update).toHaveBeenCalledTimes(2)
    expect(projectDao.update).toHaveBeenLastCalledWith(id, { name: 'Policies' })
    expect(out).toEqual({ ...renamed, name: 'Policies' })

    // (c) 两者都漂移：一次 update 带两个键
    const both = registryRow('policy', {
      name: 'Security Policies',
      path: '/old/home/.shuvix/policies'
    })
    vi.mocked(projectDao.findById).mockReturnValue(both)
    out = ensureRegistryNoteProject('policy')
    expect(projectDao.update).toHaveBeenCalledTimes(3)
    expect(projectDao.update).toHaveBeenLastCalledWith(id, { path: root, name: 'Policies' })
    expect(out).toEqual({ ...both, path: root, name: 'Policies' })

    expect(projectDao.insert).not.toHaveBeenCalled()
  })

  it('RN-4 kind 不串：agent 只查 agent 的项目 id，插入行的 path 是 agents 目录', () => {
    // 查错 id 的后果是两个注册表共用一行项目，path 自愈让它在两个目录之间来回改写
    const project = ensureRegistryNoteProject('agent')

    expect(vi.mocked(projectDao.findById).mock.calls).toEqual([[REGISTRY_NOTE_PROJECT_IDS.agent]])
    expect(vi.mocked(projectDao.insert).mock.calls[0][0].path).toBe(dirOf('agent'))
    expect(project.path).toBe(dirOf('agent'))
  })
})

describe('openRegistryNote', () => {
  it('RN-5 无既有会话：先确保项目行、再 create（projectId / 文件名原样 / 去掉 .md 为标题）；回会话 + 工作目录 = bots 目录', () => {
    putFile(join(dirOf('bot'), 'scout.md'))

    const session = openRegistryNote('bot', 'scout.md')

    expect(sessionService.create).toHaveBeenCalledTimes(1)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: REGISTRY_NOTE_PROJECT_IDS.bot,
      notebookPath: 'scout.md',
      title: 'scout'
    })
    // 会话挂在一行还不存在的项目上，会让它的工作目录解析不出来
    expect(projectDao.insert).toHaveBeenCalledTimes(1)
    expect(firstCall(vi.mocked(projectDao.insert))).toBeLessThan(
      firstCall(vi.mocked(sessionService.create))
    )
    // 工作目录回带给设置页：它据此认出「这条笔记的文件变了」
    expect(session).toEqual({
      id: 's-new',
      projectId: REGISTRY_NOTE_PROJECT_IDS.bot,
      notebookPath: 'scout.md',
      title: 'scout',
      workingDirectory: dirOf('bot')
    })
  })

  it('RN-6 标题：给了则裁首尾空白；全空白回落文件名去后缀；大写后缀 LOUD.MD 照收，notebookPath 逐字不改', () => {
    const projectId = REGISTRY_NOTE_PROJECT_IDS.bot
    putFile(join(dirOf('bot'), 'scout.md'))
    putFile(join(dirOf('bot'), 'LOUD.MD'))

    openRegistryNote('bot', 'scout.md', ' Scout ')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId,
      notebookPath: 'scout.md',
      title: 'Scout'
    })

    openRegistryNote('bot', 'scout.md', '   ')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId,
      notebookPath: 'scout.md',
      title: 'scout'
    })

    // 扫描对后缀大小写不敏感（列得出来的就该打得开）；notebookPath 是查重键，不做任何归一
    openRegistryNote('bot', 'LOUD.MD')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId,
      notebookPath: 'LOUD.MD',
      title: 'LOUD'
    })
  })

  it('RN-7 复用：同文件已有会话 → 按 (项目 id, 文件名) 精确查到并原样回（+ 工作目录）；不 create，换个标题也不改什么', () => {
    // 身份是文件名而不是 frontmatter name：改名、写坏、修好，打开的始终是同一条会话
    putFile(join(dirOf('bot'), 'scout.md'))
    const existing = {
      id: 's-old',
      title: 'scout',
      projectId: REGISTRY_NOTE_PROJECT_IDS.bot,
      parentId: null,
      settings: { notebookPath: 'scout.md' },
      createdAt: 1,
      updatedAt: 1
    } as Session
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockImplementation((projectId, path) =>
      projectId === REGISTRY_NOTE_PROJECT_IDS.bot && path === 'scout.md' ? existing : undefined
    )

    const expected = { ...existing, workingDirectory: dirOf('bot') }
    expect(openRegistryNote('bot', 'scout.md')).toEqual(expected)
    expect(openRegistryNote('bot', 'scout.md', 'A Different Title')).toEqual(expected)

    expect(sessionService.create).not.toHaveBeenCalled()
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual([
      [REGISTRY_NOTE_PROJECT_IDS.bot, 'scout.md'],
      [REGISTRY_NOTE_PROJECT_IDS.bot, 'scout.md']
    ])
  })

  it.each(KINDS)(
    'RN-8 文件名白名单（%s）：越界 / 子路径 / 绝对路径 / 点文件 / 非 .md / 无后缀 / 空 / 尾随分隔符 / 不存在 / 只在别的注册表目录里有 —— 一律抛错，且没碰项目行、没查会话、没建会话',
    (kind) => {
      const dir = dirOf(kind)
      // 能放真文件的都放上：拒绝得是白名单拒的，而不是恰好不存在
      putFile(join(tmp.state.base, 'outside.md'))
      putFile(join(dir, '.hidden.md'))
      putFile(join(dir, 'x.txt'))
      putFile(join(dir, 'x'))
      putFile(join(dir, 'sub', 'x.md'))
      // scout.md 只在另外三个注册表目录里有：存在性按这个 kind 的目录判，不是「哪个目录里有都行」
      for (const other of KINDS) if (other !== kind) putFile(join(dirOf(other), 'scout.md'))

      const bad = [
        '../x.md',
        '..\\x.md',
        'sub/x.md',
        'sub\\x.md',
        '/abs/x.md',
        '.hidden.md',
        'x.txt',
        'x',
        '',
        'x.md/',
        'nope.md',
        '../outside.md',
        'scout.md'
      ]
      for (const fileName of bad) {
        expect(() => openRegistryNote(kind, fileName), JSON.stringify(fileName)).toThrow(
          new RegExp(`Invalid ${kind} file`)
        )
      }
      // 守门在最前面：被拒的文件名连一行隐藏项目都不该留下
      expect(projectDao.findById).not.toHaveBeenCalled()
      expect(projectDao.insert).not.toHaveBeenCalled()
      expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
      expect(sessionService.create).not.toHaveBeenCalled()

      // 正控制组：同一个目录里真实存在的 .md 打得开 —— 上面的拒绝不是因为目录取错了
      putFile(join(dir, 'ok.md'))
      expect(openRegistryNote(kind, 'ok.md').workingDirectory).toBe(dir)
    }
  )

  it('RN-9 目录不是文件：注册表目录里一个叫 looks-like.md 的目录 → 抛错（笔记本读不了它）', () => {
    // 只查「存在」会放行它：建出一条打开就报错、却永远复用的笔记本会话
    mkdirSync(join(dirOf('bot'), 'looks-like.md'), { recursive: true })

    expect(() => openRegistryNote('bot', 'looks-like.md')).toThrow(/Invalid bot file/)
    expect(projectDao.findById).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()
  })
})

describe('observeRegistryWrite', () => {
  it('RN-10 bots 目录下的 .md：写之前 noteWriting(bots 目录 + 文件名)、写完（promise 落定之后）noteWritten()；写函数的结果按引用原样返回', async () => {
    // noteWriting 要赶在落盘之前记下改名前的名字（重启后第一笔写的基线），noteWritten 要等
    // 落盘之后才重扫 —— 顺序反了，迁移就拿不到「旧名」或看不到「新名」
    const path = join(dirOf('bot'), 'scout.md')
    const value = { ok: true as const }
    let settled = false
    let settledAtNoteWritten: boolean | undefined
    vi.mocked(botService.noteWritten).mockImplementation(() => {
      settledAtNoteWritten = settled
    })
    const write = vi.fn(async () => {
      // 让出一拍：noteWritten 若只等「调用了 write」而不等它落定，这里的旗子还没立起来
      await new Promise((resolve) => setTimeout(resolve, 0))
      settled = true
      return value
    })

    const out = await observeRegistryWrite(path, write)

    expect(out).toBe(value)
    expect(write).toHaveBeenCalledTimes(1)
    expect(vi.mocked(botService.noteWriting).mock.calls).toEqual([[path]])
    expect(vi.mocked(botService.noteWritten).mock.calls).toEqual([[]])
    expect(settledAtNoteWritten).toBe(true)
    expect(firstCall(vi.mocked(botService.noteWriting))).toBeLessThan(firstCall(write))
    expect(firstCall(write)).toBeLessThan(firstCall(vi.mocked(botService.noteWritten)))
  })

  it('RN-11 [钉现状] 写失败也回执：resolve {ok:false} → noteWritten 一次、值原样回；reject → noteWritten 一次、拒绝原样抛出', async () => {
    // noteWritten 在 finally 里：失败的一笔照样重扫、照样（防抖后）广播 bot.changed。
    // 多一次白扫，换来「半途失败但其实已落盘」的那一笔不会漏掉改名迁移
    const path = join(dirOf('bot'), 'scout.md')

    const failed = { ok: false as const, error: 'EACCES: permission denied' }
    await expect(observeRegistryWrite(path, async () => failed)).resolves.toBe(failed)
    expect(botService.noteWriting).toHaveBeenCalledTimes(1)
    expect(botService.noteWritten).toHaveBeenCalledTimes(1)

    vi.mocked(botService.noteWriting).mockClear()
    vi.mocked(botService.noteWritten).mockClear()
    const boom = new Error('ENOSPC: no space left on device')
    await expect(
      observeRegistryWrite(path, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(botService.noteWriting).toHaveBeenCalledTimes(1)
    expect(botService.noteWritten).toHaveBeenCalledTimes(1)
  })

  it('RN-12 bots 目录之外一律不回执：非 .md、bots 的子目录、另外三个注册表目录、名字以 bots 开头的兄弟目录、相对路径 —— 写照常只调一次、值照常透传', async () => {
    // agent / policy / workflow 每次用到都现扫目录，不需要通知；`bots-evil` 是给前缀匹配
    // （startsWith(botsDir)）准备的陷阱
    const bots = dirOf('bot')
    const targets = [
      join(bots, 'notes.txt'),
      join(bots, 'sub', 'x.md'),
      join(dirOf('agent'), 'x.md'),
      join(dirOf('policy'), 'x.md'),
      join(dirOf('workflow'), 'x.md'),
      join(tmp.state.base, 'bots-evil', 'x.md'),
      'scout.md'
    ]
    for (const target of targets) {
      const value = { ok: true as const, target }
      const write = vi.fn(async () => value)
      await expect(observeRegistryWrite(target, write), target).resolves.toBe(value)
      expect(write, target).toHaveBeenCalledTimes(1)
    }
    expect(botService.noteWriting).not.toHaveBeenCalled()
    expect(botService.noteWritten).not.toHaveBeenCalled()
  })

  it('RN-13 路径先规范化再判：`sub/..` 绕回 bots 目录、重复分隔符都照样回执；noteWriting 收到的是 bots 目录 + 文件名（后缀大小写原样）', async () => {
    // noteWriting 的路径是 botService 改名记录的键：它必须与扫描拼出来的 join(botsDir, 文件名)
    // 逐字相同，否则每一笔写都被当成「没见过的文件」
    const bots = dirOf('bot')
    const write = vi.fn(async () => ({ ok: true as const }))

    await observeRegistryWrite(`${bots}/sub/../Scout.MD`, write)
    expect(vi.mocked(botService.noteWriting).mock.calls).toEqual([[join(bots, 'Scout.MD')]])
    expect(botService.noteWritten).toHaveBeenCalledTimes(1)

    await observeRegistryWrite(`${bots}//x.md`, write)
    expect(vi.mocked(botService.noteWriting).mock.calls[1]).toEqual([join(bots, 'x.md')])
    expect(botService.noteWritten).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(2)
  })
})
