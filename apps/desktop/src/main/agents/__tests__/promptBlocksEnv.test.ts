/**
 * 桌面提示词块里的**环境清单**（`desktopPromptBlocks` 的 `environment`：工作目录 / Git 仓库 / 日期 / 临时目录几行）
 * 与「Git repository」一行的取值（`gitRepoLine`）。
 *
 * 清单一行一项，**给了才有那一行**：工作目录与临时目录两行只给手里有文件工具的 agent，Git / Shell / OS 三行只给
 * 有 bash / powershell 的；所以下面每条用例的名单都带着它要看的那一行所需的工具。
 *
 *  1. 派生 agent 的 ctx 里 `sessionId` 是 agentId、`cwd` 是 ''：工作目录按 `rootSessionId`（根会话）查 ——
 *     旧代码直接回 ctx.cwd（''），isGitRepo 则看 process.cwd()，也就是 ShuviX 自己的检出（于是一律说 Yes）。
 *     根 ctx 有非空 cwd 时照用它、不去查；没传 rootSessionId 的旧调用方按 sessionId 算（ENV-1…5）。
 *  2. `gitRepoLine`：从工作目录往上找第一个 `.git`（目录或文件都算）；工作目录在家目录**之下**时不查家目录
 *     本身及以上（家目录里的 dotfiles 仓库不能让每个项目都读成 Yes），工作目录**就是**家目录时只查它自己，
 *     家目录之外一路查到文件系统根；根在工作目录之上时写出根（ENV-6…10）。路径按构造时的写法比（不 realpath：
 *     macOS 的 /var 与 /private/var），家目录一律显式传临时布局，不碰 os.homedir()。
 *  3. 日期那一行是**本地**日历日，不是 UTC 日（ENV-11）。做法：运行时改 process.env.TZ —— vitest 4 缺省的 forks
 *     池里这一改立即生效（threads 池里会被静默忽略），再用假的 Date 把时刻钉在「UTC 与本地不在同一天」的
 *     那一刻。两个方向各一次（东八区凌晨 1 点 / 夏威夷晚上 7 点）；先自检 getHours()，池换了、TZ 没生效时
 *     大声失败而不是碰巧通过。不选 America/Los_Angeles：开发机本身就在那个时区，TZ 没切也会过。
 *
 *  4. 「临时文件」那一行（TMP-1…7）：目录由主进程启动时注入的解析器给（`setSessionTempDirResolver`），
 *     **只按根会话问**（派生 agent 用根会话的临时目录）；根会话行已不在时不问、不出这一行（不把删掉的目录建回来）；
 *     解析器给不出（null / 空串）同样不出；名单里没有文件工具也不出；commands 那半句只看这一个 agent 的名单里
 *     有没有 bash / powershell。那一行一律与 renderTempDirectory 的输出比，不抄措辞。
 *
 *  5. 整份清单（ENV-13）：每一种名单下环境清单**恰是**哪几行 —— 上面各条只看某一行在不在，多出一行
 *     （没有命令工具的 agent 被告知 Shell / Git / OS）它们看不出来。
 *
 * mock 集合同 promptBlocksWiring.test.ts（dao 会开 SQLite，electron / mcp 在 node 下起不来）；另把 resolveProjectConfig
 * 桩成可控的、把 os.homedir 桩成可换的（缺省仍是真的家目录）—— ENV-5 要一个能挡住祖先目录的家目录边界。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptBlocksCtx } from '@shuvix/agent-runtime'

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
vi.mock('../../services/knowledge', () => ({
  enabledBaseChoices: () => [],
  builtinManualDir: () => null
}))
vi.mock('../AgentTool', () => ({ createAgentTool: vi.fn() }))

import i18next from 'i18next'
import { localDate, renderTempDirectory } from '@shuvix/agent-runtime'
import { desktopPromptBlocks, gitRepoLine, setSessionTempDirResolver } from '../agentHost'

const SPAWNED: PromptBlocksCtx = {
  kind: 'spawned',
  sessionId: 'agent-xyz',
  rootSessionId: 'sess-root',
  cwd: '',
  toolNames: []
}

/** 这个 ctx 的环境清单正文 */
const envOf = async (ctx: PromptBlocksCtx): Promise<string> =>
  (await desktopPromptBlocks(ctx)).environment ?? ''

/** 清单里 `- <label>: <value>` 那一行的值；没有那一行 → undefined（界面语言 en 的标签） */
function lineOf(environment: string, label: string): string | undefined {
  const head = `- ${label}: `
  const line = environment.split('\n').find((entry) => entry.startsWith(head))
  return line?.slice(head.length)
}

