/**
 * 沙箱管理器（sandbox/index.ts）—— 对外唯一入口：开关、后端选择与探测缓存、按会话固定、
 * 执行计划、策略变量、会话清理。
 *
 * 替身：electron 的 app.getPath、os.homedir、平台后端（假后端，探测 / 包装 / 启动失败都可控）、
 * fs 里 ensureTmpDir / cleanupSession 用到的几个函数（realpathSync 用真的 —— MG-4 要真符号链接）、
 * logger。模块级缓存（后端、探测结果、固定表、realpath 缓存）每个用例 resetModules 后重新导入。
 */
import { createHash } from 'crypto'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const UID = process.getuid?.() ?? 0
const TMP_ROOT = `/private/tmp/shuvix-${UID}`
const HOME = '/Users/u'
const USER_DATA = '/Users/u/Library/Application Support/ShuviX'
const WS = '/Users/u/proj'

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

type Manager = typeof import('../index')
type PlanRequest = import('../index').PlanRequest

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
  grantedRead: [] as string[],
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
      sandboxProtectedPatterns: [],
      sandboxReadDenied: [],
      sandboxReadAllowed: []
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
  it('MG-4 env = TMPDIR/TMP/TEMP 指向本会话临时目录；wrap 交给后端；规格带上请求里的授权', async () => {
    const m = await load(() => 'true')
    const plan = m.planFor(
      request({ grantedWrite: ['/Volumes/data/out'], grantedRead: ['/Users/u/Documents/ref'] })
    )
    expect(plan).not.toBeNull()
    const tmpDir = `${TMP_ROOT}/${sha8('s1')}`
    expect(plan!.env).toEqual({ TMPDIR: `${tmpDir}/`, TMP: tmpDir, TEMP: tmpDir })
    expect(plan!.spec.tmpDir).toBe(tmpDir)
    expect(plan!.spec.writableRoots).toContain('/Volumes/data/out')
    expect(plan!.spec.readAllowBack).toContain('/Users/u/Documents/ref')

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
  it('MG-7 固定为启用 + 工作区合适 → active；读拒里有 realpath(~/.shuvix/cli-token)；不含授权（授权归 session-grants）', async () => {
    const m = await load(() => 'true')
    expect(m.pinSession('s1')).toBe(true)
    const view = m.sessionView('s1', WS)
    expect(view.sandboxActive).toBe(true)
    expect(view.sandboxReadDenied).toContain(`${HOME}/.shuvix/cli-token`)
    expect(view.sandboxWritableRoots[0]).toBe(WS)

    const plan = m.planFor(
      request({ grantedWrite: ['/Volumes/data/out'], grantedRead: ['/Users/u/Documents/ref'] })
    )!
    expect(plan.spec.writableRoots).toContain('/Volumes/data/out')
    expect(plan.spec.readAllowBack).toContain('/Users/u/Documents/ref')
    expect(view.sandboxWritableRoots).not.toContain('/Volumes/data/out')
    expect(view.sandboxReadAllowed).not.toContain('/Volumes/data/out')
    expect(view.sandboxReadAllowed).not.toContain('/Users/u/Documents/ref')
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
