/**
 * 沙箱管理器（sandbox/index.ts）—— 对外唯一入口：开关、后端选择与探测缓存、按会话固定、
 * 执行计划、策略变量、会话清理。
 *
 * 替身：electron 的 app.getPath、os.homedir、平台后端（假后端，探测 / 包装 / 启动失败都可控）、
 * fs 里 ensureTmpDir / cleanupSession 用到的几个函数（realpathSync 用真的 —— MG-4 要真符号链接）、
 * logger。模块级缓存（后端、探测结果、固定表、realpath 缓存）每个用例 resetModules 后重新导入。
 * 凭据清单的读取口（生产里由 main 注入 protect-credentials 的 `credentialDirs`）每次导入都注入出厂那一份。
 *
 * MG-9 whyUnconfined（命令没进沙箱的原因：固定那一刻的，或此刻的；从不探测）；
 * MG-10 workspaceWriteView（ask-on-write 的工作区豁免：与开关 / 固定 / 探测无关，只看规格的适用性判定）；
 * MG-11 凭据清单的读取口：没注入 / 抛错 / 去重 / realpath / 工作区就是凭据位置。
 * 两组的期望规格按同一份宿主路径用纯函数 buildSandboxSpec 算（`real` 取恒等：/Users/u 盘上不存在，
 * 管理器的 realpathLoose 对它也是原样）。
 */
import { createHash } from 'crypto'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const UID = process.getuid?.() ?? 0
const TMP_ROOT = `/private/tmp/shuvix-${UID}`
const HOME = '/Users/u'
const USER_DATA = '/Users/u/Library/Application Support/ShuviX'
const WS = '/Users/u/proj'
/** 出厂 protect-credentials 的 `credentialDirs` —— 注入给管理器的凭据清单 */
const CREDENTIALS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.netrc',
  '.shuvix/.session-state',
  'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Credentials'
].map((d) => `${HOME}/${d}`)

const mocks = vi.hoisted(() => ({
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

vi.mock('electron', () => ({ app: { getPath: mocks.getPath, isPackaged: false } }))
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

import { buildSandboxSpec, protectedWritePatterns } from '../spec'
import type { SandboxHostPaths, SandboxSpec } from '../types'

type Manager = typeof import('../index')
type PlanRequest = import('../index').PlanRequest

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM, value: p })
}

/** 每个用例一份全新的管理器（模块级缓存清零）；凭据清单的读取口照生产注入 */
async function load(reader?: () => string | undefined): Promise<Manager> {
  vi.resetModules()
  const m = await import('../index')
  if (reader) m.setSandboxSettingReader(reader)
  m.setSandboxCredentialReader(() => CREDENTIALS)
  return m
}

const sha8 = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 8)

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

const request = (over: Record<string, unknown> = {}): PlanRequest => ({
  sessionId: 's1',
  workingDirectory: WS,
  grantedWrite: [] as string[],
  offerEscalation: true,
  ...over
})

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

describe('MG-1 开关的读取', () => {
  it('MG-1 从没注入读取口 → 关闭；后端可用也不固定为启用', async () => {
    const m = await load()
    expect(m.sandboxStatus().enabled).toBe(false)
    expect(m.sandboxStatus().available).toBe(true)
    expect(m.pinSession('s1')).toBe(false)
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
    expect(m.pinSession('s1')).toBe(false)
  })

  it('MG-1 sandboxGloballyActive = 启用 && 探测可用', async () => {
    mocks.probe.mockReturnValue({ available: false, reason: 'nested' })
    const m = await load(() => 'true')
    expect(m.sandboxStatus().enabled).toBe(true)
    expect(m.sandboxGloballyActive()).toBe(false)
  })
})

