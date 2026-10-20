/**
 * 沙箱管理器（sandbox/index.ts）—— 对外唯一入口：开关、后端选择与探测缓存、宿主路径、
 * 执行计划、给会话权限表派生行的会话自己的目录与设置目录的写法、会话清理。
 *
 * 替身：electron 的 app（getPath / isPackaged）、os.homedir、平台后端（假后端，探测 / 包装 / 启动失败
 * 都可控）、fs 里 ensureTmpDir / cleanupSession 用到的几个函数（realpathSync 用真的 —— 符号链接的用例要
 * 真链接）、logger。模块级缓存（后端、探测结果、realpath 缓存）每个用例 resetModules 后重新导入。
 *
 *  - MG-1 开关的读取；MG-2 后端选择 + 探测缓存 + 交给探测的宿主路径（含 ShuviX 自己的程序目录）；
 *  - MG-3 planFor 不看开关；MG-4 / MG-5 planFor 的正常路径与 null（规格的读写范围就是请求里权限表的行；
 *    工作目录正是别的会话的临时工作区 —— 临时会话的 fork 共用源会话的 —— 照给计划；真链接按指向判）；
 *    MG-6 plan.explain；MG-7 cleanupSession；
 *  - MG-8 whyUnconfined（命令没进沙箱的原因：此刻的；从不探测）；
 *  - MG-9 sessionOwnDirsView（权限表 workdir / system 行的来源）与 settingDirForAcl（knowledge / skill 行的
 *    写法）：与开关 / 探测 / 平台都无关，照它们拼的行交给 planFor 就是规格的可写根；算不出来给 null
 *    （一行都不派生 —— 多问，绝不因此放行）。
 *
 * 请求里的行照 acl/derive.ts 的写法拼（{@link ownRowsOf} / {@link rowsFrom}）；真权限表要数据库，这里不起。
 */
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const UID = process.getuid?.() ?? 0
const TMP_ROOT = `/private/tmp/shuvix-${UID}`
const HOME = '/Users/u'
const USER_DATA = '/Users/u/Library/Application Support/ShuviX'
const SHUVIX = `${HOME}/.shuvix`
const WS = '/Users/u/proj'
const KB = `${SHUVIX}/knowledge/b`
const SKILLS = `${SHUVIX}/skills`

const mocks = vi.hoisted(() => ({
  app: { getPath: (() => '') as (name: string) => string, isPackaged: false } as {
    getPath: (name: string) => string
    isPackaged: boolean
    getAppPath?: () => string
  },
  getPath: vi.fn(),
  homedir: vi.fn(),
  probe: vi.fn(),
  wrap: vi.fn(),
  startupFailure: vi.fn(),
  mkdirSync: vi.fn(),
  lstatSync: vi.fn(),
  chmodSync: vi.fn(),
  rmSync: vi.fn(),
  explainSpy: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: mocks.homedir }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    mkdirSync: mocks.mkdirSync,
    lstatSync: mocks.lstatSync,
    chmodSync: mocks.chmodSync,
    rmSync: mocks.rmSync
  }
})
vi.mock('../backends/seatbelt', () => ({
  createSeatbeltBackend: () => ({
    id: 'fake',
    probe: mocks.probe,
    wrap: mocks.wrap,
    startupFailure: mocks.startupFailure
  })
}))
vi.mock('../classify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../classify')>()
  return {
    ...actual,
    explainSandboxDenial: (input: Parameters<typeof actual.explainSandboxDenial>[0]) => {
      mocks.explainSpy(input)
      return actual.explainSandboxDenial(input)
    }
  }
})
vi.mock('../../../logger', () => ({ createLogger: () => mocks.log }))

import { getShuvixCliEnv } from '../../../utils/paths'

type Manager = typeof import('../index')
type PlanRequest = import('../index').PlanRequest
type SandboxPathEntry = import('../index').SandboxPathEntry
type SessionOwnDirs = import('../index').SessionOwnDirs

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM, value: p })
}

/** 每个用例一份全新的管理器（模块级缓存清零） */
async function load(reader?: () => string | undefined): Promise<Manager> {
  vi.resetModules()
  const m = await import('../index')
  if (reader) m.setSandboxSettingReader(reader)
  return m
}

const sha8 = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 8)
const tmpDirOf = (id: string): string => `${TMP_ROOT}/${sha8(id)}`
/** 正常工作目录下会话 id 派生的四行的路径（与 acl/derive.ts 的顺序一致） */
const sessionDirsOf = (id: string, ws = WS): string[] => [
  ws,
  tmpDirOf(id),
  `${SHUVIX}/artifacts/${id}`,
  `${USER_DATA}/tool_results/${id}`
]

const row = (path: string, access: 'read' | 'write', granted: boolean): SandboxPathEntry => ({
  path,
  access,
  granted
})

