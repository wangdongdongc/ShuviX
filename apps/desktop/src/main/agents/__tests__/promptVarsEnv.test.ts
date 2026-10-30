/**
 * 桌面变量表的**环境类标量**（`desktopPromptVars` 的 workingDirectory / projectName / isGitRepo / date）
 * 与「Git repository」一行的取值（`gitRepoLine`）。
 *
 *  1. 派生 agent 的 ctx 里 `sessionId` 是 agentId、`cwd` 是 ''：工作目录与项目都按 `rootSessionId`
 *     （根会话）查 —— 旧代码直接回 ctx.cwd（''）、拿 agentId 查项目（''），isGitRepo 则看 process.cwd()，
 *     也就是 ShuviX 自己的检出（于是一律说 Yes）。根 ctx 有非空 cwd 时照用它、不去查；没传 rootSessionId
 *     的旧调用方按 sessionId 算（ENV-1…5）。
 *  2. `gitRepoLine`：从工作目录往上找第一个 `.git`（目录或文件都算）；工作目录在家目录**之下**时不查家目录
 *     本身及以上（家目录里的 dotfiles 仓库不能让每个项目都读成 Yes），工作目录**就是**家目录时只查它自己，
 *     家目录之外一路查到文件系统根；根在工作目录之上时写出根（ENV-6…10）。路径按构造时的写法比（不 realpath：
 *     macOS 的 /var 与 /private/var），家目录一律显式传临时布局，不碰 os.homedir()。
 *  3. date 是**本地**日历日，不是 UTC 日（ENV-11）。做法：运行时改 process.env.TZ —— vitest 4 缺省的 forks
 *     池里这一改立即生效（threads 池里会被静默忽略），再用假的 Date 把时刻钉在「UTC 与本地不在同一天」的
 *     那一刻。两个方向各一次（东八区凌晨 1 点 / 夏威夷晚上 7 点）；先自检 getHours()，池换了、TZ 没生效时
 *     大声失败而不是碰巧通过。不选 America/Los_Angeles：开发机本身就在那个时区，TZ 没切也会过。
 *
 * mock 集合同 promptVarsWiring.test.ts（dao 会开 SQLite，electron / mcp 在 node 下起不来）；另把 resolveProjectConfig
 * 桩成可控的、把 os.homedir 桩成可换的（缺省仍是真的家目录）—— ENV-5 要一个能挡住祖先目录的家目录边界。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptVarsCtx } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  pickSettings: vi.fn(),
  projectPick: vi.fn(),
  resolveProjectConfig: vi.fn(),
  /** 换掉 agentHost 看到的 os.homedir()；undefined = 真的家目录 */
  home: undefined as string | undefined
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: actual, homedir: () => mocks.home ?? actual.homedir() }
})
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pick: mocks.pick, pickSettings: mocks.pickSettings }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => []
}))
vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: () => [], findModelInvocable: () => [] }
}))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: {} }))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: vi.fn() }))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxGloballyActive: () => false }))
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/agentRuntimeAdapters', () => ({ electronEventSink: {} }))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: mocks.resolveProjectConfig
}))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))
vi.mock('../AgentTool', () => ({ createAgentTool: vi.fn() }))

import i18next from 'i18next'
import { localDate } from '@shuvix/agent-runtime'
import { desktopPromptVars, gitRepoLine } from '../agentHost'

const SPAWNED: PromptVarsCtx = {
  kind: 'spawned',
  sessionId: 'agent-xyz',
  rootSessionId: 'sess-root',
  cwd: '',
  toolNames: []
}

/** 每个用例自己的临时布局（afterEach 一并删） */
let temps: string[] = []
function tempLayout(): string {
  const t = mkdtempSync(join(tmpdir(), 'shuvix-promptvars-env-'))
  temps.push(t)
  return t
}
const mkdir = (p: string): string => {
  mkdirSync(p, { recursive: true })
  return p
}
/** 造一个 `.git` 目录 */
const gitDir = (repo: string): void => void mkdir(join(repo, '.git'))