describe('MG-2 后端选择 + 探测缓存', () => {
  it.each(['linux', 'win32'] as const)(
    'MG-2 %s：没有后端 → 不支持、不可用；pin 为假、没有计划、清理不删任何东西',
    async (platform) => {
      setPlatform(platform)
      const m = await load(() => 'true')
      expect(m.sandboxStatus()).toEqual({
        supported: false,
        available: false,
        enabled: true,
        reason: 'no sandbox backend for this platform'
      })
      expect(m.pinSession('s1')).toBe(false)
      expect(m.planFor(request())).toBeNull()
      m.cleanupSession('s1')
      expect(mocks.rmSync).not.toHaveBeenCalled()
      expect(mocks.probe).not.toHaveBeenCalled()
    }
  )

  it('MG-2 darwin + 探测成功：跨 3 次 status、2 次 pin、2 次 planFor 只探测一次；可用时没有 reason 键', async () => {
    const m = await load(() => 'true')
    const statuses = [m.sandboxStatus(), m.sandboxStatus(), m.sandboxStatus()]
    m.pinSession('a')
    m.pinSession('b')
    expect(m.planFor(request({ sessionId: 'a' }))).not.toBeNull()
    expect(m.planFor(request({ sessionId: 'b' }))).not.toBeNull()
    expect(mocks.probe).toHaveBeenCalledTimes(1)
    for (const s of statuses) {
      expect(s).toEqual({ supported: true, available: true, enabled: true })
      expect('reason' in s).toBe(false)
    }
  })

  it('MG-2 探测以宿主路径为参数（home / userData / ~/.shuvix / cli.sock / 短 tmp 根）', async () => {
    const m = await load(() => 'true')
    m.sandboxStatus()
    expect(mocks.probe).toHaveBeenCalledWith({
      home: HOME,
      userData: USER_DATA,
      shuvixHome: `${HOME}/.shuvix`,
      uid: UID,
      cliSocket: `${HOME}/.shuvix/cli.sock`,
      tmpRoot: TMP_ROOT
    })
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
    expect(m.pinSession('a')).toBe(false)
    expect(m.pinSession('b')).toBe(false)
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

describe('MG-3 按会话固定（契约 5）', () => {
  it('MG-3 启用时固定；开关中途关掉：已固定的会话不变、新会话按新值；unpin 之后按当时的开关重新决定', async () => {
    let setting: string | undefined = 'true'
    const m = await load(() => setting)
    expect(m.pinSession('s1')).toBe(true)

    setting = 'false'
    expect(m.pinSession('s1')).toBe(true)
    expect(m.pinSession('s2')).toBe(false)
    expect(m.planFor(request({ sessionId: 's1' }))).not.toBeNull()
    expect(m.sessionView('s1', WS).sandboxActive).toBe(true)

    m.unpinSession('s1')
    expect(m.sessionView('s1', WS)).toBe(m.INACTIVE_VIEW)
    expect(m.pinSession('s1')).toBe(false)
    expect(m.sessionView('s1', WS)).toBe(m.INACTIVE_VIEW)
  })

  it('MG-3 planFor 不看固定表（实现后改动）：固定为沙箱模式的工具实例才会来要计划，运行时失效后仍在收尾的旧实例照样受限', async () => {
    let setting: string | undefined = 'true'
    const m = await load(() => setting)
    expect(m.pinSession('s1')).toBe(true)
    m.unpinSession('s1')
    setting = 'false'
    expect(m.planFor(request({ sessionId: 's1' }))).not.toBeNull()
    // 从没固定过的会话也一样（只看后端与探测）
    expect(m.planFor(request({ sessionId: 'never-pinned' }))).not.toBeNull()
  })

  it('MG-3 没固定 / 固定为假：sessionView 直接给冻结的 INACTIVE_VIEW，不碰 app.getPath（其他单测的导入链靠这一点）', async () => {
    const m = await load(() => 'false')
    expect(m.sessionView('nobody', WS)).toBe(m.INACTIVE_VIEW)
    expect(m.pinSession('s1')).toBe(false)
    expect(m.sessionView('s1', WS)).toBe(m.INACTIVE_VIEW)
    expect(Object.isFrozen(m.INACTIVE_VIEW)).toBe(true)
    expect(m.INACTIVE_VIEW).toEqual({
      sandboxActive: false,
      sandboxWritableRoots: [],
      sandboxWriteDenied: [],
      sandboxProtectedPatterns: []
    })
    expect(mocks.getPath).not.toHaveBeenCalled()
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
  it('MG-4 env = TMPDIR/TMP/TEMP 指向本会话临时目录；wrap 交给后端；规格带上请求里的授权与注入的凭据清单', async () => {
    const m = await load(() => 'true')
    const plan = m.planFor(request({ grantedWrite: ['/Volumes/data/out'] }))
    expect(plan).not.toBeNull()
    const tmpDir = `${TMP_ROOT}/${sha8('s1')}`
    expect(plan!.env).toEqual({ TMPDIR: `${tmpDir}/`, TMP: tmpDir, TEMP: tmpDir })
    expect(plan!.spec.tmpDir).toBe(tmpDir)
    expect(plan!.spec.writableRoots).toContain('/Volumes/data/out')
    expect(plan!.spec.readDenied).toEqual(CREDENTIALS)

    const inv = { file: '/bin/bash', args: ['-c', 'true'] }
    const wrapped = plan!.wrap(inv)
    expect(mocks.wrap).toHaveBeenCalledWith(plan!.spec, inv)
    expect(wrapped).toEqual({ file: '/fake/sandbox', args: ['/bin/bash', '-c', 'true'] })

    // 临时目录：先建根（0700），再建会话目录（0700）
    expect(mocks.mkdirSync).toHaveBeenCalledWith(TMP_ROOT, { recursive: true, mode: 0o700 })
    expect(mocks.mkdirSync).toHaveBeenCalledWith(tmpDir, { recursive: true, mode: 0o700 })
    expect(mocks.chmodSync).not.toHaveBeenCalled()
  })

  it('MG-4 工作区是真的符号链接：规格里是它指向的真实路径', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs')
    const os = await vi.importActual<typeof import('os')>('os')
    const base = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), 'sbx-mg4-'))
    scratch.push(base)
    const target = join(base, 'target')
    fs.mkdirSync(target)
    const link = join(base, 'link')
    fs.symlinkSync(target, link)

    const m = await load(() => 'true')
    const plan = m.planFor(request({ workingDirectory: link }))
    expect(plan).not.toBeNull()
    expect(plan!.spec.workingDirectory).toBe(target)
    expect(plan!.spec.writableRoots[0]).toBe(target)
  })
})

describe('MG-5 planFor → null', () => {
  it.each([
    ['写授权覆盖家目录', { grantedWrite: [HOME] }, 'a write grant covers the home folder'],
    [
      '工作区在 ~/.shuvix/agents',
      { workingDirectory: `${HOME}/.shuvix/agents` },
      "ShuviX's own configuration"
    ],
    [
      '工作区在 userData 里（不是本会话临时工作区）',
      { workingDirectory: `${USER_DATA}/temp_workspace/other` },
      'application data'
    ]
  ])('MG-5 规格被拒（%s）：null，记下原因，不建临时目录', async (_label, over, reason) => {
    const m = await load(() => 'true')
    expect(m.planFor(request(over))).toBeNull()
    const logged = mocks.log.info.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain(reason)
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
  })

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
      const out = 'touch: /Users/u/.shuvix/x: Operation not permitted\n'
      const note = plan.explain(out, 1)
      expect(mocks.explainSpy).toHaveBeenCalledWith({
        spec: plan.spec,
        outputTail: out,
        exitCode: 1,
        offerEscalation
      })
      expect(note).toContain('cannot write: /Users/u/.shuvix/x')
      if (offerEscalation) expect(note).toContain('dangerouslyDisableSandbox')
      else expect(note).not.toContain('dangerouslyDisableSandbox')
    }
  )
})