/** 权限表里派生的四行（工作目录与会话自己的三个目录，都可写；夹具路径都不存在，realpath 不改写法） */
const ownRowsOf = (id: string, ws = WS): SandboxPathEntry[] =>
  sessionDirsOf(id, ws).map((p) => row(p, 'write', false))

/** 照 acl/derive.ts，从管理器交出的会话自己的目录拼派生行（真链接的用例要按指向）；null → 一行都没有 */
function rowsFrom(own: SessionOwnDirs | null): SandboxPathEntry[] {
  if (!own) return []
  return [
    ...(own.workdir ? [row(own.workdir, 'write', false)] : []),
    ...[own.tmp, own.artifacts, own.toolResults].map((p) => row(p, 'write', false))
  ]
}

/**
 * 开发态下宿主交给沙箱的「ShuviX 自己的程序」：可执行文件所在的应用包（不在应用包里就取它的目录）、
 * CLI 入口与包装脚本的目录 —— 照 utils/paths 的 getShuvixCliEnv 现算
 */
function expectedAppPaths(): string[] {
  const cli = getShuvixCliEnv()
  const at = cli.SHUVIX_ELECTRON.indexOf('.app/')
  const bundle =
    at >= 0 ? cli.SHUVIX_ELECTRON.slice(0, at + '.app'.length) : dirname(cli.SHUVIX_ELECTRON)
  return [...new Set([bundle, dirname(cli.SHUVIX_CLI_JS), dirname(cli.SHUVIX_CLI)])]
}

/** tmp 根的 lstat 结果（属于当前用户、0700 的目录） */
interface FakeStat {
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
  uid: number
  mode: number
}
function tmpRootStat(
  over: { mode?: number; uid?: number; symlink?: boolean; dir?: boolean } = {}
): FakeStat {
  return {
    isDirectory: () => over.dir ?? true,
    isSymbolicLink: () => over.symlink ?? false,
    uid: over.uid ?? UID,
    mode: over.mode ?? 0o40700
  }
}

/** 一次 planFor 请求：不给 entries 时是这条会话派生的四行 */
const request = (over: Partial<PlanRequest> = {}): PlanRequest => {
  const sessionId = over.sessionId ?? 's1'
  const workingDirectory = over.workingDirectory ?? WS
  return {
    sessionId,
    workingDirectory,
    entries: ownRowsOf(sessionId, workingDirectory),
    offerEscalation: true,
    ...over
  }
}

const scratch: string[] = []

beforeEach(() => {
  setPlatform('darwin')
  for (const fn of [
    mocks.getPath,
    mocks.homedir,
    mocks.probe,
    mocks.wrap,
    mocks.startupFailure,
    mocks.mkdirSync,
    mocks.lstatSync,
    mocks.chmodSync,
    mocks.rmSync,
    mocks.explainSpy,
    ...Object.values(mocks.log)
  ]) {
    fn.mockReset()
  }
  mocks.app.getPath = mocks.getPath
  mocks.app.isPackaged = false
  delete mocks.app.getAppPath
  mocks.getPath.mockReturnValue(USER_DATA)
  mocks.homedir.mockReturnValue(HOME)
  mocks.probe.mockReturnValue({ available: true })
  mocks.wrap.mockImplementation((_spec, inv: { file: string; args: string[] }) => ({
    file: '/fake/sandbox',
    args: [inv.file, ...inv.args]
  }))
  mocks.startupFailure.mockReturnValue(null)
  mocks.lstatSync.mockReturnValue(tmpRootStat())
})

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM)
  vi.restoreAllMocks()
})

afterAll(async () => {
  const { rmSync } = await vi.importActual<typeof import('fs')>('fs')
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** 真临时目录里的一个符号链接（指向一个真目录）：[链接, 目标的真实路径] */
async function realSymlink(prefix: string): Promise<[string, string]> {
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const os = await vi.importActual<typeof import('os')>('os')
  const base = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), prefix))
  scratch.push(base)
  const target = join(base, 'target')
  fs.mkdirSync(target)
  const link = join(base, 'link')
  fs.symlinkSync(target, link)
  return [link, target]
}

