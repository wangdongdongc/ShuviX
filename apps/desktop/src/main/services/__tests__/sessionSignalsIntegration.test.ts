/**
 * 会话信号接线的桌面整合（P3-08）—— 真 SessionHost + 真 SQLite + 真桌面 ToolHost + 真路由 / hookService
 * （夹具 `support/desktopRig`；事件汇是记录用的替身 `rig.broadcasts`，会话信号接线是真的，宿主建出来时装上）：
 *
 *   P3-08-47 经网关发一条：agent_created → agent_start → agent_end{ok}，各一次
 *   P3-08-49 派生 agent：register(a1) → agent_start(a1) → agent_end(a1) → sub_session_end(a1)，这一对严格
 *            嵌在根的那一对里
 *   P3-08-51 进程崩溃留下被中断的会话：被 peek 打开、再 continue → agent_start / agent_end{ok} 各一次
 *   P3-08-52 打开与发送在一次网关调用里、投影挂载慢 50ms（PIN-09）：照样恰一对
 *   P3-08-53 第一条消息触发起标题（hook agent）：只有用户那一轮的一对带 sessionId s1；titler 的一对（它是路由
 *            登记过的）带它自己的 agentId
 *
 * 夹具必须第一个 import（它登记 vi.mock）。
 */
import {
  DEFAULT_TITLE,
  bootProcess,
  crash,
  insert,
  liveTasksOf,
  rig,
  role,
  setupRig,
  sleep,
  teardownRig
} from './support/desktopRig'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DurableSession } from '@shuvix/agent-runtime'
import { answer, callTool, stalled, waitFor, withTimeout } from './support/realHost'

const T = 30000

beforeEach(async () => {
  await setupRig()
})

afterEach(async () => {
  await teardownRig()
})

type Event = Record<string, unknown>

const LIFE = new Set([
  'agent_created',
  'agent_start',
  'agent_end',
  'sub_session_register',
  'sub_session_end'
])

/** 生命周期相关的广播，压成 `type:sessionId[:reason]` */
function lifeOf(filter: (e: Event) => boolean = () => true): string[] {
  return rig.broadcasts
    .filter((e) => LIFE.has(e.type as string) && filter(e))
    .map((e) =>
      [e.type, e.sessionId, e.type === 'agent_end' ? e.reason : undefined]
        .filter((part) => part !== undefined)
        .join(':')
    )
}

const dispatch = (name: string, prompt: string, id = 'call-agent'): ReturnType<typeof callTool> =>
  callTool('agent', { name, prompt, description: 'look' }, id)

