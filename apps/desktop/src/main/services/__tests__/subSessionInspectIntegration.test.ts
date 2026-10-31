/**
 * 查看现场（`inspect-session`，docs/sub-session-design.md §19.7）与 `userIntervened`（§19.10 第 18 条）的整合用例：
 * 真 SessionHost + 真 SQLite + 真桌面 ToolHost + 真 SessionTool / 运行器 / 网关（`support/desktopRig.ts`）。
 * 单元层（subSessionInspect / sessionInspect / sessionOutline）用的是假视图与假来源；这里钉的是它们接到真东西上之后：
 *   - 大纲的消息级编号就是子会话 SessionView 里的消息 id（= 界面的 data-msg-id）；
 *   - 父会话发进去的消息（prompt 与 steer）经真 SourceDoc 解析成 `[you]`，用户自己打的是 `[user]`；
 *   - 同一张卡里两次已完成的调用折成一行；没开着的子会话 peek 读、不建运行时、不写条目；
 *   - 输入来源（metadata.origin，2026-10-21）不跟着操作上下文漏进被驱动的发送（WP4-144）：父会话那一轮在网络客户端的
 *     上下文里跑，它发进子会话的仍记 parent-session；人在子会话里打的按自己的连接记 local。
 * P = 父会话，C = 子会话。用例编号 WP4-14x 对应测试设计清单。
 */
import {
  bootProcess,
  insert,
  proc,
  role,
  setupRig,
  shutdown,
  teardownRig,
  transcriptOf,
  unhandled,
  type Proc
} from './support/desktopRig'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { withoutMidRunNote } from '@shuvix/chat-protocol/midRunNote'
import type { ClientContext } from '../../ipc/registry'
import { answer, callTool, held, withTimeout } from './support/realHost'
import { callTools } from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'

const T = 40000

beforeEach(async () => {
  await setupRig()
  await bootProcess()
})

afterEach(async () => {
  // 没有吞掉的异常（父会话被完成通知叫醒的那一轮也要正常收尾）
  expect(unhandled).toEqual([])
  await teardownRig()
})

const promptChild = (child: string, message: string, id: string): ReturnType<typeof callTool> =>
  callTool('session', { action: 'prompt-session', session_id: child, message }, id)

/** 子会话此刻的界面视图（开着的读门面，没开的 peek） */
async function viewOf(p: Proc, sessionId: string): Promise<{ messages: ChatMessage[] }> {
  const agent =
    p.sessionService.getAgentSession(sessionId) ??
    (await p.sessionService.peekAgentSession(sessionId))
  if (!agent) throw new Error(`no storage for ${sessionId}`)
  return agent.sessionView()
}

type Outline = { kind: string; lines: string[] }

async function inspectLines(p: Proc, query: Record<string, unknown> = {}): Promise<Outline> {
  const res = await p.runner.inspect({ parentId: 'P', childId: 'C', query })
  if ('error' in res) throw new Error(res.error)
  return res.result as Outline
}

/** 一行的编号 */
const refOf = (line: string): string => line.slice(0, line.indexOf(' '))

/** P 前台把 'C-task' 交给 C：C 一张卡里两次 probe，然后答 'C-done'；P 随后 inspect、答 'P-final' */
async function parentDrivesChild(p: Proc): Promise<void> {
  insert('P')
  insert('C', { parentId: 'P' })
  p.router.on(
    'P',
    role('chat', 'start'),
    promptChild('C', 'C-task', 'call-prompt'),
    callTool('session', { action: 'inspect-session', session_id: 'C' }, 'call-inspect'),
    answer('P-final')
  )
  p.router.on(
    'C',
    role('chat', 'C-task'),
    callTools([
      ['probe', {}, 'p1'],
      ['probe', {}, 'p2']
    ]),
    answer('C-done')
  )
  expect(await withTimeout(p.chatGateway.prompt('P', 'start'), 20000, 'P prompt')).toEqual({})
}