describe('MG-7 sessionView', () => {
  it('MG-7 固定为启用 + 工作区合适 → active；只有写的变量（没有读的）；不含授权（授权归 session-grants）', async () => {
    const m = await load(() => 'true')
    expect(m.pinSession('s1')).toBe(true)
    const view = m.sessionView('s1', WS)
    expect(view.sandboxActive).toBe(true)
    expect(Object.keys(view).sort()).toEqual([
      'sandboxActive',
      'sandboxProtectedPatterns',
      'sandboxWritableRoots',
      'sandboxWriteDenied'
    ])
    expect(view.sandboxWritableRoots[0]).toBe(WS)
    expect(view.sandboxWriteDenied).toContain(`${HOME}/.ssh`)

    const plan = m.planFor(request({ grantedWrite: ['/Volumes/data/out'] }))!
    expect(plan.spec.writableRoots).toContain('/Volumes/data/out')
    expect(view.sandboxWritableRoots).not.toContain('/Volumes/data/out')
  })

  it('MG-7 固定为启用但工作区不适合套（覆盖家目录）→ INACTIVE_VIEW', async () => {
    const m = await load(() => 'true')
    expect(m.pinSession('s1')).toBe(true)
    expect(m.sessionView('s1', HOME)).toBe(m.INACTIVE_VIEW)
  })
})

