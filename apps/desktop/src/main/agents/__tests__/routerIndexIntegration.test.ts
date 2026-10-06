/**
 * 派生 agent 路由的索引重建 · 桌面整合（P3-14-10 的真模块图部分）：真 SessionHost + 真 SQLite + 真路由
 * （夹具 `services/__tests__/support/desktopRig`）。
 *
 *   P3-14-10 懒（PIN-16，按基线修正）：import 会话宿主 / 同步接线不建宿主、不建 hub；它们经静态 import 链
 *            本来就会求值路由模块（恰建一次），建路由不建宿主、不重建任何东西
 *   P3-14-10 路由已经建好：每次真正的打开（peek / open）恰重建一次；LRU / 显式关闭之后再开又一次
 *   P3-14-05（桌面）重启之后：根会话被 peek 打开即认得进程 1 的派生 agent；面板追问经它跑通，没有新的
 *            register、任务条目按记录建（C2：重启之后不凭空长出面板行，只有追问才建）
 *
 * 夹具必须第一个 import（它登记 vi.mock）。
 */
import {
  bootProcess,
  crash,
  insert,
  rig,
  role,
  setupRig,
  sleep,
  teardownRig
} from '../../services/__tests__/support/desktopRig'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DurableSession } from '@shuvix/agent-runtime'
import { answer, callTool, waitFor, withTimeout } from '../../services/__tests__/support/realHost'

const counter = vi.hoisted(() => ({ created: 0 }))

// 只数路由建了几次（其余照旧是真的）
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    createSubAgentManager: (deps: Parameters<typeof actual.createSubAgentManager>[0]) => {
      counter.created += 1
      return actual.createSubAgentManager(deps)
    }
  }
})

const T = 30000

beforeEach(async () => {
  await setupRig()
})

afterEach(async () => {
  await teardownRig()
})

const dispatch = (name: string, prompt: string, id = 'call-agent'): ReturnType<typeof callTool> =>
  callTool('agent', { name, prompt, description: 'look' }, id)

/** 进程 1：s1 派发一个 explore，答完；交回它的 agentId */
async function spawnOne(): Promise<string> {
  const p = await bootProcess()
  insert('s1')
  p.router.on('explore', role('explore'), answer('found'))
  p.router.on('root', role('chat'), dispatch('explore', 'find'), answer('done'))
  expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
  const register = rig.broadcasts.find((e) => e.type === 'sub_session_register')!
  return register.sessionId as string
}

describe('P3-14-10 router laziness and the open hook (real module graph)', () => {
  it(
    'P3-14-10 (amended) importing the session host and the sync wiring builds no host and no hub; the router those imports already pull in builds no host and indexes nothing',
    async () => {
      vi.resetModules()
      counter.created = 0
      const sessionHost = await import('../../services/sessionHost')
      const syncWiring = await import('../../frontend/sync/syncWiring')
      // 设计稿写的是「import 它们不建路由」—— 与基线不符：sessionHost → sessionService → agentSession →
      // hookService → AgentManager 是一条静态 import 链，import 宿主模块本来就会求值路由模块（P3-14 之前就如此）。
      // 能守住的是 PIN-16 / P3-05 PIN-12 的本意：建路由不建宿主、不建 hub，也不重建任何东西
      expect(counter.created).toBe(1)
      expect(sessionHost.peekSessionHost()).toBeUndefined()
      expect(syncWiring.peekSyncHub()).toBeUndefined()
      const { agentManager } = await import('../AgentManager')
      expect(counter.created).toBe(1)
      expect(agentManager.has('sub-anything')).toBe(false)
      expect(sessionHost.peekSessionHost()).toBeUndefined()
    },
    T
  )

  it(
    'P3-14-10 with the router built, each real open (peek or open) rebuilds exactly once',
    async () => {
      await spawnOne()
      const p = await crash()
      const index = vi.spyOn(p.agentManager, 'indexSession')
      const peeked = (await p.host.peek('s1')) as DurableSession
      expect(index.mock.calls).toEqual([[peeked]])
      // 已经开着：peek 不是一次真正的打开
      await p.host.peek('s1')
      expect(index).toHaveBeenCalledTimes(1)
      await p.host.close('s1')
      const reopened = await p.host.open('s1')
      expect(index).toHaveBeenCalledTimes(2)
      expect(index.mock.calls[1]![0]).toBe(reopened)
    },
    T
  )
})

describe('P3-14-05 a follow-up after a restart (desktop)', () => {
  it(
    'P3-14-05 the root opened by peek → the agent is routable; the follow-up runs; no new register; the task is created from the record',
    async () => {
      const a1 = await spawnOne()
      const p = await crash()
      rig.broadcasts.length = 0
      expect(p.agentManager.has(a1)).toBe(false)
      expect(p.taskRegistry.get(a1)).toBeUndefined()
      await p.host.peek('s1')
      expect(p.agentManager.locate(a1)?.sessionId).toBe('s1')
      // C2：重建不登记任务、不广播
      expect(p.taskRegistry.get(a1)).toBeUndefined()
      expect(rig.broadcasts.filter((e) => e.type === 'sub_session_register')).toEqual([])

      p.router.on('explore', role('explore'), answer('again'))
      await withTimeout(
        p.agentManager.continueTask({ subSessionId: a1, text: 'more' }),
        15000,
        'continue'
      )
      await waitFor(
        () => rig.broadcasts.some((e) => e.type === 'sub_session_end' && e.sessionId === a1),
        5000,
        'sub_session_end'
      )
      await sleep(20)
      const end = rig.broadcasts.find((e) => e.type === 'sub_session_end' && e.sessionId === a1)!
      expect(end).toMatchObject({ parentSessionId: 's1', result: 'again', isError: false })
      expect(rig.broadcasts.filter((e) => e.type === 'sub_session_register')).toEqual([])
      expect(p.taskRegistry.get(a1)).toMatchObject({
        kind: 'agent',
        sessionId: 's1',
        status: 'done',
        subject: { kind: 'agent', profileName: 'explore', depth: 1 }
      })
    },
    T
  )
})