describe('inspect-sub-session —— 接到真子会话上', () => {
  it(
    'WP4-140 大纲的消息级编号 = 子会话 SessionView 的消息 id；父会话发的是 [you]；同一张卡的两次 probe 折成一行；末行 reply:',
    async () => {
      const p = proc()
      await parentDrivesChild(p)

      const view = await viewOf(p, 'C')
      const outline = await inspectLines(p)
      expect(outline.kind).toBe('outline')
      const lines = outline.lines
      expect(lines[0]).toMatch(/^#\S+ \[you\] C-task$/)
      expect(lines.some((l) => /^#\S+\.0-1 probe ×2$/.test(l))).toBe(true)
      expect(lines.at(-1)).toMatch(/^#\S+\.0 reply: C-done$/)

      // 每条消息的编号都取自它的 id（durable：条目 id 原样）
      const messageRefs = lines.map((l) => refOf(l).replace(/\.\d+(-\d+)?$/, ''))
      const viewRefs = view.messages.map((m) => `#${m.id}`)
      expect([...new Set(messageRefs)]).toEqual(viewRefs)
      expect(view.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])

      // 父会话经真工具拿到的那一份：同样的行，在围栏里
      const results = (await transcriptOf('P')).filter(
        (e) => e.startsWith('pi.tool-result:') && e.includes('<transcript')
      )
      expect(results).toHaveLength(1)
      for (const line of lines) expect(results[0]).toContain(`\n${line}\n`)
      expect(results[0]).not.toContain('user-intervened')
    },
    T
  )

  it(
    'WP4-141 用户在子会话里打字之后：read 带 user-intervened、大纲里那条是 [user]；父会话再 steer 一条 → [you]，之后的 read 不再带',
    async () => {
      const p = proc()
      await parentDrivesChild(p)

      // 用户经 IPC 那条路往子会话发一条（没有来源）
      p.router.push('C', answer('C-human-done'))
      expect(
        await withTimeout(p.chatGateway.prompt('C', 'human words'), 15000, 'C prompt')
      ).toEqual({})
      const read1 = await p.runner.read('P', 'C')
      if ('error' in read1) throw new Error(read1.error)
      expect(read1.info.userIntervened).toBe(true)
      expect(read1.answer).toBe('C-human-done')
      const afterHuman = (await inspectLines(p, { turns: 5 })).lines
      expect(afterHuman.some((l) => l.endsWith(' [user] human words'))).toBe(true)

      // 父会话再派一轮，C 停在 LLM 请求上时父会话 steer 一条
      const gate = held(callTool('probe', {}, 'p3'))
      p.router.push('C', gate.step, answer('C-final'))
      const started = await p.runner.prompt({
        parentId: 'P',
        childId: 'C',
        message: 'second task',
        requestId: 'subsession:P:9001'
      })
      expect(started).toEqual({ kind: 'started', id: 'C' })
      await withTimeout(gate.reached, 10000, 'C request')
      const steered = await p.runner.steer({
        parentId: 'P',
        childId: 'C',
        message: 'parent steer',
        requestId: 'subsession-steer:P:9002'
      })
      expect(steered).toEqual({ id: 'C', title: 'C' })
      // 跑完会给 P 发一条完成通知、叫醒它 —— 给 P 备一句应答
      p.router.push('P', answer('P-ack'))
      gate.release()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const last = (await transcriptOf('C')).at(-1)
        if (last === 'pi.assistant:C-final') break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect((await transcriptOf('C')).at(-1)).toBe('pi.assistant:C-final')

      const lines = (await inspectLines(p, { turns: 5 })).lines
      expect(lines.some((l) => l.endsWith(' [you] second task'))).toBe(true)
      expect(lines.some((l) => l.endsWith(' [you] parent steer'))).toBe(true)
      expect(lines.some((l) => l.endsWith(' [user] human words'))).toBe(true)
      const read2 = await p.runner.read('P', 'C')
      if ('error' in read2) throw new Error(read2.error)
      expect(read2.info).not.toHaveProperty('userIntervened')
    },
    T
  )

  it(
    'WP4-144 来源不漏进被驱动的发送：P 的 start 在网络客户端的上下文里跑，C-task 仍是 parent-session P；人在窗口里打的是 local；[user] / [you] 与 userIntervened 照旧',
    async () => {
      const p = proc()
      // 网关读的那份 AsyncLocalStorage（bootProcess 换过模块图，测试文件静态 import 的不是它）
      const { operationContext, createClientContext } = p.operationContext
      const netCtx: ClientContext = {
        client: { kind: 'network', id: 'ws:4', remoteAddress: '192.168.1.20', userAgent: 'UA' },
        transport: 'network'
      }
      const winCtx: ClientContext = {
        client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
        transport: 'ipc'
      }
      const REMOTE = { kind: 'remote', clientId: 'ws:4', address: '192.168.1.20', userAgent: 'UA' }
      const FROM_P = { kind: 'parent-session', sessionId: 'P' }
      const originOf = async (sessionId: string, content: string): Promise<unknown> => {
        // 按用户自己的话认：运行中插进来的那条后面还挂着插话说明那枚 Token（docs/task-list-design.md §2）
        const found = (await viewOf(p, sessionId)).messages.filter(
          (m) =>
            m.role === 'user' && withoutMidRunNote(m.content, m.metadata?.inlineTokens) === content
        )
        expect(found, `${sessionId}: ${content}`).toHaveLength(1)
        return (found[0]!.metadata as { origin?: unknown } | null)?.origin
      }

      // P 的那一轮（连同它经 session 工具发进 C 的 C-task）在网络客户端的上下文里
      await operationContext.run(createClientContext(netCtx, 'P'), () => parentDrivesChild(p))
      expect(await originOf('P', 'start')).toStrictEqual(REMOTE)
      expect(await originOf('C', 'C-task')).toStrictEqual(FROM_P)

      // 人在窗口里往 C 里打一条
      p.router.push('C', answer('C-human-done'))
      expect(
        await operationContext.run(createClientContext(winCtx, 'C'), () =>
          withTimeout(p.chatGateway.prompt('C', 'human words'), 15000, 'C prompt')
        )
      ).toEqual({})
      expect(await originOf('C', 'human words')).toStrictEqual({ kind: 'local' })
      const read1 = await p.runner.read('P', 'C')
      if ('error' in read1) throw new Error(read1.error)
      expect(read1.info.userIntervened).toBe(true)
      const afterHuman = (await inspectLines(p, { turns: 5 })).lines
      expect(afterHuman.some((l) => l.endsWith(' [user] human words'))).toBe(true)
      expect(afterHuman.some((l) => l.endsWith(' [you] C-task'))).toBe(true)

      // 父会话再派一轮、再 steer 一条 —— 两样都在网络客户端的上下文里发起，照样记 parent-session
      const gate = held(callTool('probe', {}, 'p3'))
      p.router.push('C', gate.step, answer('C-final'))
      const started = await operationContext.run(createClientContext(netCtx, 'P'), () =>
        p.runner.prompt({
          parentId: 'P',
          childId: 'C',
          message: 'second task',
          requestId: 'subsession:P:9101'
        })
      )
      expect(started).toEqual({ kind: 'started', id: 'C' })
      await withTimeout(gate.reached, 10000, 'C request')
      const steered = await operationContext.run(createClientContext(netCtx, 'P'), () =>
        p.runner.steer({
          parentId: 'P',
          childId: 'C',
          message: 'parent steer',
          requestId: 'subsession-steer:P:9102'
        })
      )
      expect(steered).toEqual({ id: 'C', title: 'C' })
      p.router.push('P', answer('P-ack'))
      gate.release()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const last = (await transcriptOf('C')).at(-1)
        if (last === 'pi.assistant:C-final') break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect((await transcriptOf('C')).at(-1)).toBe('pi.assistant:C-final')

      expect(await originOf('C', 'second task')).toStrictEqual(FROM_P)
      expect(await originOf('C', 'parent steer')).toStrictEqual(FROM_P)
      expect(await originOf('C', 'C-task')).toStrictEqual(FROM_P)
      expect(await originOf('C', 'human words')).toStrictEqual({ kind: 'local' })
      const lines = (await inspectLines(p, { turns: 5 })).lines
      expect(lines.some((l) => l.endsWith(' [you] second task'))).toBe(true)
      expect(lines.some((l) => l.endsWith(' [you] parent steer'))).toBe(true)
      expect(lines.some((l) => l.endsWith(' [user] human words'))).toBe(true)
      const read2 = await p.runner.read('P', 'C')
      if ('error' in read2) throw new Error(read2.error)
      expect(read2.info).not.toHaveProperty('userIntervened')
    },
    T
  )

  it(
    'WP4-142 没开着的子会话：peek 读、不建 agent 运行时（没有锁、没有请求）、子会话不多任何条目',
    async () => {
      await parentDrivesChild(proc())
      const before = await transcriptOf('C')
      // 新的进程：两条会话都没开着
      await shutdown()
      const p2 = await bootProcess()
      expect(p2.host.get('C')).toBeUndefined()
      expect(p2.sessionService.getAgentSession('C')).toBeUndefined()

      const outline = await inspectLines(p2)
      expect(outline.lines[0]).toMatch(/^#\S+ \[you\] C-task$/)
      // peek 打开的是存储（之后读得到门面），不是 agent 运行时：没有锁、没有请求、没有新条目
      expect(p2.host.get('C')?.lock).toBeUndefined()
      expect(p2.sessionService.hasAgentRuntime('C')).toBe(false)
      expect(p2.kit.callCount).toBe(0)
      expect(await transcriptOf('C')).toEqual(before)
    },
    T
  )
})