describe('MG-1 开关的读取', () => {
  it('MG-1 从没注入读取口 → 关闭；后端可用也不启用', async () => {
    const m = await load()
    expect(m.sandboxStatus().enabled).toBe(false)
    expect(m.sandboxStatus().available).toBe(true)
    expect(m.sandboxGloballyActive()).toBe(false)
  })

  it.each([undefined, '', 'true', 'FALSE', '0'])('MG-1 读到 %j → 启用', async (value) => {
    const m = await load(() => value)
    expect(m.sandboxStatus().enabled).toBe(true)
    expect(m.sandboxGloballyActive()).toBe(true)
  })

  it.each(['false', ' false\n'])('MG-1 读到 %j → 关闭', async (value) => {
    const m = await load(() => value)
    expect(m.sandboxStatus().enabled).toBe(false)
    expect(m.sandboxGloballyActive()).toBe(false)
  })

  it('MG-1 读取口抛错 → 关闭', async () => {
    const m = await load(() => {
      throw new Error('db closed')
    })
    expect(m.sandboxStatus().enabled).toBe(false)
    expect(m.sandboxGloballyActive()).toBe(false)
  })

  it('MG-1 sandboxGloballyActive = 启用 && 探测可用', async () => {
    mocks.probe.mockReturnValue({ available: false, reason: 'nested' })
    const m = await load(() => 'true')
    expect(m.sandboxStatus().enabled).toBe(true)
    expect(m.sandboxGloballyActive()).toBe(false)
  })

  it('MG-1 设置关着：读全局开关不探测、不碰 app.getPath', async () => {
    const m = await load(() => 'false')
    expect(m.sandboxGloballyActive()).toBe(false)
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(mocks.getPath).not.toHaveBeenCalled()
  })
})

describe('MG-2 后端选择 + 探测缓存 + 宿主路径', () => {
  it.each(['linux', 'win32'] as const)(
    'MG-2 %s：没有后端 → 不支持、不可用；全局不启用、没有计划、清理不删任何东西',
    async (platform) => {
      setPlatform(platform)
      const m = await load(() => 'true')
      expect(m.sandboxStatus()).toEqual({
        supported: false,
        available: false,
        enabled: true,
        reason: 'no sandbox backend for this platform'
      })
      expect(m.sandboxGloballyActive()).toBe(false)
      expect(m.planFor(request())).toBeNull()
      m.cleanupSession('s1')
      expect(mocks.rmSync).not.toHaveBeenCalled()
      expect(mocks.probe).not.toHaveBeenCalled()
    }
  )

  it('MG-2 darwin + 探测成功：跨 3 次 status、2 次全局开关、2 次 planFor 只探测一次；可用时没有 reason 键', async () => {
    const m = await load(() => 'true')
    const statuses = [m.sandboxStatus(), m.sandboxStatus(), m.sandboxStatus()]
    m.sandboxGloballyActive()
    m.sandboxGloballyActive()
    expect(m.planFor(request({ sessionId: 'a' }))).not.toBeNull()
    expect(m.planFor(request({ sessionId: 'b' }))).not.toBeNull()
    expect(mocks.probe).toHaveBeenCalledTimes(1)
    for (const s of statuses) {
      expect(s).toEqual({ supported: true, available: true, enabled: true })
      expect('reason' in s).toBe(false)
    }
  })

  it('MG-2 探测以宿主路径为参数：home / userData / ~/.shuvix / 工具结果根 / CLI 的 socket 与 token / ShuviX 自己的程序 / 短 tmp 根（都是原样写法，不解析）', async () => {
    const m = await load(() => 'true')
    m.sandboxStatus()
    expect(mocks.probe).toHaveBeenCalledWith({
      home: HOME,
      userData: USER_DATA,
      shuvixHome: SHUVIX,
      toolResultsBase: `${USER_DATA}/tool_results`,
      uid: UID,
      cliSocket: `${SHUVIX}/cli.sock`,
      cliToken: `${SHUVIX}/cli-token`,
      appPaths: expectedAppPaths(),
      tmpRoot: TMP_ROOT
    })
  })

  it('MG-2 ShuviX 自己的程序：可执行文件在 .app 里就取整个应用包', async () => {
    const realExecPath = process.execPath
    process.execPath = '/Applications/ShuviX.app/Contents/MacOS/ShuviX'
    try {
      const m = await load(() => 'true')
      m.sandboxStatus()
      const paths = mocks.probe.mock.calls[0][0] as { appPaths: string[] }
      expect(paths.appPaths[0]).toBe('/Applications/ShuviX.app')
      expect(paths.appPaths).toEqual(expectedAppPaths())
    } finally {
      process.execPath = realExecPath
    }
  })

  it('MG-2 ShuviX 自己的程序算不出来（CLI 入口取不到）→ 空清单，照样探测、照样给计划', async () => {
    // 打包态却没有 app.getAppPath：getShuvixCliEnv 抛错
    mocks.app.isPackaged = true
    const m = await load(() => 'true')
    expect(m.sandboxStatus().available).toBe(true)
    expect((mocks.probe.mock.calls[0][0] as { appPaths: string[] }).appPaths).toEqual([])
    const plan = m.planFor(request())
    expect(plan).not.toBeNull()
    expect(plan!.spec.readableRoots).toEqual(sessionDirsOf('s1'))
  })

  it('MG-2 探测失败：60 秒内沿用失败结果（不重探），过了 60 秒重探一次；失败时带 reason', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    mocks.probe.mockReturnValue({ available: false, reason: 'sandbox-exec: nested' })
    const m = await load(() => 'true')

    const first = m.sandboxStatus()
    expect(first).toEqual({
      supported: true,
      available: false,
      enabled: true,
      reason: 'sandbox-exec: nested'
    })
    m.sandboxStatus()
    m.sandboxStatus()
    expect(m.sandboxGloballyActive()).toBe(false)
    expect(m.sandboxGloballyActive()).toBe(false)
    expect(m.planFor(request({ sessionId: 'a' }))).toBeNull()
    expect(m.planFor(request({ sessionId: 'b' }))).toBeNull()
    expect(mocks.probe).toHaveBeenCalledTimes(1)
    // planFor 在探测失败时不碰文件系统
    expect(mocks.mkdirSync).not.toHaveBeenCalled()

    now += 60_000
    m.sandboxStatus()
    expect(mocks.probe).toHaveBeenCalledTimes(1)

    // 这次重探成功了 —— 之后缓存到进程结束
    mocks.probe.mockReturnValue({ available: true })
    now += 1
    expect(m.sandboxStatus().available).toBe(true)
    expect(mocks.probe).toHaveBeenCalledTimes(2)
    now += 10 * 60_000
    expect(m.sandboxStatus().available).toBe(true)
    expect(m.planFor(request({ sessionId: 'c' }))).not.toBeNull()
    expect(mocks.probe).toHaveBeenCalledTimes(2)
  })
})