describe('MG-8 cleanupSession', () => {
  it('MG-8 删掉 tmp 根下本会话的目录，并解除固定', async () => {
    let setting: string | undefined = 'true'
    const m = await load(() => setting)
    expect(m.pinSession('s1')).toBe(true)
    setting = 'false'
    m.cleanupSession('s1')
    expect(mocks.rmSync).toHaveBeenCalledWith(join(TMP_ROOT, sha8('s1')), {
      recursive: true,
      force: true
    })
    // 已解除：下一次按此刻的开关（关）重新决定
    expect(m.pinSession('s1')).toBe(false)
  })

  it('MG-8 不安全的会话 id：不删，但照样解除固定', async () => {
    let setting: string | undefined = 'true'
    const m = await load(() => setting)
    expect(m.pinSession('../x')).toBe(true)
    setting = 'false'
    m.cleanupSession('../x')
    expect(mocks.rmSync).not.toHaveBeenCalled()
    expect(m.pinSession('../x')).toBe(false)
  })

  it('MG-8 rmSync 抛错被吞掉', async () => {
    mocks.rmSync.mockImplementation(() => {
      throw new Error('EBUSY')
    })
    const m = await load(() => 'true')
    expect(() => m.cleanupSession('s1')).not.toThrow()
    expect(mocks.rmSync).toHaveBeenCalledTimes(1)
  })
})