/**
 * 给定的会话 id 才有会话行、才解析得出工作目录；别的 id 查行无果、解析也抛。
 * 宿主先查行再解析 —— 行不在（根会话已删）时不去解析，解析会回落临时工作区并把目录建出来
 */
function workingDirectories(table: Record<string, string>): void {
  mocks.pick.mockImplementation((id: string) => (id in table ? { id } : undefined))
  mocks.resolveProjectConfig.mockImplementation((id: string) => {
    if (id in table) return { workingDirectory: table[id] }
    throw new Error(`Session not found: ${id}`)
  })
}

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({ lng: 'en', resources: {}, showSupportNotice: false })
  }
})

beforeEach(() => {
  mocks.pick.mockReset()
  mocks.pickSettings.mockReset()
  mocks.projectPick.mockReset()
  mocks.resolveProjectConfig.mockReset()
  mocks.home = undefined
  mocks.pickSettings.mockReturnValue({})
  temps = []
})

afterEach(() => {
  mocks.home = undefined
  for (const t of temps) rmSync(t, { recursive: true, force: true })
  temps = []
})

describe('desktopPromptVars —— 派生 agent 按根会话取工作目录与项目（ENV-1…5）', () => {
  it('ENV-1 派生 ctx（cwd 空）：workingDirectory 是根会话的工作目录；只按 sess-root 查，从不拿 agentId 查', async () => {
    workingDirectories({ 'sess-root': '/w/root' })

    const vars = await desktopPromptVars(SPAWNED)

    expect(vars.workingDirectory).toBe('/w/root')
    expect(mocks.resolveProjectConfig).toHaveBeenCalledWith('sess-root')
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalledWith('agent-xyz')
  })

  it('ENV-2 projectName 按根会话的项目给（会话查询认 id：只有 sess-root 有项目）', async () => {
    workingDirectories({ 'sess-root': '/w/root' })
    mocks.pick.mockImplementation((id: string) =>
      id === 'sess-root' ? { projectId: 'proj-1' } : undefined
    )
    mocks.projectPick.mockImplementation((id: string) =>
      id === 'proj-1' ? { name: 'Proj' } : undefined
    )

    const vars = await desktopPromptVars(SPAWNED)

    expect(vars.projectName).toBe('Proj')
    const lookedUp = mocks.pick.mock.calls.map((call) => call[0])
    expect(lookedUp).toContain('sess-root')
    expect(lookedUp).not.toContain('agent-xyz')
  })

  it('ENV-3 (a) 根 ctx 的 cwd 非空 → 照用、不去查；(b) 没传 rootSessionId 的旧调用方 → 按 sessionId 查', async () => {
    mocks.resolveProjectConfig.mockReturnValue({ workingDirectory: '/elsewhere' })
    const root = await desktopPromptVars({
      kind: 'root',
      sessionId: 'sess-root',
      rootSessionId: 'sess-root',
      cwd: '/w/proj',
      toolNames: []
    })
    expect(root.workingDirectory).toBe('/w/proj')
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled()

    workingDirectories({ 'sess-1': '/w/one' })
    const legacy = await desktopPromptVars({
      kind: 'root',
      sessionId: 'sess-1',
      cwd: '',
      toolNames: []
    })
    expect(legacy.workingDirectory).toBe('/w/one')
    expect(mocks.resolveProjectConfig).toHaveBeenCalledWith('sess-1')
  })

  it('ENV-4 根会话已删（查配置抛、查会话无行）：不抛；workingDirectory 空、isGitRepo No（不看 process.cwd()）、projectName 空，其余都是字符串', async () => {
    // 前提：这条用例本身跑在一个 git 检出里 —— 旧代码看 process.cwd()，会在这里说 Yes
    expect(gitRepoLine(process.cwd())).toMatch(/^Yes/)
    workingDirectories({})
    mocks.pick.mockReturnValue(undefined)

    const vars = await desktopPromptVars({ ...SPAWNED, rootSessionId: 'gone' })

    expect(vars.workingDirectory).toBe('')
    // 行不在就不去解析：解析会给已删的会话重新建出临时工作区
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled()
    expect(vars.isGitRepo).toBe('No')
    expect(vars.projectName).toBe('')
    for (const [name, value] of Object.entries(vars)) expect(value, name).toBeTypeOf('string')
  })

  it('ENV-5 isGitRepo 按解析出的根工作目录算：R 里有 .git → Yes；拿掉 .git（家目录边界挡住祖先）→ No', async () => {
    const home = tempLayout()
    const repo = mkdir(join(home, 'proj'))
    gitDir(repo)
    mocks.home = home
    workingDirectories({ 'sess-root': repo })

    expect((await desktopPromptVars(SPAWNED)).isGitRepo).toBe('Yes')

    rmSync(join(repo, '.git'), { recursive: true, force: true })
    expect((await desktopPromptVars(SPAWNED)).isGitRepo).toBe('No')
  })
})

