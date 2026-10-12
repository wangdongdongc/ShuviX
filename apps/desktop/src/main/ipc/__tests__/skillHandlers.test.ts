/**
 * skillHandlers —— `skill:removeExternalDir` 只在**真的移除了一条外部目录**时连带删承载项目：
 *
 *   IPC-SK-1 共用目录的组键（`claude` / `agents`，含带空白的写法）拼得出同形的承载 id
 *            （`__skills:claude__`），但它们移不掉 —— 不调 dropExternalSkillCarrier，那一组的笔记会话留着；
 *            不在配置里的名字同样不调；
 *   IPC-SK-2 一个真的外部目录：按 **trim 过的** 名字删它的载体（落库与承载 id 都按 trim 过的名字算）；
 *   IPC-SK-3 早先版本里叫 `claude` 的外部目录：它是真的外部目录，移除时照删 `__skills:claude__` ——
 *            那些笔记指着它的旧路径，共用的 claude 组之后按需重建载体。
 *   IPC-SK-4/5 `skill:addExternalDir` 的拒绝不是异常而是 `{ success: false, reason }`：原因原样回到
 *            渲染端（同一目录换个写法时，原因里是调用方填的那个路径）。
 *
 * electron 是替身（handle 收进 Map）；skillNotes 是替身（只看调没调、拿什么调）；**skillService 是真的**
 * —— 「这个名字算不算移除了一条」正是它的判定，替身验不出来。paths 打桩到夹具根下（假 home 不碰
 * 跑测试那台机器的家目录）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
  const root = `${base.replace(/\/+$/, '')}/shuvix-skill-ipc-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
  return {
    handlers: new Map<string, Handler>(),
    dropExternalSkillCarrier: vi.fn(async (_dirName: string) => {}),
    openSkillNote: vi.fn(),
    dirs: {
      root,
      builtin: `${root}/builtin`,
      user: `${root}/user`,
      ext: `${root}/ext`,
      legacy: `${root}/legacy`,
      claude: `${root}/home/.claude/skills`,
      agents: `${root}/home/.agents/skills`
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  },
  dialog: { showOpenDialog: vi.fn() }
}))
vi.mock('../../utils/paths', () => ({
  getBuiltinSkillsDir: () => state.dirs.builtin,
  getDefaultSkillsDir: () => state.dirs.user,
  getSharedSkillsDirs: () => ({ claude: state.dirs.claude, agents: state.dirs.agents })
}))
vi.mock('../../services/skillNotes', () => ({
  dropExternalSkillCarrier: state.dropExternalSkillCarrier,
  openSkillNote: state.openSkillNote
}))

import { registerSkillHandlers } from '../skillHandlers'

const DIRS = state.dirs
const CONFIG_PATH = join(DIRS.user, '.config.json')

const writeSkill = (dir: string, dirEntry: string): void => {
  mkdirSync(join(dir, dirEntry), { recursive: true })
  writeFileSync(
    join(dir, dirEntry, 'SKILL.md'),
    `---\nname: ${dirEntry}\ndescription: d\n---\n\nB\n`
  )
}
const readConfig = (): string => (existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '')

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(fn({}, ...args))
}

beforeEach(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
  for (const dir of [DIRS.builtin, DIRS.user, DIRS.ext, DIRS.legacy]) {
    mkdirSync(dir, { recursive: true })
  }
  state.handlers.clear()
  state.dropExternalSkillCarrier.mockClear()
  registerSkillHandlers()
})

afterAll(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
})

describe('skill:removeExternalDir —— 承载项目的级联', () => {
  it('IPC-SK-1 共用目录的组键（与不在配置里的名字）：回 success，但不删承载项目、配置不动', async () => {
    writeSkill(DIRS.agents, 'pdf')
    writeSkill(DIRS.claude, 'review')
    await invoke('skill:setGroupEnabled', { dirName: 'agents', isEnabled: true })
    const before = readConfig()

    for (const name of ['claude', 'agents', ' agents ', 'nope']) {
      await expect(invoke('skill:removeExternalDir', name), name).resolves.toEqual({
        success: true
      })
    }
    expect(state.dropExternalSkillCarrier).not.toHaveBeenCalled()
    expect(readConfig()).toBe(before)
  })

  it('IPC-SK-2 真的外部目录：移除它，并按 trim 过的名字删它的载体', async () => {
    writeSkill(DIRS.ext, 'tool')
    await expect(
      invoke('skill:addExternalDir', { name: ' ext ', path: DIRS.ext })
    ).resolves.toEqual({ success: true })

    await expect(invoke('skill:removeExternalDir', ' ext ')).resolves.toEqual({ success: true })
    expect(state.dropExternalSkillCarrier.mock.calls).toEqual([['ext']])
    expect(JSON.parse(readConfig()).dirs).toEqual([])
  })

  it('IPC-SK-3 早先版本里叫 claude 的外部目录：照常移除并删 `claude` 的载体', async () => {
    writeSkill(DIRS.legacy, 'old')
    writeSkill(DIRS.claude, 'review')
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        disabled: [],
        disabledDirs: [],
        dirs: [{ name: 'claude', path: DIRS.legacy }]
      })
    )

    await expect(invoke('skill:removeExternalDir', 'claude')).resolves.toEqual({ success: true })
    expect(state.dropExternalSkillCarrier.mock.calls).toEqual([['claude']])
    expect(JSON.parse(readConfig()).dirs).toEqual([])

    // 再移一次：此时 claude 是共用目录的组键，不再删任何东西
    state.dropExternalSkillCarrier.mockClear()
    await invoke('skill:removeExternalDir', 'claude')
    expect(state.dropExternalSkillCarrier).not.toHaveBeenCalled()
  })

  it('IPC-SK-4 加一个在列的共用目录：原因原样回到渲染端（success: false），配置不动', async () => {
    mkdirSync(DIRS.agents, { recursive: true })
    const before = readConfig()
    const result = (await invoke('skill:addExternalDir', {
      name: 'skills',
      path: DIRS.agents
    })) as {
      success: boolean
      reason?: string
    }
    expect(result.success).toBe(false)
    expect(result.reason).toBe(
      '~/.agents/skills is a shared skills directory that ShuviX lists by itself'
    )
    expect(readConfig()).toBe(before)
  })

  it('IPC-SK-5 同一目录换个写法（尾斜杠）：already added 的原因原样回到渲染端、带着调用方写的路径；默认目录的尾斜杠写法同样拒；配置不动', async () => {
    await expect(invoke('skill:addExternalDir', { name: 'ext', path: DIRS.ext })).resolves.toEqual({
      success: true
    })
    const before = readConfig()

    type AddResult = { success: boolean; reason?: string }
    const dup = (await invoke('skill:addExternalDir', {
      name: 'other',
      path: `${DIRS.ext}/`
    })) as AddResult
    expect(dup.success).toBe(false)
    expect(dup.reason).toMatch(/already added/)
    expect(dup.reason).toContain(`"${DIRS.ext}/"`)

    const def = (await invoke('skill:addExternalDir', {
      name: 'other',
      path: `${DIRS.user}/`
    })) as AddResult
    expect(def.success).toBe(false)
    expect(def.reason).toMatch(/Cannot add the default skills directory/)

    expect(readConfig()).toBe(before)
    expect(JSON.parse(readConfig()).dirs).toEqual([{ name: 'ext', path: DIRS.ext }])
  })
})