describe('MG-3 planFor 不看开关', () => {
  it('MG-3 planFor 不看开关：固定为沙箱模式的工具实例才会来要计划，开关中途关掉，还在用的旧实例照样受限', async () => {
    let setting: string | undefined = 'true'
    const m = await load(() => setting)
    expect(m.sandboxGloballyActive()).toBe(true)
    setting = 'false'
    expect(m.sandboxGloballyActive()).toBe(false)
    expect(m.planFor(request({ sessionId: 's1' }))).not.toBeNull()
  })

  it('MG-3 没有后端 / 探测失败时 planFor 直接 null，不碰 fs', async () => {
    mocks.probe.mockReturnValue({ available: false, reason: 'x' })
    const m = await load(() => 'true')
    expect(m.planFor(request())).toBeNull()
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
    expect(mocks.lstatSync).not.toHaveBeenCalled()
  })
})

describe('MG-4 planFor 正常路径', () => {
  it('MG-4 env = TMPDIR/TMP/TEMP 指向本会话临时目录；wrap 交给后端；临时目录先建根再建会话目录（都 0700）', async () => {
    const m = await load(() => 'true')
    const plan = m.planFor(request())
    expect(plan).not.toBeNull()
    const tmpDir = tmpDirOf('s1')
    expect(plan!.env).toEqual({ TMPDIR: `${tmpDir}/`, TMP: tmpDir, TEMP: tmpDir })
    expect(plan!.spec.tmpDir).toBe(tmpDir)

    const inv = { file: '/bin/bash', args: ['-c', 'true'] }
    const wrapped = plan!.wrap(inv)
    expect(mocks.wrap).toHaveBeenCalledWith(plan!.spec, inv)
    expect(wrapped).toEqual({ file: '/fake/sandbox', args: ['/bin/bash', '-c', 'true'] })

    expect(mocks.mkdirSync).toHaveBeenCalledWith(TMP_ROOT, { recursive: true, mode: 0o700 })
    expect(mocks.mkdirSync).toHaveBeenCalledWith(tmpDir, { recursive: true, mode: 0o700 })
    expect(mocks.chmodSync).not.toHaveBeenCalled()
  })

  it('MG-4 规格带上请求里权限表的行：派生的（会话自己的目录、知识库可写、技能只读）与授予的（写 / 读）—— 可读根、可写根、cli-token', async () => {
    const m = await load(() => 'true')
    const plan = m.planFor(
      request({
        entries: [
          ...ownRowsOf('s1'),
          row(KB, 'write', false),
          row(SKILLS, 'read', false),
          row('/Volumes/data/out', 'write', true),
          row(`${HOME}/ref`, 'read', true)
        ]
      })
    )!
    const writable = [...sessionDirsOf('s1'), KB]
    expect(plan.spec.writableRoots).toEqual([...writable, '/Volumes/data/out'])
    expect(plan.spec.readableRoots.slice(0, writable.length + 3)).toEqual([
      ...writable,
      SKILLS,
      '/Volumes/data/out',
      `${HOME}/ref`
    ])
    expect(plan.spec.readableFiles).toEqual([`${SHUVIX}/cli-token`])
    expect(plan.spec.home).toBe(HOME)
  })

  it('MG-4 只有派生的四行：可写根就是它们；表是空的：只剩本会话临时目录（恒在），工作目录也不可读写 —— 沙箱只认表', async () => {
    const m = await load(() => 'true')
    expect(m.planFor(request())!.spec.writableRoots).toEqual(sessionDirsOf('s1'))
    const bare = m.planFor(request({ entries: [] }))!
    expect(bare.spec.writableRoots).toEqual([tmpDirOf('s1')])
    expect(bare.spec.readableRoots[0]).toBe(tmpDirOf('s1'))
    expect(bare.spec.readableRoots).not.toContain(WS)
    expect(bare.spec.workingDirectory).toBe(WS)
  })

  it('MG-4 工作目录是别的会话的临时工作区（临时会话的 fork 共用源会话的）：照给计划，它排在可写根最前，其余仍是本会话自己的', async () => {
    const shared = `${USER_DATA}/temp_workspace/other`
    const m = await load(() => 'true')
    // 派生行的来源（sessionOwnDirsView）认它是这条会话的工作目录
    const own = m.sessionOwnDirsView('s1', shared)
    expect(own?.workdir).toBe(shared)
    const plan = m.planFor(request({ workingDirectory: shared, entries: rowsFrom(own) }))
    expect(plan).not.toBeNull()
    expect(plan!.spec.workingDirectory).toBe(shared)
    expect(plan!.spec.writableRoots).toEqual(sessionDirsOf('s1', shared))
  })

  it('MG-4 工作目录是真的符号链接：规格里是它指向的真实路径（派生行里是，行里照写法存的链接也按指向）', async () => {
    const [link, target] = await realSymlink('sbx-mg4-')
    const m = await load(() => 'true')
    expect(m.sessionOwnDirsView('s1', link)?.workdir).toBe(target)
    const plan = m.planFor(
      request({ workingDirectory: link, entries: rowsFrom(m.sessionOwnDirsView('s1', link)) })
    )
    expect(plan).not.toBeNull()
    expect(plan!.spec.workingDirectory).toBe(target)
    expect(plan!.spec.writableRoots[0]).toBe(target)
    const asWritten = m.planFor(
      request({ workingDirectory: link, entries: [row(link, 'write', true)] })
    )
    expect(asWritten!.spec.writableRoots[0]).toBe(target)
    expect(JSON.stringify(asWritten!.spec)).not.toContain(link)
  })
})