/** 环境清单里不属于任何带标签事实的行 —— 也就是「临时文件」那一行（en）；没有 → [] */
const ENV_LABELS = [
  'Working directory',
  'Git repository',
  'Platform',
  'Shell',
  'OS',
  'Current date',
  'User language',
  'ShuviX version'
]
const tempLinesOf = (environment: string): string[] =>
  environment
    .split('\n')
    .filter((entry) => entry && !ENV_LABELS.some((label) => entry.startsWith(`- ${label}: `)))

/** 每个用例自己的临时布局（afterEach 一并删） */
let temps: string[] = []
function tempLayout(): string {
  const t = mkdtempSync(join(tmpdir(), 'shuvix-promptblocks-env-'))
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

describe('desktopPromptBlocks —— 派生 agent 按根会话取工作目录（ENV-1…5）', () => {
  it('ENV-1 派生 ctx（cwd 空）：工作目录那一行是根会话的工作目录；只按 sess-root 查，从不拿 agentId 查；名单里没有文件工具就没有这一行', async () => {
    workingDirectories({ 'sess-root': '/w/root' })

    const env = await envOf({ ...SPAWNED, toolNames: ['read'] })

    expect(lineOf(env, 'Working directory')).toBe('/w/root')
    expect(mocks.resolveProjectConfig).toHaveBeenCalledWith('sess-root')
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalledWith('agent-xyz')

    // 没有能碰文件的工具：工作目录对它没有意义，不说
    expect(lineOf(await envOf(SPAWNED), 'Working directory')).toBeUndefined()
  })

  it('ENV-3 (a) 根 ctx 的 cwd 非空 → 照用、不去查；(b) 没传 rootSessionId 的旧调用方 → 按 sessionId 查', async () => {
    mocks.resolveProjectConfig.mockReturnValue({ workingDirectory: '/elsewhere' })
    const root = await envOf({
      kind: 'root',
      sessionId: 'sess-root',
      rootSessionId: 'sess-root',
      cwd: '/w/proj',
      toolNames: ['read']
    })
    expect(lineOf(root, 'Working directory')).toBe('/w/proj')
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled()

    workingDirectories({ 'sess-1': '/w/one' })
    const legacy = await envOf({
      kind: 'root',
      sessionId: 'sess-1',
      cwd: '',
      toolNames: ['read']
    })
    expect(lineOf(legacy, 'Working directory')).toBe('/w/one')
    expect(mocks.resolveProjectConfig).toHaveBeenCalledWith('sess-1')
  })

  it('ENV-4 根会话已删（查配置抛、查会话无行）：不抛；没有工作目录那一行、Git repository No（不看 process.cwd()），每一块都是字符串', async () => {
    // 前提：这条用例本身跑在一个 git 检出里 —— 旧代码看 process.cwd()，会在这里说 Yes
    expect(gitRepoLine(process.cwd())).toMatch(/^Yes/)
    workingDirectories({})
    mocks.pick.mockReturnValue(undefined)

    const blocks = await desktopPromptBlocks({
      ...SPAWNED,
      rootSessionId: 'gone',
      toolNames: ['bash']
    })
    const env = blocks.environment ?? ''

    // 工作目录解析不出（空）→ 那一行不出，而不是一行空值
    expect(lineOf(env, 'Working directory')).toBeUndefined()
    // 行不在就不去解析：解析会给已删的会话重新建出临时工作区
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled()
    expect(lineOf(env, 'Git repository')).toBe('No')
    for (const [name, value] of Object.entries(blocks)) expect(value, name).toBeTypeOf('string')
  })

  it('ENV-5 Git repository 按解析出的根工作目录算：R 里有 .git → Yes；拿掉 .git（家目录边界挡住祖先）→ No；名单里没有命令工具就没有这一行', async () => {
    const home = tempLayout()
    const repo = mkdir(join(home, 'proj'))
    gitDir(repo)
    mocks.home = home
    workingDirectories({ 'sess-root': repo })
    const withShell = { ...SPAWNED, toolNames: ['bash'] }

    expect(lineOf(await envOf(withShell), 'Git repository')).toBe('Yes')
    // 没有 bash / powershell：Git 那一行对它没有意义，不说
    expect(
      lineOf(await envOf({ ...SPAWNED, toolNames: ['read'] }), 'Git repository')
    ).toBeUndefined()

    rmSync(join(repo, '.git'), { recursive: true, force: true })
    expect(lineOf(await envOf(withShell), 'Git repository')).toBe('No')
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
  const t0 = mkdtempSync(join(tmpdir(), 'shuvix-promptblocks-case-'))
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

describe('desktopPromptBlocks —— 日期那一行是本地日历日（ENV-11）', () => {
  /** 在给定时区、给定时刻渲染一次环境清单；TZ 与真定时器在 finally 里还原 */
  async function dateAt(
    tz: string,
    instant: string,
    localHour: number
  ): Promise<{ date: string | undefined; local: string; utc: string }> {
    const savedTz = process.env.TZ
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      process.env.TZ = tz
      vi.setSystemTime(new Date(instant))
      // 自检：TZ 真的生效了（换成 threads 池时这一改会被静默忽略 —— 那就在这里失败）
      expect(new Date().getHours(), `TZ=${tz} 没生效`).toBe(localHour)
      // 名单为空：日期那一行不看工具，任何 agent 都有
      const env = await envOf({ ...SPAWNED, cwd: '/w/x' })
      return {
        date: lineOf(env, 'Current date'),
        local: localDate(),
        utc: new Date().toISOString().slice(0, 10)
      }
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

describe('desktopPromptBlocks —— 本会话临时目录那一行（TMP-1…7）', () => {
  /** 注入的解析器：给哪个会话就答哪个会话的目录（看得出问的是谁） */
  const resolver = vi.fn((id: string): string | null => `/fixture/tmp/${id}`)
  /** 名单里有一个文件工具（read）：这一行只给手里有文件工具的 agent */
  const ROOT: PromptBlocksCtx = {
    kind: 'root',
    sessionId: 'sess-1',
    cwd: '/w/x',
    toolNames: ['read']
  }

  /** 只有给定的会话 id 有会话行 */
  function rows(...ids: string[]): void {
    mocks.pick.mockImplementation((id: string) => (ids.includes(id) ? { id } : undefined))
  }

  beforeEach(() => {
    resolver.mockReset()
    resolver.mockImplementation((id: string) => `/fixture/tmp/${id}`)
  })

  afterEach(() => {
    // 复位成「没注入」的样子：别的用例（与别的测试文件）不受影响
    setSessionTempDirResolver(() => null)
  })

  it('TMP-1 从没注入解析器（新加载的模块）→ 没有这一行，根会话行在也一样', async () => {
    rows('sess-1')
    vi.resetModules()
    const fresh = await import('../agentHost')
    const before = (await fresh.desktopPromptBlocks({ ...ROOT, toolNames: ['bash'] })).environment
    expect(tempLinesOf(before ?? '')).toEqual([])
    // 正控制组：同一份新模块注入之后就有这一行 —— 上面的「没有」确实来自「没注入」
    fresh.setSessionTempDirResolver(resolver)
    const after = (await fresh.desktopPromptBlocks({ ...ROOT, toolNames: ['bash'] })).environment
    expect(tempLinesOf(after ?? '')).toEqual([
      renderTempDirectory('en', { dir: '/fixture/tmp/sess-1', commands: true })
    ])
  })

  it('TMP-2 根 ctx：那一行说的是根会话的目录；没传 rootSessionId 按 sessionId 问，传了按 rootSessionId 问，都只问一次', async () => {
    setSessionTempDirResolver(resolver)
    rows('sess-1', 'sess-root')

    const legacy = await envOf(ROOT)
    expect(tempLinesOf(legacy)).toEqual([renderTempDirectory('en', { dir: '/fixture/tmp/sess-1' })])
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('sess-1')

    resolver.mockClear()
    const rooted = await envOf({
      ...ROOT,
      sessionId: 'sess-root',
      rootSessionId: 'sess-root',
      toolNames: ['bash']
    })
    expect(tempLinesOf(rooted)).toEqual([
      renderTempDirectory('en', { dir: '/fixture/tmp/sess-root', commands: true })
    ])
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('sess-root')
    // 正控制组：确实是一行内容，而不是两边都空
    expect(rooted).toContain('/fixture/tmp/sess-root')
  })

  it('TMP-3 派生 ctx（sessionId 是 agentId、cwd 空）：只按根会话问，那一行说的是根会话的目录', async () => {
    setSessionTempDirResolver(resolver)
    workingDirectories({ 'sess-root': '/w/root' })

    const env = await envOf({ ...SPAWNED, toolNames: ['read'] })

    expect(resolver.mock.calls.map((call) => call[0])).toEqual(['sess-root'])
    expect(tempLinesOf(env)).toEqual([renderTempDirectory('en', { dir: '/fixture/tmp/sess-root' })])
    expect(env).not.toContain('agent-xyz')
  })

  it('TMP-4 根会话行已不在：没有这一行，而且根本不去问解析器（问了就会把删掉的目录建回来）', async () => {
    setSessionTempDirResolver(resolver)
    rows()

    expect(tempLinesOf(await envOf({ ...ROOT, toolNames: ['bash'] }))).toEqual([])
    expect(
      tempLinesOf(await envOf({ ...SPAWNED, rootSessionId: 'gone', toolNames: ['bash'] }))
    ).toEqual([])
    expect(resolver).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['空串', '']
  ])('TMP-5 解析器给不出目录（%s）→ 没有这一行', async (_label, answer) => {
    setSessionTempDirResolver(() => answer)
    rows('sess-1')
    expect(tempLinesOf(await envOf({ ...ROOT, toolNames: ['bash'] }))).toEqual([])
  })

  it.each([
    // 名单里没有文件工具：这一行整行不出，解析器也不问
    [[], null],
    [['Bash', 'shell', 'mcp:bash'], null],
    [['read', 'write'], false],
    [['bash'], true],
    [['powershell'], true],
    [['bash', 'powershell'], true],
    [['read', 'bash'], true]
  ] as Array<[string[], boolean | null]>)(
    'TMP-6 根 ctx 名单 %j → commands=%s（null = 整行不出；只认这个 agent 名单里的 bash / powershell）',
    async (toolNames, commands) => {
      setSessionTempDirResolver(resolver)
      rows('sess-1')
      const lines = tempLinesOf(await envOf({ ...ROOT, toolNames }))
      if (commands === null) {
        expect(lines).toEqual([])
        expect(resolver).not.toHaveBeenCalled()
      } else {
        expect(lines).toEqual([renderTempDirectory('en', { dir: '/fixture/tmp/sess-1', commands })])
      }
    }
  )

  it('TMP-6 派生 ctx 名单有 bash → commands 那半句在（按派生 agent 自己的名单，不按根的）', async () => {
    setSessionTempDirResolver(resolver)
    workingDirectories({ 'sess-root': '/w/root' })
    const lines = tempLinesOf(await envOf({ ...SPAWNED, toolNames: ['bash'] }))
    expect(lines).toEqual([
      renderTempDirectory('en', { dir: '/fixture/tmp/sess-root', commands: true })
    ])
    // 两版确实不同 —— 否则上面这条分不出 commands 的真假
    expect(lines[0]).not.toBe(
      renderTempDirectory('en', { dir: '/fixture/tmp/sess-root', commands: false })
    )
  })

  const BASE_LABELS = ['Platform', 'Current date', 'User language', 'ShuviX version']
  const FILE_LABELS = ['Working directory', 'Temp', ...BASE_LABELS]
  const ALL_LABELS = [
    'Working directory',
    'Temp',
    'Git repository',
    'Platform',
    'Shell',
    'OS',
    'Current date',
    'User language',
    'ShuviX version'
  ]
  it.each([
    // 没有文件工具也没有命令工具：只有四行恒有的；名字里带 bash 的 mcp: 条目什么都不给
    [[], BASE_LABELS, null],
    [['ask', 'skill', 'mcp:chrome', 'mcp:bash'], BASE_LABELS, null],
    // 文件工具：多出工作目录与临时目录两行，临时目录那一行没有 commands 半句
    [['doc_read'], FILE_LABELS, false],
    [['read'], FILE_LABELS, false],
    // 命令工具：九行全有（命令工具本身就算文件工具），临时目录那一行带 commands 半句
    [['bash'], ALL_LABELS, true],
    [['edit', 'powershell', 'mcp:x'], ALL_LABELS, true]
  ] as Array<[string[], string[], boolean | null]>)(
    'ENV-13 根 ctx 名单 %j → 环境清单恰是这几行 %j（一行不多：没有那项能力就没有那一行）',
    async (toolNames, labels, commands) => {
      setSessionTempDirResolver(resolver)
      rows('sess-1')
      const env = await envOf({ ...ROOT, cwd: '/w', toolNames })
      const lines = env.split('\n')
      const tempLine =
        commands === null
          ? undefined
          : renderTempDirectory('en', { dir: '/fixture/tmp/sess-1', commands })
      // 每行的标签（第一个冒号之前）；临时目录那一行整行比对，记作 Temp
      expect(
        lines.map((line) => (line === tempLine ? 'Temp' : line.slice(2, line.indexOf(':'))))
      ).toEqual(labels)
      for (const line of lines) {
        expect(line).toMatch(/^- \S/)
        expect(line).not.toMatch(/: (undefined|null)?$/)
      }
      expect(env).not.toContain('\n\n')
      if (commands !== null) {
        expect(lineOf(env, 'Working directory')).toBe('/w')
        expect(tempLinesOf(env)).toEqual([tempLine])
      } else {
        expect(tempLinesOf(env)).toEqual([])
        expect(env).not.toContain('/fixture/tmp')
      }
    }
  )

  it.each(['zh', 'ja'])('TMP-7 界面语言 %s：取那一语言的片段', async (language) => {
    setSessionTempDirResolver(resolver)
    rows('sess-1')
    await i18next.changeLanguage(language)
    try {
      const lines = (await envOf({ ...ROOT, toolNames: ['bash'] })).split('\n')
      expect(lines).toContain(
        renderTempDirectory(language, { dir: '/fixture/tmp/sess-1', commands: true })
      )
      expect(lines).not.toContain(
        renderTempDirectory('en', { dir: '/fixture/tmp/sess-1', commands: true })
      )
    } finally {
      await i18next.changeLanguage('en')
    }
  })
})
