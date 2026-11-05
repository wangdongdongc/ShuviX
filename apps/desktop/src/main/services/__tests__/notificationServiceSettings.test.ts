/**
 * notificationService —— 通知开关的宿主一侧：每类一个设置键，判定时现读，只有字面 'false' 才算关。
 *
 * 前三条的决策器是替身（从 `createNotificationCenter` 的入参里取出 `enabled`）；后两条接真的决策器，electron 的
 * Notification 是记账的假类，看到的是「构造了没有、弹了没有、撤回时关的是不是那一个」。
 * 每条用例一个新模块（resetModules + 动态 import）；`settingsDao.findByKey` 读一张可变的表。
 *
 *   NK-S1 字面 'false' 才算关：缺省、'true'、空串、大小写或空白不同的写法都算开；只读这一类的键
 *   NK-S2 每次现读：不重新初始化，改设置立即生效，删掉回到缺省开
 *   NK-S3 旧的总开关 `notification.enabled` 没人读：写着 'false' 也不关；写着 'true' 也救不回关掉的一类
 *   NK-S4 真决策器：关掉 done → 完成不构造原生通知，询问与失败各构造一个并弹出
 *   NK-S5 真决策器：弹出之后把开关关掉 → 落定与打开会话照样关掉对应的原生通知（关的是那一个，各一次）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentNotificationKind } from '@shuvix/chat-protocol/notification'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { createNotificationCenter as realCreateNotificationCenter } from '../../../../../../packages/agent-runtime/src/notification/notificationCenter'

const mocks = vi.hoisted(() => {
  interface Instance {
    body: unknown
    show: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  const instances: Instance[] = []
  class FakeNotification {
    static isSupported(): boolean {
      return true
    }
    readonly on = vi.fn()
    readonly show = vi.fn()
    readonly close = vi.fn()
    constructor(options: Record<string, unknown>) {
      instances.push({ body: options.body, show: this.show, close: this.close })
    }
  }
  const settings = new Map<string, string>()
  return {
    FakeNotification,
    instances,
    settings,
    findByKey: vi.fn((key: string) => settings.get(key)),
    createNotificationCenter: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
})

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: mocks.FakeNotification
}))
vi.mock('@shuvix/agent-runtime', () => ({
  createNotificationCenter: mocks.createNotificationCenter
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: vi.fn(() => ({})), findById: vi.fn() }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../pinnedChatService', () => ({ focusFloating: vi.fn(), isPinned: vi.fn(() => false) }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({ createLogger: () => mocks.log }))

type Service = typeof import('../notificationService')
type Enabled = (kind: AgentNotificationKind) => boolean

async function loadService(): Promise<Service> {
  vi.resetModules()
  const service = await import('../notificationService')
  service.initNotificationService({ getMainWindow: () => null, ensureMainWindow: () => {} })
  return service
}

beforeEach(() => {
  mocks.settings.clear()
  mocks.instances.length = 0
  mocks.findByKey.mockClear()
  mocks.createNotificationCenter.mockReset()
})

describe('开关怎么读（决策器是替身）', () => {
  let enabled: Enabled

  beforeEach(async () => {
    mocks.createNotificationCenter.mockImplementation((deps: { enabled: Enabled }) => {
      enabled = deps.enabled
      return {}
    })
    await loadService()
  })

  it.each([
    [undefined, true],
    ['true', true],
    ['', true],
    ['FALSE', true],
    ['0', true],
    ['false ', true],
    ['false', false]
  ])('NK-S1 notification.done = %j → 开着 = %s；另外两类不受影响，只读这一类的键', (value, on) => {
    if (value !== undefined) mocks.settings.set('notification.done', value)

    expect(enabled('done')).toBe(on)
    expect(mocks.findByKey.mock.calls).toEqual([['notification.done']])

    mocks.findByKey.mockClear()
    expect(enabled('ask')).toBe(true)
    expect(mocks.findByKey.mock.calls).toEqual([['notification.ask']])

    mocks.findByKey.mockClear()
    expect(enabled('failed')).toBe(true)
    expect(mocks.findByKey.mock.calls).toEqual([['notification.failed']])
  })

  it('NK-S2 不重新初始化：改了立即生效，删掉回到缺省开', () => {
    expect(enabled('ask')).toBe(true)
    mocks.settings.set('notification.ask', 'false')
    expect(enabled('ask')).toBe(false)
    mocks.settings.delete('notification.ask')
    expect(enabled('ask')).toBe(true)
  })

  const allKinds = (): boolean[] => [enabled('ask'), enabled('done'), enabled('failed')]

  it("NK-S3a 只留着旧键 notification.enabled = 'false'：三类都开着", () => {
    mocks.settings.set('notification.enabled', 'false')
    expect(allKinds()).toEqual([true, true, true])
    expect(mocks.findByKey).not.toHaveBeenCalledWith('notification.enabled')
  })

  it("NK-S3b 旧键 'true' 救不回关掉的一类", () => {
    mocks.settings.set('notification.enabled', 'true')
    mocks.settings.set('notification.ask', 'false')
    expect(allKinds()).toEqual([false, true, true])
    expect(mocks.findByKey).not.toHaveBeenCalledWith('notification.enabled')
  })
})

describe('接真的决策器', () => {
  const ASK: InputRequest = { id: 'r', kind: 'ask', toolName: 'bash', createdAt: 0, command: 'ls' }
  const end = (sessionId: string, reason: 'ok' | 'error'): ChatEvent => ({
    type: 'agent_end',
    sessionId,
    reason
  })
  const native = (body: string): (typeof mocks.instances)[number] => {
    const found = mocks.instances.filter((n) => n.body === body)
    expect(found, body).toHaveLength(1)
    return found[0]
  }

  let service: Service

  beforeEach(async () => {
    mocks.createNotificationCenter.mockImplementation(realCreateNotificationCenter)
    service = await loadService()
  })

  it('NK-S4 关掉 done：完成不构造原生通知，询问与失败各构造一个并弹出', () => {
    mocks.settings.set('notification.done', 'false')

    service.notifyOnChatEvent(end('s1', 'ok'))
    expect(mocks.instances).toEqual([])

    service.notifyAskRaised('s1', ASK)
    service.notifyOnChatEvent(end('s2', 'error'))

    expect(mocks.instances.map((n) => n.body)).toEqual([
      'notification.askBody',
      'notification.failedBody'
    ])
    for (const instance of mocks.instances) expect(instance.show).toHaveBeenCalledTimes(1)
  })

  it('NK-S5 弹出之后把开关关掉：落定与打开会话照样关掉对应的那一个', () => {
    service.notifyAskRaised('s1', ASK)
    service.notifyOnChatEvent(end('s2', 'ok'))
    const ask = native('notification.askBody')
    const done = native('notification.doneBody')

    mocks.settings.set('notification.ask', 'false')
    mocks.settings.set('notification.done', 'false')

    service.notifyAskResolved('s1', ASK.id)
    expect(ask.close).toHaveBeenCalledTimes(1)
    expect(done.close).not.toHaveBeenCalled()

    service.reportActiveSession(null, 's2')
    expect(done.close).toHaveBeenCalledTimes(1)
    expect(ask.close).toHaveBeenCalledTimes(1)
    expect(mocks.instances).toHaveLength(2)
  })
})