describe('MG-5 planFor → null', () => {
  it.each([
    [
      '授予的写覆盖家目录',
      { entries: [...ownRowsOf('s1'), row(HOME, 'write', true)] },
      'a write grant covers the home folder'
    ],
    ['工作目录就是家目录', { workingDirectory: HOME }, 'working directory covers the home folder'],
    [
      '工作目录在 ~/.shuvix/agents',
      { workingDirectory: `${SHUVIX}/agents` },
      "ShuviX's own configuration"
    ],
    [
      '工作目录在 userData 里（不是任何会话的临时工作区）',
      { workingDirectory: `${USER_DATA}/data` },
      'application data'
    ],
    [
      '工作目录包含 userData（~/Library）',
      { workingDirectory: `${HOME}/Library` },
      "working directory contains ShuviX's own configuration or application data"
    ],
    [
      '授予的写在 ~/.shuvix/policies 里',
      { entries: [...ownRowsOf('s1'), row(`${SHUVIX}/policies`, 'write', true)] },
      "a write grant is ShuviX's own configuration"
    ],
    [
      '授予的写包含 userData（~/Library）',
      { entries: [...ownRowsOf('s1'), row(`${HOME}/Library`, 'write', true)] },
      "a write grant contains ShuviX's own configuration or application data"
    ],
    ['会话 id 不安全', { sessionId: '../x' }, 'unsafe session id']
  ] as Array<[string, Partial<PlanRequest>, string]>)(
    'MG-5 规格被拒（%s）：null，记下原因，不建临时目录',
    async (_label, over, reason) => {
      const m = await load(() => 'true')
      expect(m.planFor(request(over))).toBeNull()
      const logged = mocks.log.info.mock.calls.map((c) => String(c[0])).join('\n')
      expect(logged).toContain(reason)
      expect(mocks.mkdirSync).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['tmp 根是符号链接', () => mocks.lstatSync.mockReturnValue(tmpRootStat({ symlink: true }))],
    ['tmp 根属于别的用户', () => mocks.lstatSync.mockReturnValue(tmpRootStat({ uid: UID + 1 }))],
    ['tmp 根不是目录', () => mocks.lstatSync.mockReturnValue(tmpRootStat({ dir: false }))],
    [
      'mkdirSync 抛错',
      () =>
        mocks.mkdirSync.mockImplementation(() => {
          throw new Error('EACCES')
        })
    ]
  ])('MG-5 临时目录建不起来（%s）→ null，记警告', async (_label, arrange) => {
    arrange()
    const m = await load(() => 'true')
    expect(m.planFor(request())).toBeNull()
    expect(mocks.log.warn).toHaveBeenCalled()
  })

  it('MG-5 真的 userData 里，temp_workspace/OTHER 是指向 userData/data 的符号链接：按指向判 —— 没有计划，权限表也不会有它那一行；同处一个真文件夹则照给', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs')
    const os = await vi.importActual<typeof import('os')>('os')
    const root = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), 'sbx-mg5-fork-'))
    scratch.push(root)
    const userData = join(root, 'ShuviX')
    const data = join(userData, 'data')
    fs.mkdirSync(data, { recursive: true })
    fs.mkdirSync(join(userData, 'temp_workspace', 'REAL'), { recursive: true })
    const link = join(userData, 'temp_workspace', 'OTHER')
    fs.symlinkSync(data, link)
    mocks.getPath.mockReturnValue(userData)

    const m = await load(() => 'true')
    const view = m.sessionOwnDirsView('s1', link)!
    expect(view.workdir).toBeNull()
    expect(view.workspaceUnsuitable).toBe("working directory is inside ShuviX's application data")
    const rows = rowsFrom(view).map((e) => e.path)
    expect(rows).toEqual([tmpDirOf('s1'), `${SHUVIX}/artifacts/s1`, `${userData}/tool_results/s1`])
    expect(rows).not.toContain(link)
    expect(rows).not.toContain(data)
    expect(m.planFor(request({ workingDirectory: link, entries: rowsFrom(view) }))).toBeNull()
    const logged = mocks.log.info.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain("working directory is inside ShuviX's application data")

    // 对照：temp_workspace 下的真文件夹就是某条会话的临时工作区
    const realDir = join(userData, 'temp_workspace', 'REAL')
    const realView = m.sessionOwnDirsView('s1', realDir)!
    expect(realView.workdir).toBe(realDir)
    const plan = m.planFor(request({ workingDirectory: realDir, entries: rowsFrom(realView) }))
    expect(plan).not.toBeNull()
    expect(plan!.spec.writableRoots[0]).toBe(realDir)
  })

  it('MG-5 tmp 根权限是 0755：先 chmod 回 0700，再照常给计划', async () => {
    mocks.lstatSync.mockReturnValue(tmpRootStat({ mode: 0o40755 }))
    const m = await load(() => 'true')
    expect(m.planFor(request())).not.toBeNull()
    expect(mocks.chmodSync).toHaveBeenCalledWith(TMP_ROOT, 0o700)
    for (const call of mocks.mkdirSync.mock.calls) {
      expect(call[1]).toEqual({ recursive: true, mode: 0o700 })
    }
  })
})