describe('P3-08 会话信号 · 桌面整合', () => {
  it(
    'P3-08-47 经网关发一条：agent_created → agent_start → agent_end{ok} 各一次',
    async () => {
      const p = await bootProcess()
      insert('s1')
      p.router.on('root', role('chat'), answer('hello'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'hi'), 15000, 'prompt')).toEqual({})
      await waitFor(() => lifeOf().includes('agent_end:s1:ok'), 5000, 'agent_end')
      await sleep(50)
      expect(lifeOf((e) => e.sessionId === 's1')).toEqual([
        'agent_created:s1',
        'agent_start:s1',
        'agent_end:s1:ok'
      ])
    },
    T
  )

  it(
    'P3-08-49 派生 agent：register → start(a1) → end(a1) → sub_session_end，嵌在根的一对里',
    async () => {
      const p = await bootProcess()
      insert('s1')
      p.router.on('explore', role('explore'), callTool('probe', {}, 'call-probe'), answer('found'))
      p.router.on('root', role('chat'), dispatch('explore', 'find'), answer('done'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
      await waitFor(() => lifeOf().includes('agent_end:s1:ok'), 5000, 'root end')
      await sleep(50)
      const register = rig.broadcasts.find((e) => e.type === 'sub_session_register')!
      const a1 = register.sessionId as string
      const all = lifeOf().filter((l) => !l.startsWith('agent_created'))
      expect(all).toEqual([
        'agent_start:s1',
        `sub_session_register:${a1}`,
        `agent_start:${a1}`,
        `agent_end:${a1}:ok`,
        `sub_session_end:${a1}`,
        'agent_end:s1:ok'
      ])
    },
    T
  )

  it(
    'P3-08-51 崩溃留下被中断的会话：peek 打开、再 continue → agent_start / agent_end{ok} 各一次',
    async () => {
      const p1 = await bootProcess()
      insert('s1')
      const stall = stalled()
      p1.router.on('root', role('chat'), stall.step)
      void p1.track(p1.chatGateway.prompt('s1', 'go'))
      await withTimeout(stall.reached, 10000, 'stalled')
      const p2 = await crash()
      rig.broadcasts.length = 0
      const peeked = (await p2.host.peek('s1')) as DurableSession
      expect(peeked.isInterrupted()).toBe(true)
      p2.router.on('root', role('chat'), answer('resumed'))
      const agent = p2.sessionService.getAgentSession('s1')!
      expect(await withTimeout(agent.continue(), 15000, 'continue')).toEqual({})
      await waitFor(() => lifeOf().includes('agent_end:s1:ok'), 5000, 'agent_end')
      await sleep(50)
      expect(lifeOf((e) => e.type === 'agent_start' || e.type === 'agent_end')).toEqual([
        'agent_start:s1',
        'agent_end:s1:ok'
      ])
    },
    T
  )

  it(
    'P3-08-52 打开 + 发送在一次网关调用里、投影挂载慢 50ms（PIN-09）：恰一对',
    async () => {
      const ref: { wiring?: typeof import('../../frontend/sync/syncWiring') } = {}
      const p = await bootProcess({
        deps: {
          onSessionOpened: (session) => {
            // 投影（显示侧车解析）慢 50ms：接线等的就是它
            const original = session.projector.bind(session)
            ;(session as { projector: typeof session.projector }).projector = () =>
              sleep(50).then(original)
            ref.wiring!.sessionHostHooks.opened(session)
          },
          onSessionClosed: (id, reason) => ref.wiring!.sessionHostHooks.closed(id, reason)
        }
      })
      ref.wiring = await import('../../frontend/sync/syncWiring')
      insert('s1')
      p.router.on('root', role('chat'), answer('quick'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'hi'), 15000, 'prompt')).toEqual({})
      await waitFor(() => lifeOf().includes('agent_end:s1:ok'), 5000, 'agent_end')
      await sleep(50)
      expect(lifeOf((e) => e.type === 'agent_start' || e.type === 'agent_end')).toEqual([
        'agent_start:s1',
        'agent_end:s1:ok'
      ])
    },
    T
  )

  it(
    'P3-08-53 起标题的 hook agent：只有用户那一轮的一对带 s1；titler 的一对带它的 agentId',
    async () => {
      const p = await bootProcess()
      insert('s1', { title: DEFAULT_TITLE })
      p.router.on('root', role('chat'), answer('a'))
      p.router.on(
        'titler',
        role('titler'),
        callTool('session', { action: 'set-title', title: 'Hooked title' }, 'call-title'),
        answer('Hooked title')
      )
      expect(await withTimeout(p.chatGateway.prompt('s1', 'hello'), 15000, 'prompt')).toEqual({})
      await waitFor(async () => (await liveTasksOf('s1')).length === 0, 10000, 'titler finished')
      await waitFor(
        () => rig.broadcasts.filter((e) => e.type === 'agent_end').length >= 2,
        5000,
        'both pairs'
      )
      await sleep(50)
      const root = lifeOf(
        (e) => e.sessionId === 's1' && (e.type === 'agent_start' || e.type === 'agent_end')
      )
      expect(root).toEqual(['agent_start:s1', 'agent_end:s1:ok'])
      const titler = rig.broadcasts.find((e) => e.type === 'sub_session_register')!
      expect(
        lifeOf(
          (e) =>
            e.sessionId === titler.sessionId && (e.type === 'agent_start' || e.type === 'agent_end')
        )
      ).toEqual([`agent_start:${titler.sessionId}`, `agent_end:${titler.sessionId}:ok`])
    },
    T
  )
})