describe('gitRepoLine —— 从工作目录往上找第一个 .git，家目录是边界（ENV-6…10）', () => {
  it('ENV-6 .git 是目录或文件（工作树 / 子模块）都算；都没有 → No；空工作目录 → No', () => {
    const home = tempLayout()
    gitDir(mkdir(join(home, 'p1')))
    writeFileSync(join(mkdir(join(home, 'p2')), '.git'), 'gitdir: /somewhere/.git/worktrees/p2\n')
    mkdir(join(home, 'p3'))

    expect(gitRepoLine(join(home, 'p1'), home)).toBe('Yes')
    expect(gitRepoLine(join(home, 'p2'), home)).toBe('Yes')
    expect(gitRepoLine(join(home, 'p3'), home)).toBe('No')
    expect(gitRepoLine('', home)).toBe('No')
  })

  it('ENV-7 祖先仓库（家目录之内）写出根；最近的那个胜出', () => {
    const home = tempLayout()
    gitDir(mkdir(join(home, 'mono')))
    const pkg = mkdir(join(home, 'mono', 'packages', 'a', 'src'))
    gitDir(mkdir(join(home, 'outer')))
    gitDir(mkdir(join(home, 'outer', 'inner')))
    const nested = mkdir(join(home, 'outer', 'inner', 'pkg'))

    expect(gitRepoLine(pkg, home)).toBe(`Yes (root: ${join(home, 'mono')})`)
    expect(gitRepoLine(nested, home)).toBe(`Yes (root: ${join(home, 'outer', 'inner')})`)
  })

  it('ENV-8 工作目录严格在家目录之下：家目录自己的 .git（dotfiles）与家目录之上的 .git 都不算', () => {
    const t = tempLayout()
    const home = mkdir(join(t, 'home'))
    gitDir(home)
    gitDir(t)
    const wd = mkdir(join(home, 'projects', 'x'))

    expect(gitRepoLine(wd, home)).toBe('No')

    rmSync(join(home, '.git'), { recursive: true, force: true })
    expect(gitRepoLine(wd, home)).toBe('No')
  })

  it('ENV-9 工作目录就是家目录：只查它自己（结尾斜杠两边都归一）；家目录之上的 .git 不算', () => {
    const t = tempLayout()
    const home = mkdir(join(t, 'home'))
    gitDir(home)

    expect(gitRepoLine(home, home)).toBe('Yes')
    expect(gitRepoLine(home + '/', home)).toBe('Yes')
    expect(gitRepoLine(home, home + '/')).toBe('Yes')

    rmSync(join(home, '.git'), { recursive: true, force: true })
    gitDir(t)
    expect(gitRepoLine(home, home)).toBe('No')
  })

  it('ENV-10 家目录之外一路往上查；名字以家目录开头的兄弟目录（home2）不算在家目录之内', () => {
    // (a) T/home2/.git
    const a = tempLayout()
    const homeA = mkdir(join(a, 'home'))
    gitDir(mkdir(join(a, 'home2')))
    expect(gitRepoLine(mkdir(join(a, 'home2', 'p')), homeA)).toBe(`Yes (root: ${join(a, 'home2')})`)

    // (b) 只有 T/.git
    const b = tempLayout()
    const homeB = mkdir(join(b, 'home'))
    gitDir(b)
    expect(gitRepoLine(mkdir(join(b, 'home2', 'p')), homeB)).toBe(`Yes (root: ${b})`)

    // (c) 只有 T/out/.git
    const c = tempLayout()
    const homeC = mkdir(join(c, 'home'))
    gitDir(mkdir(join(c, 'out')))
    expect(gitRepoLine(mkdir(join(c, 'out', 'a', 'b')), homeC)).toBe(
      `Yes (root: ${join(c, 'out')})`
    )
  })

  it('ENV-10b 同一个家目录拼法不同（经符号链接到达）：仍认出是家目录，dotfiles 的 .git 不算', () => {
    const t = tempLayout()
    const realHome = mkdir(join(t, 'RealHome'))
    gitDir(realHome)
    const link = join(t, 'linkhome')
    symlinkSync(realHome, link)
    // 家目录给的是链接、工作目录给的是真实路径，以及反过来
    expect(gitRepoLine(mkdir(join(realHome, 'proj')), link)).toBe('No')
    expect(gitRepoLine(join(link, 'proj'), realHome)).toBe('No')
  })

  // 大小写不敏感的卷（macOS 默认、Windows）上，c:\Users\Foo 与 C:\Users\Foo 是同一个家目录
  const t0 = mkdtempSync(join(tmpdir(), 'shuvix-promptvars-case-'))
  mkdirSync(join(t0, 'Probe'))
  const caseInsensitive = existsSync(join(t0, 'probe'))
  rmSync(t0, { recursive: true, force: true })
  it.skipIf(!caseInsensitive)(
    'ENV-10c 家目录大小写拼法不同：仍认出是家目录，dotfiles 的 .git 不算',
    () => {
      const t = tempLayout()
      const home = mkdir(join(t, 'CaseHome'))
      gitDir(home)
      mkdir(join(home, 'proj'))
      expect(gitRepoLine(join(t, 'casehome', 'proj'), home)).toBe('No')
      expect(gitRepoLine(join(home, 'proj'), join(t, 'casehome'))).toBe('No')
    }
  )
})

