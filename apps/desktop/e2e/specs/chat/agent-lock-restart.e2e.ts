/**
 * 锁跟着本进程的初始化走（option A，用户 2026-10-07）—— 「这条会话有 agent」= 「agent 在本进程里初始化过」。
 * 重启（`stop({ keepHome: true })` + `launchApp({ home })`）之后：
 *
 *   LR-E1 空闲、上个进程里有过 agent 的会话：重开之后打开它 —— 横幅上没有 agent 芯片、监视列表不列它、
 *         `agent.init` 报 `created:false`、库里的锁镜像归 false；发一条消息才按此刻的设置建出 agent（芯片、
 *         根行、`created:true` 都回来）
 *   LR-E2 被中断的会话（chat-interrupted 的做法：挂住一轮再停机）：重开之后打开它 —— 被中断的横幅与 agent 芯片
 *         都在、监视列表里根行是 interrupted、`agent.init` 报 `created:true`；[继续] 跑完，芯片还在
 *
 * 假提供商活在 vitest 进程里，跨两次启动不变。观测面先走 IPC（`agent.init` / `agent.monitorList` /
 * `session.list`），DOM 只经 pages.ts 看芯片与横幅。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import {
  chatPane,
  sidebarPane,
  statusBannerPane,
  type ChatPane,
  type SidebarPane,
  type StatusBannerPane
} from '../../harness/pages'
import { syncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const IDLE = 'LR-idle'
const INTERRUPTED = 'LR-interrupted'
const OTHER = 'LR-other'

interface MonitorEntry {
  agentId: string
  kind: string
  rootSessionId: string
  phase: string
}

let first: E2EApp | undefined
let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let banner: StatusBannerPane
const sids: Record<'idle' | 'interrupted', string> = { idle: '', interrupted: '' }

const monitorList = (): Promise<MonitorEntry[]> =>
  app.main.eval<MonitorEntry[]>('window.api.agent.monitorList()')

const rootRow = async (sid: string): Promise<MonitorEntry | undefined> =>
  (await monitorList()).find((e) => e.kind === 'root' && e.agentId === sid)

const created = async (sid: string): Promise<boolean> =>
  (
    await app.main.eval<{ created: boolean }>(
      `window.api.agent.init(${JSON.stringify({ sessionId: sid })})`
    )
  ).created

const mirroredLock = async (sid: string): Promise<unknown> =>
  (
    await app.main.eval<Array<{ id: string; settings: { agentLocked?: boolean } }>>(
      'window.api.session.list()'
    )
  ).find((s) => s.id === sid)?.settings.agentLocked

beforeAll(async () => {
  provider = await startFakeProvider()
  first = await launchApp()
  const home = first.home
  await seedFakeProvider(first.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(first.main)
  const create = (title: string): Promise<string> =>
    first!.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
    )
  sids.idle = await create(IDLE)
  sids.interrupted = await create(INTERRUPTED)
  await create(OTHER)

  provider.reset()
  // 空闲的那条：跑完一轮（agent 建出来、锁上）
  provider.script({ text: 'idle answer' })
  await first.main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sids.idle, text: 'first' })}).then(() => true)`
  )
  await until(
    async () =>
      (await first!.main.eval<MonitorEntry[]>('window.api.agent.monitorList()')).some(
        (e) => e.kind === 'root' && e.agentId === sids.idle && e.phase === 'idle'
      ) || null,
    'idle session locked in process 1'
  )
  // 被中断的那条：挂住一轮（不 await —— prompt 要等整轮落定才回）
  const before = provider.chatRequestCount()
  provider.script({ text: 'stale', holdMs: 60_000 })
  await first.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sids.interrupted, text: 'first' })}), true)`
  )
  await until(
    () => provider.chatRequestCount() > before && provider.holding(),
    'interrupted turn holding'
  )
  await sleep(600)
  // 活动会话换成没锁的第三条：重开时渲染端恢复的不是要测的那两条
  const sidebar1 = sidebarPane(first.main)
  await until(async () => (await sidebar1.openSession(OTHER)) || null, 'other session opened')

  await first.stop({ keepHome: true })
  first = undefined
  app = await launchApp({ home })
  await waitRendererReady(app.main)
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  banner = statusBannerPane(app.main)
  await until(async () => {
    const titles = await sidebar.titles()
    return titles.includes(IDLE) && titles.includes(INTERRUPTED)
  }, 'sidebar rows after relaunch')
}, 120_000)

afterAll(async () => {
  await first?.stop()
  await app?.stop()
  await provider?.close()
})

describe('LR-E1 an idle session that had an agent', () => {
  it('after the relaunch: no chip, nothing in Monitor, agent.init says created:false and the mirror is cleared; a send creates the agent again', async () => {
    // 还没打开任何一条：监视列表什么都没有
    await sleep(1200)
    expect(await monitorList()).toEqual([])

    expect(await sidebar.openSession(IDLE)).toBe(true)
    await chat.ready()
    await until(async () => (await mirroredLock(sids.idle)) === false || null, 'mirror cleared')
    expect(await created(sids.idle)).toBe(false)
    // 让监视轮询与横幅都有机会走几拍
    await sleep(1500)
    expect(await banner.chip()).toBeNull()
    expect((await monitorList()).filter((e) => e.rootSessionId === sids.idle)).toEqual([])

    provider.reset()
    provider.script({ text: 'after restart' })
    await chat.typeAndSend('hello again')
    await syncProbe(app.main).waitView(
      sids.idle,
      (v) => v.run.state === 'idle' && v.messages.some((m) => m.content === 'after restart'),
      30_000,
      'idle session answered after the relaunch'
    )
    expect(provider.chatRequests()).toHaveLength(1)
    const root = await until(async () => (await rootRow(sids.idle)) ?? null, 'root row back')
    expect(root.kind).toBe('root')
    await until(async () => (await banner.chip()) ?? null, 'chip back after the send')
    expect(await created(sids.idle)).toBe(true)
    expect(await mirroredLock(sids.idle)).toBe(true)
  })
})

describe('LR-E2 an interrupted session', () => {
  it('after the relaunch: the interrupted banner and the chip are both there, Monitor lists it interrupted, agent.init says created:true; Continue finishes with the chip still there', async () => {
    expect(await sidebar.openSession(INTERRUPTED)).toBe(true)
    await chat.ready()
    await until(async () => (await chat.interruptedBanner()) !== null || null, 'interrupted banner')
    const root = await until(
      async () => (await rootRow(sids.interrupted)) ?? null,
      'root row of the interrupted session'
    )
    expect(root.phase).toBe('interrupted')
    await until(async () => (await banner.chip()) ?? null, 'chip of the interrupted session')
    expect(await created(sids.interrupted)).toBe(true)
    expect(await mirroredLock(sids.interrupted)).toBe(true)

    provider.reset()
    provider.script({ text: 'resumed answer' })
    expect(await chat.clickContinue()).toBe(true)
    await syncProbe(app.main).waitView(
      sids.interrupted,
      (v) => v.run.state === 'idle' && v.messages.some((m) => m.content === 'resumed answer'),
      30_000,
      'interrupted session resumed'
    )
    expect(provider.chatRequests()).toHaveLength(1)
    await until(async () => (await chat.interruptedBanner()) === null || null, 'banner gone')
    expect(await banner.chip()).not.toBeNull()
    expect((await rootRow(sids.interrupted))?.phase).toBe('idle')
  })
})