describe('MG-9 whyUnconfined：命令没进沙箱的原因（不触发探测）', () => {
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
    "MG-9a %s：恒 'unsupported' —— 开关开 / 关 / 读取口没注入，固定前、固定后、解除后都一样",
    async (platform) => {
      setPlatform(platform)
      for (const [label, reader] of [...DISABLED, ...UNAVAILABLE]) {
        const m = await load(reader)
        expect({ label, before: m.whyUnconfined('s1') }).toEqual({
          label,
          before: 'unsupported'
        })
        expect(m.pinSession('s1')).toBe(false)
        expect({ label, pinned: m.whyUnconfined('s1') }).toEqual({
          label,
          pinned: 'unsupported'
        })
        m.unpinSession('s1')
        expect({ label, after: m.whyUnconfined('s1') }).toEqual({ label, after: 'unsupported' })
      }
      expect(mocks.probe).not.toHaveBeenCalled()
    }
  )

  it.each(DISABLED)("MG-9b darwin、没固定：%s → 'disabled'", async (_label, reader) => {
    const m = await load(reader)
    expect(m.whyUnconfined('s1')).toBe('disabled')
  })

  it.each(UNAVAILABLE)("MG-9b darwin、没固定：%s → 'unavailable'", async (_label, reader) => {
    const m = await load(reader)
    expect(m.whyUnconfined('s1')).toBe('unavailable')
  })

  it('MG-9c 以上各情形反复问、问多条会话，探测一次都不跑（这是每条命令都走的路径）', async () => {
    for (const [label, reader] of [...DISABLED, ...UNAVAILABLE]) {
      const m = await load(reader)
      for (const sid of ['s1', 's2', 's1']) m.whyUnconfined(sid)
      expect({ label, probes: mocks.probe.mock.calls.length }).toEqual({ label, probes: 0 })
    }
  })

  it("MG-9d 设置关着时固定：pin 为假；之后打开设置，这条会话仍是 'disabled'、另一条没固定的是 'unavailable'；unpin 之后回到此刻的状态", async () => {
    let setting: string | undefined = 'false'
    const m = await load(() => setting)
    expect(m.pinSession('s1')).toBe(false)
    expect(m.whyUnconfined('s1')).toBe('disabled')

    setting = 'true'
    expect(m.whyUnconfined('s1')).toBe('disabled')
    expect(m.whyUnconfined('s2')).toBe('unavailable')
    // 再固定一次拿到的仍是第一次的答案，原因也不改
    expect(m.pinSession('s1')).toBe(false)
    expect(m.whyUnconfined('s1')).toBe('disabled')

    m.unpinSession('s1')
    expect(m.whyUnconfined('s1')).toBe('unavailable')
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it("MG-9d 反方向：探测没过时固定 → 'unavailable'；之后关掉设置仍是 'unavailable'、没固定的会话是 'disabled'；cleanupSession 同样解除", async () => {
    mocks.probe.mockReturnValue({ available: false, reason: 'nested' })
    let setting: string | undefined = 'true'
    const m = await load(() => setting)
    expect(m.pinSession('s1')).toBe(false)
    expect(m.whyUnconfined('s1')).toBe('unavailable')

    setting = 'false'
    expect(m.whyUnconfined('s1')).toBe('unavailable')
    expect(m.whyUnconfined('s2')).toBe('disabled')

    m.cleanupSession('s1')
    expect(m.whyUnconfined('s1')).toBe('disabled')
    // 只有固定那一次探测过
    expect(mocks.probe).toHaveBeenCalledTimes(1)
  })
})

describe('MG-10 workspaceWriteView：文件工具在工作区写入免询问的范围（与沙箱开没开无关）', () => {
  const HOST: SandboxHostPaths = {
    home: HOME,
    userData: USER_DATA,
    shuvixHome: `${HOME}/.shuvix`,
    uid: UID,
    cliSocket: `${HOME}/.shuvix/cli.sock`,
    tmpRoot: TMP_ROOT
  }
  const EMPTY = { workspaceWritable: [], workspaceWriteDenied: [], workspaceProtectedPatterns: [] }

  /** 这个会话此刻的沙箱规格（管理器用的同一份宿主路径，不带授权） */
  function specOf(sessionId: string, workingDirectory: string): SandboxSpec {
    const built = buildSandboxSpec(
      HOST,
      { sessionId, workingDirectory, grantedWrite: [], credentialPaths: CREDENTIALS },
      (p) => p
    )
    if (!built.ok) throw new Error(`expected ok, got: ${built.reason}`)
    return built.spec
  }

  function expectedView(
    sessionId: string,
    workingDirectory: string
  ): ReturnType<Manager['workspaceWriteView']> {
    const spec = specOf(sessionId, workingDirectory)
    return {
      workspaceWritable: [workingDirectory],
      workspaceWriteDenied: spec.writeDeniedFinal,
      workspaceProtectedPatterns: protectedWritePatterns(spec)
    }
  }

  it('MG-10a 正常工作区：可写 = [WS]、禁区 = 该会话规格的 writeDeniedFinal、模式 = protectedWritePatterns(spec)；读取口没注入 / 探测失败 / 固定为假 / 沙箱启用 四种情形逐字相同', async () => {
    const expected = expectedView('s1', WS)
    // 前提：禁区里有凭据目录（没有工作区根上的别家配置了），模式里有 git 元数据那几条 —— 不是空的
    expect(expected.workspaceWriteDenied).toContain(`${HOME}/.ssh`)
    expect(expected.workspaceWriteDenied).not.toContain(`${WS}/.vscode`)
    expect(expected.workspaceProtectedPatterns.length).toBeGreaterThan(2)

    const views: Array<[string, ReturnType<Manager['workspaceWriteView']>]> = []

    // ① 读取口没注入（= 关闭）：也不探测
    {
      const m = await load()
      views.push(['读取口没注入', m.workspaceWriteView('s1', WS)])
      expect(mocks.probe).not.toHaveBeenCalled()
    }
    // ② 探测失败：会话固定成不套
    {
      mocks.probe.mockReturnValue({ available: false, reason: 'nested' })
      const m = await load(() => 'true')
      expect(m.pinSession('s1')).toBe(false)
      expect(m.sessionView('s1', WS)).toBe(m.INACTIVE_VIEW)
      views.push(['探测失败', m.workspaceWriteView('s1', WS)])
      mocks.probe.mockReturnValue({ available: true })
    }
    // ③ 设置关着、固定为假
    {
      const m = await load(() => 'false')
      expect(m.pinSession('s1')).toBe(false)
      views.push(['固定为假', m.workspaceWriteView('s1', WS)])
    }
    // ④ 沙箱真的套上：视图同样来自这个会话的规格（与 planFor 拿到的是同一份）
    {
      const m = await load(() => 'true')
      expect(m.pinSession('s1')).toBe(true)
      const plan = m.planFor(request())
      expect(plan).not.toBeNull()
      expect(plan!.spec.writeDeniedFinal).toEqual(expected.workspaceWriteDenied)
      expect(protectedWritePatterns(plan!.spec)).toEqual(expected.workspaceProtectedPatterns)
      views.push(['沙箱启用', m.workspaceWriteView('s1', WS)])
    }

    for (const [label, view] of views) {
      expect({ label, view }).toEqual({ label, view: expected })
    }
  })

  it.each([
    ['根目录 /', '/'],
    ['家目录本身', HOME],
    ['覆盖家目录的 /Users', '/Users'],
    ['ShuviX 自己的配置 ~/.shuvix/agents', `${HOME}/.shuvix/agents`],
    ['userData 里的应用数据', `${USER_DATA}/data`],
    ['userData 里别的会话的临时工作区', `${USER_DATA}/temp_workspace/other`],
    ['凭据目录 ~/.ssh', `${HOME}/.ssh`]
  ])(
    'MG-10b 不适合的工作区（%s）→ 三个空数组，不记警告（这是判定，不是失败）',
    async (_label, ws) => {
      const m = await load(() => 'true')
      expect(m.workspaceWriteView('s1', ws)).toEqual(EMPTY)
      expect(mocks.log.warn).not.toHaveBeenCalled()
    }
  )

  it.each(['', '../x'])(
    'MG-10b 会话 id 不安全（%j）→ 三个空数组，工作区合适也一样',
    async (sid) => {
      const m = await load(() => 'true')
      expect(m.workspaceWriteView(sid, WS)).toEqual(EMPTY)
    }
  )

  it.each([
    ['本会话的临时工作区', `${USER_DATA}/temp_workspace/s1`],
    ['知识库 ~/.shuvix/knowledge/<base>', `${HOME}/.shuvix/knowledge/notes`],
    ['个人资料目录本身 ~/Documents', `${HOME}/Documents`],
    ['包含敏感位置的 ~/Library（不再因此不给）', `${HOME}/Library`]
  ])('MG-10c 合适的工作区（%s）→ 非空视图，可写恰为它本身', async (_label, ws) => {
    const m = await load()
    const view = m.workspaceWriteView('s1', ws)
    expect(view).toEqual(expectedView('s1', ws))
    expect(view.workspaceWritable).toEqual([ws])
    expect(view.workspaceWriteDenied.length).toBeGreaterThan(0)
    expect(view.workspaceProtectedPatterns.length).toBeGreaterThan(0)
  })

  it('MG-10d win32：工作区再合适也给空视图（受保护模式按 / 写，碰上 \\ 路径会静默不匹配），不去算规格', async () => {
    setPlatform('win32')
    const m = await load(() => 'true')
    expect(m.workspaceWriteView('s1', WS)).toEqual(EMPTY)
    expect(mocks.getPath).not.toHaveBeenCalled()
    expect(mocks.log.warn).not.toHaveBeenCalled()
  })

  it('MG-10e 算规格时抛错（app.getPath 抛）→ 空视图、记一行警告、不往外抛', async () => {
    mocks.getPath.mockImplementation(() => {
      throw new Error('userData unavailable')
    })
    const m = await load(() => 'true')
    let view: ReturnType<Manager['workspaceWriteView']> | undefined
    expect(() => {
      view = m.workspaceWriteView('s1', WS)
    }).not.toThrow()
    expect(view).toEqual(EMPTY)
    expect(mocks.log.warn).toHaveBeenCalledTimes(1)
    expect(String(mocks.log.warn.mock.calls[0][0])).toContain('userData unavailable')
  })

  it('MG-10f 工作区是符号链接：可写取它指向的真实路径', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs')
    const os = await vi.importActual<typeof import('os')>('os')
    const base = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), 'sbx-mg10-'))
    scratch.push(base)
    const target = join(base, 'target')
    fs.mkdirSync(target)
    const link = join(base, 'link')
    fs.symlinkSync(target, link)

    const m = await load()
    const view = m.workspaceWriteView('s1', link)
    expect(view.workspaceWritable).toEqual([target])
    expect(view.workspaceWritable).not.toContain(link)
  })
})