describe('MG-6 plan.explain', () => {
  it('MG-6 后端认出沙箱没起来：说「沙箱没能启动、命令没跑」，不去问拒绝分类器', async () => {
    mocks.startupFailure.mockReturnValue('sandbox-exec: sandbox_apply: Operation not permitted')
    const m = await load(() => 'true')
    const plan = m.planFor(request())!
    const note = plan.explain('sandbox-exec: sandbox_apply: Operation not permitted\n', 71)
    expect(note).toBe(
      "[sandbox] The sandbox could not start (sandbox-exec: sandbox_apply: Operation not permitted); the command did not run. This is a ShuviX problem, not the command's — tell the user."
    )
    expect(mocks.startupFailure).toHaveBeenCalledWith(
      'sandbox-exec: sandbox_apply: Operation not permitted\n',
      71
    )
    expect(mocks.explainSpy).not.toHaveBeenCalled()
    expect(mocks.log.error).toHaveBeenCalled()
  })

  it.each([true, false])(
    'MG-6 否则交给拒绝分类器（offerEscalation=%s 反映在说明里）',
    async (offerEscalation) => {
      const m = await load(() => 'true')
      const plan = m.planFor(request({ offerEscalation }))!
      const out =
        'touch: /private/tmp/x: Operation not permitted\ncat: /Users/u/.ssh/id: Operation not permitted\n'
      const note = plan.explain(out, 1)
      expect(mocks.explainSpy).toHaveBeenCalledWith({
        spec: plan.spec,
        outputTail: out,
        exitCode: 1,
        offerEscalation
      })
      expect(note).toContain('cannot write: /private/tmp/x')
      expect(note).toContain('cannot read: /Users/u/.ssh/id')
      if (offerEscalation) expect(note).toContain('dangerouslyDisableSandbox')
      else expect(note).not.toContain('dangerouslyDisableSandbox')
    }
  )
})