describe('desktopPromptVars —— date 是本地日历日（ENV-11）', () => {
  /** 在给定时区、给定时刻跑一次变量表；TZ 与真定时器在 finally 里还原 */
  async function dateAt(
    tz: string,
    instant: string,
    localHour: number
  ): Promise<{ date: string; local: string; utc: string }> {
    const savedTz = process.env.TZ
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      process.env.TZ = tz
      vi.setSystemTime(new Date(instant))
      // 自检：TZ 真的生效了（换成 threads 池时这一改会被静默忽略 —— 那就在这里失败）
      expect(new Date().getHours(), `TZ=${tz} 没生效`).toBe(localHour)
      const vars = await desktopPromptVars({ ...SPAWNED, cwd: '/w/x' })
      return { date: vars.date, local: localDate(), utc: new Date().toISOString().slice(0, 10) }
    } finally {
      vi.useRealTimers()
      if (savedTz === undefined) delete process.env.TZ
      else process.env.TZ = savedTz
    }
  }

  it('ENV-11 (a) 东八区 01:00（UTC 还是前一天）→ 本地那天；(b) 夏威夷 19:00（UTC 已是后一天）→ 本地那天', async () => {
    const shanghai = await dateAt('Asia/Shanghai', '2026-10-28T17:00:00Z', 1)
    expect(shanghai.date).toBe('2026-10-29')
    expect(shanghai.date).toBe(shanghai.local)
    expect(shanghai.date).not.toBe(shanghai.utc)

    const honolulu = await dateAt('Pacific/Honolulu', '2026-10-29T05:00:00Z', 19)
    expect(honolulu.date).toBe('2026-10-28')
    expect(honolulu.date).toBe(honolulu.local)
    expect(honolulu.date).not.toBe(honolulu.utc)
  })
})