/**
 * MG-11 凭据清单的读取口（setSandboxCredentialReader）：沙箱自己不定哪些是凭据，每次算规格都现问注入的
 * 读取口（生产里是 toolContext.sessionCredentialPaths，读生效的 protect-credentials）。没注入 = 没有凭据清单
 * （命令照样受限）+ 一次警告；读取口抛错 = 这一次没有清单 + 一行警告，绝不往外抛。
 */
describe('MG-11 凭据清单的读取口', () => {
  const EMPTY = { workspaceWritable: [], workspaceWriteDenied: [], workspaceProtectedPatterns: [] }

  /** 与 load() 相同，只是凭据读取口由用例决定（null = 不注入） */
  async function loadWith(
    credentialReader: ((sessionId: string, workingDirectory: string) => string[]) | null
  ): Promise<Manager> {
    vi.resetModules()
    const m = await import('../index')
    m.setSandboxSettingReader(() => 'true')
    if (credentialReader) m.setSandboxCredentialReader(credentialReader)
    return m
  }

  const warnLines = (): string[] => mocks.log.warn.mock.calls.map((c) => String(c[0]))

  it('MG-11a 从没注入：plan / sessionView / workspaceWriteView 都照常给（没有凭据位置），警告只记一次', async () => {
    const m = await loadWith(null)
    expect(m.pinSession('s1')).toBe(true)

    const first = m.planFor(request())
    expect(first).not.toBeNull()
    expect(first!.spec.readDenied).toEqual([])
    expect(first!.spec.writeDeniedFinal).not.toContain(`${HOME}/.ssh`)

    const view = m.sessionView('s1', WS)
    expect(view.sandboxActive).toBe(true)
    expect(view.sandboxWriteDenied).not.toContain(`${HOME}/.ssh`)

    const wsView = m.workspaceWriteView('s1', WS)
    expect(wsView.workspaceWritable).toEqual([WS])
    expect(wsView.workspaceWriteDenied).not.toContain(`${HOME}/.ssh`)

    const second = m.planFor(request())
    expect(second).not.toBeNull()
    expect(second!.spec.readDenied).toEqual([])

    expect(warnLines()).toHaveLength(1)
    expect(warnLines()[0]).toMatch(/no credential reader/)
  })

  it('MG-11b 注入的读取口：收到调用方给的 (sessionId, workingDirectory)；readDenied 就是它的输出、writeDeniedFinal 以它开头；每次 planFor 都现问', async () => {
    let answer = [`${HOME}/.ssh`, `${HOME}/vault`]
    const reader = vi.fn((_sid: string, _wd: string) => answer)
    const m = await loadWith(reader)

    const plan1 = m.planFor(request({ sessionId: 's7', workingDirectory: WS }))!
    expect(reader).toHaveBeenLastCalledWith('s7', WS)
    expect(plan1.spec.readDenied).toEqual(answer)
    expect(plan1.spec.writeDeniedFinal.slice(0, answer.length)).toEqual(answer)

    answer = [`${HOME}/.gnupg`]
    const plan2 = m.planFor(request({ sessionId: 's7', workingDirectory: WS }))!
    expect(reader).toHaveBeenCalledTimes(2)
    expect(plan2.spec.readDenied).toEqual([`${HOME}/.gnupg`])
    expect(plan2.spec.readDenied).not.toEqual(plan1.spec.readDenied)
    expect(plan2.spec.writeDeniedFinal[0]).toBe(`${HOME}/.gnupg`)
    expect(plan2.spec.writeDeniedFinal).not.toContain(`${HOME}/vault`)

    // 策略那两面同样按调用方的参数现问
    expect(m.pinSession('s8')).toBe(true)
    m.sessionView('s8', '/Volumes/w')
    expect(reader).toHaveBeenLastCalledWith('s8', '/Volumes/w')
    m.workspaceWriteView('s9', '/Volumes/x')
    expect(reader).toHaveBeenLastCalledWith('s9', '/Volumes/x')
    expect(warnLines()).toEqual([])
  })

  it('MG-11c 读取口抛错：这一次没有凭据清单、记一行原因；sessionView / workspaceWriteView 不往外抛', async () => {
    const m = await loadWith(() => {
      throw new Error('boom')
    })
    const plan = m.planFor(request())
    expect(plan).not.toBeNull()
    expect(plan!.spec.readDenied).toEqual([])
    expect(warnLines().some((l) => /credential paths unavailable: boom/.test(l))).toBe(true)

    expect(m.pinSession('s1')).toBe(true)
    expect(() => m.sessionView('s1', WS)).not.toThrow()
    expect(m.sessionView('s1', WS).sandboxActive).toBe(true)
    expect(() => m.workspaceWriteView('s1', WS)).not.toThrow()
    expect(m.workspaceWriteView('s1', WS).workspaceWritable).toEqual([WS])
  })

  it('MG-11d 读取口给的空串丢掉、重复的合成一个', async () => {
    const m = await loadWith(() => ['', `${HOME}/.ssh`, `${HOME}/.ssh`])
    const plan = m.planFor(request())!
    expect(plan.spec.readDenied).toEqual([`${HOME}/.ssh`])
  })

  it('MG-11e 读取口给的是真的符号链接：规格里是它指向的真实路径', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs')
    const os = await vi.importActual<typeof import('os')>('os')
    const base = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), 'sbx-mg11-'))
    scratch.push(base)
    const target = join(base, 'keys')
    fs.mkdirSync(target)
    const link = join(base, 'keys-link')
    fs.symlinkSync(target, link)

    const m = await loadWith(() => [link])
    const plan = m.planFor(request())!
    expect(plan.spec.readDenied).toEqual([target])
    expect(plan.spec.readDenied).not.toContain(link)
  })

  it('MG-11f 工作区本身就在读取口给的清单里：不套沙箱（记原因）；固定为启用的 sessionView 也是 INACTIVE_VIEW；workspaceWriteView 三个空数组', async () => {
    const m = await loadWith(() => [WS])
    expect(m.planFor(request())).toBeNull()
    const infos = mocks.log.info.mock.calls.map((c) => String(c[0])).join('\n')
    expect(infos).toContain('working directory is a credential directory')

    expect(m.pinSession('s1')).toBe(true)
    expect(m.sessionView('s1', WS)).toBe(m.INACTIVE_VIEW)
    expect(m.workspaceWriteView('s1', WS)).toEqual(EMPTY)
  })
})