describe('MG-7 cleanupSession', () => {
  it('MG-7 删掉 tmp 根下本会话的目录', async () => {
    const m = await load(() => 'true')
    m.cleanupSession('s1')
    expect(mocks.rmSync).toHaveBeenCalledWith(join(TMP_ROOT, sha8('s1')), {
      recursive: true,
      force: true
    })
  })

  it('MG-7 不安全的会话 id：不删', async () => {
    const m = await load(() => 'true')
    m.cleanupSession('../x')
    expect(mocks.rmSync).not.toHaveBeenCalled()
  })

  it('MG-7 rmSync 抛错被吞掉', async () => {
    mocks.rmSync.mockImplementation(() => {
      throw new Error('EBUSY')
    })
    const m = await load(() => 'true')
    expect(() => m.cleanupSession('s1')).not.toThrow()
    expect(mocks.rmSync).toHaveBeenCalledTimes(1)
  })
})

describe('MG-8 whyUnconfined：命令没进沙箱的原因（不触发探测）', () => {
  type Reader = (() => string | undefined) | undefined
  const throwing: Reader = () => {
    throw new Error('db closed')
  }
  const DISABLED: Array<[string, Reader]> = [
    ['读取口没注入', undefined],
    ["读取口回 'false'", () => 'false'],
    ["读取口回 ' false '", () => ' false '],
    ['读取口抛错', throwing]
  ]
  const UNAVAILABLE: Array<[string, Reader]> = [
    ['读取口回 undefined', () => undefined],
    ["读取口回 'true'", () => 'true'],
    ["读取口回 'FALSE'", () => 'FALSE']
  ]

  it.each(['linux', 'win32'] as const)(
    "MG-8a %s：恒 'unsupported' —— 开关开 / 关 / 读取口没注入都一样",
    async (platform) => {
      setPlatform(platform)
      for (const [label, reader] of [...DISABLED, ...UNAVAILABLE]) {
        const m = await load(reader)
        expect({ label, reason: m.whyUnconfined() }).toEqual({ label, reason: 'unsupported' })
      }
      expect(mocks.probe).not.toHaveBeenCalled()
    }
  )

  it.each(DISABLED)("MG-8b darwin：%s → 'disabled'", async (_label, reader) => {
    const m = await load(reader)
    expect(m.whyUnconfined()).toBe('disabled')
  })

  it.each(UNAVAILABLE)("MG-8b darwin：%s → 'unavailable'", async (_label, reader) => {
    const m = await load(reader)
    expect(m.whyUnconfined()).toBe('unavailable')
  })

  it('MG-8c 以上各情形反复问，探测一次都不跑（这是每条命令都走的路径）', async () => {
    for (const [label, reader] of [...DISABLED, ...UNAVAILABLE]) {
      const m = await load(reader)
      for (let i = 0; i < 3; i++) m.whyUnconfined()
      expect({ label, probes: mocks.probe.mock.calls.length }).toEqual({ label, probes: 0 })
    }
  })
})

describe('MG-9 sessionOwnDirsView / settingDirForAcl：权限表派生行的来源（与沙箱开没开无关）', () => {
  const EXPECTED: SessionOwnDirs = {
    workdir: WS,
    workspaceUnsuitable: null,
    tmp: tmpDirOf('s1'),
    artifacts: `${SHUVIX}/artifacts/s1`,
    toolResults: `${USER_DATA}/tool_results/s1`
  }

  it('MG-9a 正常工作目录：读取口没注入 / 设置关着 / 探测失败 / 沙箱启用 四种情形逐字相同；照它拼的行交给 planFor，就是规格的可写根', async () => {
    const views: Array<[string, SessionOwnDirs | null, string | null]> = []

    // ① 读取口没注入（= 关闭）：也不探测
    {
      const m = await load()
      views.push(['读取口没注入', m.sessionOwnDirsView('s1', WS), m.settingDirForAcl(KB)])
      expect(mocks.probe).not.toHaveBeenCalled()
    }
    // ② 设置关着
    {
      const m = await load(() => 'false')
      expect(m.sandboxGloballyActive()).toBe(false)
      views.push(['设置关着', m.sessionOwnDirsView('s1', WS), m.settingDirForAcl(KB)])
    }
    // ③ 探测失败：不套
    {
      mocks.probe.mockReturnValue({ available: false, reason: 'nested' })
      const m = await load(() => 'true')
      expect(m.sandboxGloballyActive()).toBe(false)
      views.push(['探测失败', m.sessionOwnDirsView('s1', WS), m.settingDirForAcl(KB)])
      mocks.probe.mockReturnValue({ available: true })
    }
    // ④ 沙箱真的套上：派生行就是这条会话的规格里那一份
    {
      const m = await load(() => 'true')
      expect(m.sandboxGloballyActive()).toBe(true)
      const view = m.sessionOwnDirsView('s1', WS)
      const kb = m.settingDirForAcl(KB)
      const plan = m.planFor(request({ entries: [...rowsFrom(view), row(kb!, 'write', false)] }))!
      expect(plan.spec.writableRoots).toEqual([...sessionDirsOf('s1'), KB])
      views.push(['沙箱启用', view, kb])
    }

    for (const [label, view, kb] of views) {
      expect({ label, view, kb }).toEqual({ label, view: EXPECTED, kb: KB })
    }
  })

  it.each(['linux', 'win32'] as const)(
    'MG-9b %s（没有沙箱后端）：照给 —— 文件工具一样只在权限表以外询问；不探测',
    async (platform) => {
      setPlatform(platform)
      const m = await load(() => 'true')
      expect(m.sessionOwnDirsView('s1', WS)).toEqual(EXPECTED)
      expect(m.settingDirForAcl(SKILLS)).toBe(SKILLS)
      expect(mocks.probe).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['勾选的知识库', KB, KB],
    ['技能目录', SKILLS, SKILLS],
    ['家目录以外的目录', '/Volumes/x/skills', '/Volumes/x/skills'],
    ['空串', '', null],
    ['根目录 /', '/', null],
    ['家目录本身', HOME, null],
    ['覆盖家目录的 /Users', '/Users', null]
  ])(
    'MG-9c settingDirForAcl（%s %j）→ %j：空串、/、覆盖家目录的不进权限表；不记警告（这是判定，不是失败）',
    async (_label, dir, expected) => {
      const m = await load(() => 'true')
      expect(m.settingDirForAcl(dir)).toBe(expected)
      expect(mocks.log.warn).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['根目录 /', '/'],
    ['家目录本身', HOME],
    ['覆盖家目录的 /Users', '/Users'],
    ['ShuviX 自己的配置 ~/.shuvix/agents', `${SHUVIX}/agents`],
    ['userData 里的应用数据', `${USER_DATA}/data`],
    ['包含 userData 的 ~/Library', `${HOME}/Library`],
    ['包含 userData 的 ~/Library/Application Support', `${HOME}/Library/Application Support`]
  ])(
    'MG-9d 不适合的工作目录（%s）：workdir 为 null 并说明原因（权限表里没有它那一行），其余三项照给；不记警告（这是判定，不是失败）',
    async (_label, ws) => {
      const m = await load(() => 'true')
      const view = m.sessionOwnDirsView('s1', ws)!
      expect(view.workdir).toBeNull()
      expect(view.workspaceUnsuitable).toMatch(/^working directory /)
      expect(rowsFrom(view).map((e) => e.path)).toEqual(sessionDirsOf('s1').slice(1))
      expect(mocks.log.warn).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['本会话的临时工作区', `${USER_DATA}/temp_workspace/s1`],
    ['别的会话的临时工作区（会话 fork 共用源会话的）', `${USER_DATA}/temp_workspace/other`],
    ['知识库 ~/.shuvix/knowledge/<base>', `${SHUVIX}/knowledge/notes`],
    ['个人资料目录 ~/Documents', `${HOME}/Documents`]
  ])('MG-9d 合适的工作目录（%s）：它就是 workdir，排在派生行最前', async (_label, ws) => {
    const m = await load()
    const view = m.sessionOwnDirsView('s1', ws)!
    expect(view.workdir).toBe(ws)
    expect(view.workspaceUnsuitable).toBeNull()
    expect(rowsFrom(view).map((e) => e.path)).toEqual(sessionDirsOf('s1', ws))
  })

  it.each(['', '../x', '..'])(
    'MG-9e 会话 id 不安全（%j）：null —— 一行都不派生（多问，绝不因此放行），不记警告',
    async (sid) => {
      const m = await load(() => 'true')
      expect(m.sessionOwnDirsView(sid, WS)).toBeNull()
      expect(mocks.log.warn).not.toHaveBeenCalled()
    }
  )

  it('MG-9f 算不出来（app.getPath 抛）：两个都给 null、各记一行警告、不往外抛', async () => {
    mocks.getPath.mockImplementation(() => {
      throw new Error('userData unavailable')
    })
    const m = await load(() => 'true')
    let view: SessionOwnDirs | null | undefined
    let dir: string | null | undefined
    expect(() => {
      view = m.sessionOwnDirsView('s1', WS)
      dir = m.settingDirForAcl(KB)
    }).not.toThrow()
    expect(view).toBeNull()
    expect(dir).toBeNull()
    expect(mocks.log.warn).toHaveBeenCalledTimes(2)
    for (const call of mocks.log.warn.mock.calls) {
      expect(String(call[0])).toContain('userData unavailable')
    }
  })

  it('MG-9g 工作目录与知识库是符号链接：交出的是它们指向的真实路径', async () => {
    const [wsLink, wsTarget] = await realSymlink('sbx-mg9-ws-')
    const [kbLink, kbTarget] = await realSymlink('sbx-mg9-kb-')
    const m = await load()
    const view = m.sessionOwnDirsView('s1', wsLink)!
    expect(view.workdir).toBe(wsTarget)
    expect(m.settingDirForAcl(kbLink)).toBe(kbTarget)
    expect(JSON.stringify(view)).not.toContain(wsLink)
  })
})
