/**
 * 无人值守的运行（docs/unattended-run-design.md §2 / §3）在 `DurableSession` 上的那一半：这一轮有没有人在
 * （内存里的标记，带来源的输入**被受理之后**更新，缺省有人值守），以及拦点 `requestUserInput` ——
 * 没人在时不进挂起表，当场以 `{ kind: 'cancel', reason: 'unattended' }` 落定。
 *
 * 状态表（§2）
 *   DU-1   新会话：有人值守，没有事件
 *   DU-2   触发器开的一轮：受理起就是无人值守（这一轮里的工具看得到），事件恰一条 true
 *   DU-3   人发的（本机 / 远程 / Chrome / Telegram / 采纳的提议）把无人值守的会话转回，每次真的变了才有事件
 *   DU-4   别的会话发来、盖着 unattended:true（父会话 / 别的会话；带不带 driven 标记）→ 无人值守
 *   DU-5   同样的来源不带那一项 → 有人值守
 *   DU-6   无人值守的会话空闲时被后台通知自动续跑：那一轮照旧无人值守，没有新事件
 *   DU-7   有人值守的会话运行中被插入系统通知：照旧有人值守，没有事件
 *   DU-8   只带显示侧车、不带来源的输入：状态不动
 *   DU-9b  人此刻亲手重发一条机器来源的消息（humanPresent）：这一轮有人值守，来源章照旧
 * 运行中的变化
 *   DU-9   触发运行忙着，人插话 → 当场有人值守；之后的询问照常挂起
 *   DU-10  触发运行忙着，人追加（followUp）→ 同样从受理起有人值守
 *   DU-11  attend()：转回一次、事件一条；再点没有第二条；有人值守时点了无事发生
 *   DU-12  人开的一轮忙着，无人值守的驱动方插话 → 从那一刻起无人值守，下一条询问当场落定
 *   DU-13  人开的一轮挂着一张卡，这时转成无人值守 → 那张卡当场以 unattended 收掉，挂起表为空
 *   DU-14  事件只在变化时发：触发、触发、人、人、attend → [true, false]
 * requestUserInput
 *   DU-15  无人值守：当场落定，挂起表为空，订阅询问的钩子一次都没被调
 *   DU-16  同一个 id 连问两次：两次都是 unattended，没有谁顶替谁
 *   DU-17  带着派生 agent 的 conversationId 的询问：一样
 *   DU-18  有人值守：照旧挂起，应答落定（「询问一律等待」的回归）
 *   DU-19  有人值守、挂着一张卡时 attend()：没有影响
 *   DU-20  无人值守：对被拒的询问 respondToInput → false
 *   DU-21  无人值守再 abort()：之后的询问照样不挂起
 * 状态不该变的地方
 *   DU-22  有人值守且忙：触发来源的发送被拒（busy）→ 状态不动、没有事件
 *   DU-23  同上但带 requestId（跳过早退，由 durable 拒）→ 状态不动
 *   DU-23b 反过来：无人值守且忙，人的发送被拒 → 仍是无人值守
 *   DU-26  重新挂上（同一 requestId、不同来源）：不改状态
 *   DU-27  触发运行跑完：标记留着（界面只在运行中才画，自动续跑的那一轮跟着它）
 *   DU-28  关掉再打开 / 重启：从有人值守算起；关掉那一刻广播 unattended:false
 */
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { obj } from '@earendil-works/pi-schema'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it } from 'vitest'
import type { DurableSession } from '../durableSession'
import { readInputSources } from '../inputSource'
import { answer, callTool } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { holdTool } from './support/tools'
import { deferred, sleep, waitFor, withTimeout, type Deferred } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000
const SID = 'unattended'
const UNATTENDED: InputResponse = { kind: 'cancel', reason: 'unattended' }

const LOCAL = { kind: 'local' } as const
const REMOTE = { kind: 'remote', clientId: 'ws:4', address: '10.0.0.2', userAgent: 'UA' } as const
const CHROME = { kind: 'chrome', installId: 'inst-1' } as const
const TELEGRAM = { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' } as const
const ACCEPTED = {
  kind: 'local',
  suggestion: { messageId: '12', toolCallId: 'c-s', index: 0 }
} as const
const TRIGGER = { kind: 'trigger', trigger: 'timer.fired', bot: 'b' } as const
const DRV = (unattended: boolean): InputOrigin => ({
  kind: 'parent-session',
  sessionId: 'p',
  ...(unattended ? { unattended: true } : {})
})
const OTHER = (unattended: boolean): InputOrigin => ({
  kind: 'session',
  sessionId: 'o',
  ...(unattended ? { unattended: true } : {})
})

const askRequest = (id: string, extra: Partial<InputRequest> = {}): InputRequest =>
  ({
    id,
    kind: 'ask',
    toolName: 'bash',
    command: 'rm -rf build',
    createdAt: 0,
    ...extra
  }) as InputRequest
const choiceRequest = (id: string): InputRequest => ({
  id,
  kind: 'choice',
  toolName: 'ask',
  question: 'Q',
  options: [{ label: 'A', description: 'a' }],
  createdAt: 0
})

interface Probe {
  /** 工具开始执行时这一轮的状态 */
  unattended: boolean
  response: InputResponse
}

interface Rig {
  t: TestHost
  session: DurableSession
  /** `hold` 工具：每次调用开始时落定 running，等 gate 放行 */
  gate: Deferred
  running: Deferred
  /** `probe` 工具每次调用的记录（按顺序） */
  probes: Probe[]
  /** 状态事件的布尔序列 */
  events(): boolean[]
}

async function rig(sessionId = SID): Promise<Rig> {
  const gate = deferred()
  const running = deferred()
  const probes: Probe[] = []
  // 工具在会话打开之前就得造好：经这个盒子晚绑定
  const opened: { session?: DurableSession } = {}
  const probe: ToolRegistration = defineTool({
    name: 'probe',
    description: 'probe: asks the user and reports what came back',
    parameters: obj({}),
    execute: async (_args, api) => {
      const session = opened.session!
      const unattended = session.unattended
      const response = await session.requestUserInput(askRequest(api.callId))
      probes.push({ unattended, response })
      return { output: [{ type: 'text', text: JSON.stringify(response) }] }
    }
  })
  const t = await makeHost({
    ephemeral: [sessionId],
    noticeCoalesceMs: 20,
    tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() }), probe]
  })
  const session = await t.open(sessionId)
  opened.session = session
  await primeRoot(session)
  return {
    t,
    session,
    gate,
    running,
    probes,
    events: () =>
      t.broadcastsOf('unattended').map((event) => (event as { unattended: boolean }).unattended)
  }
}

/** 跑完一轮只有一句回答的运行 */
async function turn(r: Rig, source: InputOrigin | undefined, text = 'go'): Promise<void> {
  r.t.kit.queue(answer('ok'))
  expect(await r.session.submitUser(text, source === undefined ? {} : { source })).toEqual({})
}

/** 开一轮停在 `hold` 上的运行 */
async function heldTurn(
  r: Rig,
  source: InputOrigin,
  ...after: Parameters<TestHost['kit']['queue']>
): Promise<{ sending: Promise<unknown> }> {
  r.t.kit.queue(callTool('hold'), ...after)
  const sending = r.session.submitUser('go', { source })
  await withTimeout(r.running.promise, 5000, 'hold running')
  // 包一层：async 函数直接交回这个 promise 会被摊平成「等这一轮跑完」
  return { sending }
}

describe('unattended run · the state table', () => {
  it('DU-1 a fresh session is attended and has broadcast nothing', async () => {
    const r = await rig()
    expect(r.session.unattended).toBe(false)
    expect(r.events()).toEqual([])
  })

  it(
    'DU-2 a trigger-started turn is unattended from admission on: a tool in that turn sees it, and one true event is broadcast',
    async () => {
      const r = await rig()
      r.t.kit.queue(callTool('probe'), answer('done'))
      expect(await r.session.submitUser('tick', { source: TRIGGER })).toEqual({})

      expect(r.probes).toEqual([{ unattended: true, response: UNATTENDED }])
      expect(r.session.unattended).toBe(true)
      expect(r.t.broadcastsOf('unattended')).toEqual([
        { type: 'unattended', sessionId: SID, unattended: true }
      ])
      expect(r.t.asks).toEqual([])
    },
    TIMEOUT
  )

  it.each([
    ['local', LOCAL],
    ['remote', REMOTE],
    ['chrome', CHROME],
    ['telegram', TELEGRAM],
    ['an accepted suggestion', ACCEPTED]
  ] as [string, InputOrigin][])(
    'DU-3 a message from a person (%s) turns an unattended session back, with one false event',
    async (_label, human) => {
      const r = await rig()
      await turn(r, TRIGGER)
      expect(r.session.unattended).toBe(true)
      await turn(r, human, 'hello')
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([true, false])
    },
    TIMEOUT
  )

  it(
    'DU-4 a message from another session stamped unattended:true (parent or other, driven or not) starts an unattended turn',
    async () => {
      const r = await rig()
      r.t.kit.queue(callTool('probe'), answer('done'))
      expect(
        await r.session.submitUser('task', {
          source: DRV(true),
          requestId: 'R1',
          driven: { parentId: 'p', background: true }
        })
      ).toEqual({})
      expect(r.probes).toEqual([{ unattended: true, response: UNATTENDED }])

      await turn(r, LOCAL, 'me')
      expect(r.session.unattended).toBe(false)
      await turn(r, OTHER(true), 'from another session')
      expect(r.session.unattended).toBe(true)
      expect(r.events()).toEqual([true, false, true])
    },
    TIMEOUT
  )

  it(
    'DU-5 the same senders without the stamp start an attended turn',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER)
      await turn(r, DRV(false), 'from an attended parent')
      expect(r.session.unattended).toBe(false)

      await turn(r, TRIGGER, 'again')
      await turn(r, OTHER(false), 'from an attended session')
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([true, false, true, false])
    },
    TIMEOUT
  )

  it(
    'DU-6 a background notice that auto-resumes an idle unattended session starts a turn that is still unattended, with no new event',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER)
      r.t.kit.queue(callTool('probe'), answer('carried on'))
      await r.session.notify('<background-task id="t1">done</background-task>')
      await waitFor(() => r.probes.length === 1, 5000, 'auto-resumed turn asked')

      expect(r.probes[0]).toEqual({ unattended: true, response: UNATTENDED })
      expect(r.session.pendingInputCount).toBe(0)
      await waitFor(() => !r.session.isBusy(), 5000, 'auto-resumed turn ended')
      expect(r.session.unattended).toBe(true)
      expect(r.events()).toEqual([true])
    },
    TIMEOUT
  )

  it(
    'DU-7 a system notice steered into an attended run leaves it attended and broadcasts nothing',
    async () => {
      const r = await rig()
      const { sending } = await heldTurn(r, LOCAL, answer('done'))
      await r.session.notify('<background-task id="t1">done</background-task>')
      expect(r.session.unattended).toBe(false)
      r.gate.resolve()
      expect(await sending).toEqual({})
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([])
    },
    TIMEOUT
  )

  it(
    'DU-8 an input with a display sidecar but no source does not touch the state, either way',
    async () => {
      const r = await rig()
      r.t.kit.queue(answer('ok'))
      expect(await r.session.submitUser('plain', { display: { content: 'plain' } })).toEqual({})
      expect(r.session.unattended).toBe(false)

      await turn(r, TRIGGER)
      r.t.kit.queue(answer('ok'))
      expect(await r.session.submitUser('plain 2', { display: { content: 'plain 2' } })).toEqual({})
      r.t.kit.queue(answer('ok'))
      expect(await r.session.submitUser('bare')).toEqual({})
      expect(r.session.unattended).toBe(true)
      expect(r.events()).toEqual([true])
    },
    TIMEOUT
  )

  it(
    'DU-9b a machine-sourced message a person resends by hand (humanPresent) starts an attended turn; the source stamp is unchanged',
    async () => {
      const r = await rig()
      r.t.kit.queue(callTool('probe'), answer('done'))
      const sending = r.session.submitUser('tick again', { source: TRIGGER, humanPresent: true })
      // 有人在：这一条询问照常挂起
      await waitFor(() => r.session.pendingInputCount === 1, 5000, 'card pending')
      expect(r.session.unattended).toBe(false)
      const [pending] = r.t.asksOf('input_request')
      expect(r.session.respondToInput(pending!.request.id, { kind: 'ask', allowed: true })).toBe(
        true
      )
      expect(await sending).toEqual({})
      expect(r.events()).toEqual([])
      expect([...(await readInputSources(r.session)).values()]).toEqual([TRIGGER])

      // 已经是无人值守时，同样的重发把它转回
      await turn(r, TRIGGER)
      r.t.kit.queue(answer('ok'))
      expect(
        await r.session.submitUser('resend', { source: DRV(true), humanPresent: true })
      ).toEqual({})
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([true, false])
    },
    TIMEOUT
  )
})

describe('unattended run · changes in the middle of a run', () => {
  it(
    'DU-9 a person steering into a busy trigger run makes it attended at once; an ask after that suspends as usual',
    async () => {
      const r = await rig()
      const { sending } = await heldTurn(r, TRIGGER, callTool('probe'), answer('done'))
      expect(r.session.unattended).toBe(true)

      const steer = await r.session.steer('I am here', { source: LOCAL })
      expect(steer.error).toBeUndefined()
      // 受理的那一刻就转了（这条插话还没被放下）
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([true, false])

      r.gate.resolve()
      await waitFor(() => r.session.pendingInputCount === 1, 5000, 'card pending')
      const [pending] = r.t.asksOf('input_request')
      expect(r.session.respondToInput(pending!.request.id, { kind: 'ask', allowed: true })).toBe(
        true
      )
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      expect(r.probes).toEqual([{ unattended: false, response: { kind: 'ask', allowed: true } }])
    },
    TIMEOUT
  )

  it(
    'DU-10 a follow-up from a person queued behind a busy trigger run makes it attended from admission',
    async () => {
      const r = await rig()
      const { sending } = await heldTurn(r, TRIGGER, answer('first'), answer('second'))
      const queued = await r.session.followUp('and then this', { source: REMOTE })
      expect(queued.error).toBeUndefined()
      expect(r.session.unattended).toBe(false)
      r.gate.resolve()
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      await waitFor(() => !r.session.isBusy(), 5000, 'follow-up ran')
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([true, false])
    },
    TIMEOUT
  )

  it(
    'DU-11 attend(): one false event; a second attend() and attend() on an attended session broadcast nothing',
    async () => {
      const r = await rig()
      r.session.attend()
      expect(r.events()).toEqual([])

      const { sending } = await heldTurn(r, TRIGGER, callTool('probe'), answer('done'))
      r.session.attend()
      expect(r.session.unattended).toBe(false)
      r.session.attend()
      expect(r.events()).toEqual([true, false])

      r.gate.resolve()
      await waitFor(() => r.session.pendingInputCount === 1, 5000, 'card pending')
      const [pending] = r.t.asksOf('input_request')
      r.session.respondToInput(pending!.request.id, { kind: 'ask', allowed: false })
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      expect(r.events()).toEqual([true, false])
    },
    TIMEOUT
  )

  it(
    'DU-12 an unattended driver steering into a person’s busy run makes it unattended from then on: the next ask settles on the spot',
    async () => {
      const r = await rig()
      const { sending } = await heldTurn(r, LOCAL, callTool('probe'), answer('done'))
      expect(r.session.unattended).toBe(false)

      const steer = await r.session.steer('carry on with this', { source: DRV(true) })
      expect(steer.error).toBeUndefined()
      expect(r.session.unattended).toBe(true)

      r.gate.resolve()
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      expect(r.probes).toEqual([{ unattended: true, response: UNATTENDED }])
      expect(r.t.asks).toEqual([])
      expect(r.events()).toEqual([true])
    },
    TIMEOUT
  )

  it.each([
    ['a trigger message', TRIGGER],
    ['an unattended driver', DRV(true)]
  ] as [string, InputOrigin][])(
    'DU-13 a card already pending when %s steers in is settled as unattended: the pending table is empty once the run is unattended',
    async (_label, machine) => {
      const r = await rig()
      r.t.kit.queue(callTool('probe', {}, 'c-p'), answer('done'))
      const sending = r.session.submitUser('go', { source: LOCAL })
      await waitFor(() => r.session.pendingInputCount === 1, 5000, 'card pending')

      const steer = await r.session.steer('automatic', { source: machine })
      expect(steer.error).toBeUndefined()
      expect(r.session.unattended).toBe(true)
      expect(r.session.pendingInputCount).toBe(0)
      expect(r.session.pendingInputs()).toEqual([])

      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      expect(r.probes).toEqual([{ unattended: false, response: UNATTENDED }])
      expect(r.t.asksOf('input_request_resolved').map((event) => event.requestId)).toEqual(['c-p'])
    },
    TIMEOUT
  )

  it(
    'DU-14 events are broadcast only on a change: trigger, trigger, person, person, attend → [true, false]',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER, 'one')
      await turn(r, TRIGGER, 'two')
      await turn(r, LOCAL, 'three')
      await turn(r, CHROME, 'four')
      r.session.attend()
      expect(r.events()).toEqual([true, false])
    },
    TIMEOUT
  )
})

describe('unattended run · requestUserInput', () => {
  it(
    'DU-15 unattended: an approval and a question both settle at once with reason unattended; nothing is ever pending or announced',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER)

      // 同一条微任务链上落定：不靠计时器
      let settled = false
      const first = r.session.requestUserInput(askRequest('a-1')).then((response) => {
        settled = true
        return response
      })
      expect(r.session.pendingInputCount).toBe(0)
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(true)
      expect(await first).toEqual(UNATTENDED)
      expect(await r.session.requestUserInput(choiceRequest('q-1'))).toEqual(UNATTENDED)

      expect(r.session.pendingInputCount).toBe(0)
      expect(r.session.pendingInputs()).toEqual([])
      expect(r.session.pendingInputSummaries).toEqual([])
      expect(r.t.asks).toEqual([])
      expect(r.t.broadcastsOf('ask_count')).toEqual([])
    },
    TIMEOUT
  )

  it(
    'DU-16 two requests with the same id back to back both resolve unattended: nothing supersedes anything',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER)
      const [a, b] = await Promise.all([
        r.session.requestUserInput(askRequest('same')),
        r.session.requestUserInput(askRequest('same'))
      ])
      expect([a, b]).toEqual([UNATTENDED, UNATTENDED])
      expect(r.session.pendingInputCount).toBe(0)
    },
    TIMEOUT
  )

  it(
    'DU-17 a request carrying a spawned agent’s conversationId is refused the same way',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER)
      expect(
        await r.session.requestUserInput(askRequest('spawned', { conversationId: 7 }))
      ).toEqual(UNATTENDED)
      expect(r.session.pendingInputCount).toBe(0)
      expect(r.t.asks).toEqual([])
    },
    TIMEOUT
  )

  it(
    'DU-18 attended: a request suspends until it is answered, with no frontend involved at all',
    async () => {
      const r = await rig()
      await turn(r, LOCAL)
      let response: InputResponse | undefined
      void r.session.requestUserInput(askRequest('a-1')).then((value) => (response = value))
      await sleep(30)
      expect(response).toBeUndefined()
      expect(r.session.pendingInputCount).toBe(1)
      expect(r.session.respondToInput('a-1', { kind: 'ask', allowed: true })).toBe(true)
      await waitFor(() => response !== undefined, 2000, 'answer')
      expect(response).toEqual({ kind: 'ask', allowed: true })
    },
    TIMEOUT
  )

  it(
    'DU-19 attend() on an attended session with a card pending leaves the card alone',
    async () => {
      const r = await rig()
      let response: InputResponse | undefined
      void r.session.requestUserInput(askRequest('a-1')).then((value) => (response = value))
      await sleep(10)
      r.session.attend()
      await sleep(10)
      expect(response).toBeUndefined()
      expect(r.session.pendingInputCount).toBe(1)
      expect(r.events()).toEqual([])
      r.session.respondToInput('a-1', { kind: 'ask', allowed: false })
    },
    TIMEOUT
  )

  it(
    'DU-20 unattended: answering a request that was refused finds nothing (false)',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER)
      expect(await r.session.requestUserInput(askRequest('a-1'))).toEqual(UNATTENDED)
      expect(r.session.respondToInput('a-1', { kind: 'ask', allowed: true })).toBe(false)
    },
    TIMEOUT
  )

  it(
    'DU-21 unattended then abort(): a late request still does not suspend',
    async () => {
      const r = await rig()
      const { sending } = await heldTurn(r, TRIGGER)
      await withTimeout(r.session.abort(), 5000, 'abort')
      await withTimeout(sending, 5000, 'run')
      const late = await withTimeout(
        r.session.requestUserInput(askRequest('late')),
        2000,
        'late request'
      )
      expect(late.kind).toBe('cancel')
      expect(r.session.pendingInputCount).toBe(0)
    },
    TIMEOUT
  )
})

describe('unattended run · where the state must not change', () => {
  it(
    'DU-22 a trigger send refused as busy (no requestId) leaves a person’s running turn attended',
    async () => {
      const r = await rig()
      const { sending } = await heldTurn(r, LOCAL, answer('done'))
      expect(await r.session.submitUser('tick', { source: TRIGGER })).toMatchObject({
        code: 'busy'
      })
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([])
      r.gate.resolve()
      expect(await sending).toEqual({})
    },
    TIMEOUT
  )

  it(
    'DU-23 a driven send with a requestId refused as busy by durable does not flip a person’s running turn',
    async () => {
      const r = await rig()
      r.t.kit.queue(callTool('hold'), callTool('probe', {}, 'c-p'), answer('done'))
      const sending = r.session.submitUser('go', { source: LOCAL })
      await withTimeout(r.running.promise, 5000, 'hold running')

      expect(
        await r.session.submitUser('task', {
          source: DRV(true),
          requestId: 'R-busy',
          driven: { parentId: 'p', background: true }
        })
      ).toMatchObject({ code: 'busy' })
      expect(r.session.unattended).toBe(false)
      expect(r.events()).toEqual([])

      // 这一轮仍然有人在：之后的询问照常挂起
      r.gate.resolve()
      await waitFor(() => r.session.pendingInputCount === 1, 5000, 'card pending')
      r.session.respondToInput('c-p', { kind: 'ask', allowed: true })
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
    },
    TIMEOUT
  )

  it(
    'DU-23b the other way round: a person’s send refused as busy does not make a running trigger turn attended',
    async () => {
      const r = await rig()
      const { sending } = await heldTurn(r, TRIGGER, callTool('probe'), answer('done'))
      expect(await r.session.submitUser('hello', { source: LOCAL })).toMatchObject({
        code: 'busy'
      })
      expect(
        await r.session.submitUser('hello', { source: LOCAL, requestId: 'R-human' })
      ).toMatchObject({ code: 'busy' })
      expect(r.session.unattended).toBe(true)
      r.gate.resolve()
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      expect(r.probes).toEqual([{ unattended: true, response: UNATTENDED }])
      expect(r.events()).toEqual([true])
    },
    TIMEOUT
  )

  it(
    'DU-26 re-attaching to a settled request with a different source does not change the state',
    async () => {
      const r = await rig()
      r.t.kit.queue(answer('ok'))
      expect(await r.session.submitUser('mine', { source: LOCAL, requestId: 'R' })).toEqual({})
      expect(await r.session.submitUser('mine', { source: TRIGGER, requestId: 'R' })).toEqual({})
      expect(r.session.unattended).toBe(false)

      r.t.kit.queue(answer('ok'))
      expect(await r.session.submitUser('tick', { source: TRIGGER, requestId: 'T' })).toEqual({})
      expect(await r.session.submitUser('tick', { source: LOCAL, requestId: 'T' })).toEqual({})
      expect(r.session.unattended).toBe(true)
      expect(r.events()).toEqual([true])
      expect(r.t.kit.callCount).toBe(2)
    },
    TIMEOUT
  )

  it(
    'DU-27 the flag outlives the trigger run: the session stays unattended while idle, with no event at run end',
    async () => {
      const r = await rig()
      await turn(r, TRIGGER)
      expect(r.session.isBusy()).toBe(false)
      expect(r.session.unattended).toBe(true)
      expect(r.events()).toEqual([true])
      expect(await r.session.requestUserInput(askRequest('idle'))).toEqual(UNATTENDED)
    },
    TIMEOUT
  )

  it(
    'DU-28 the flag lives in memory: closing broadcasts unattended:false, and the reopened session starts attended',
    async () => {
      const t = await makeHost()
      const session = await t.open('persisted')
      await primeRoot(session)
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('tick', { source: TRIGGER })).toEqual({})
      expect(session.unattended).toBe(true)

      const next = await t.restart()
      expect(t.broadcastsOf('unattended')).toEqual([
        { type: 'unattended', sessionId: 'persisted', unattended: true },
        { type: 'unattended', sessionId: 'persisted', unattended: false }
      ])
      expect(session.unattended).toBe(false)

      const reopened = await next.open('persisted')
      expect(reopened.unattended).toBe(false)
      expect(next.broadcastsOf('unattended')).toEqual([])
      // 重开之后来源章还在存储里，但不据此反推（设计 §2 的取舍）
      expect([...(await readInputSources(reopened)).values()]).toEqual([TRIGGER])
    },
    TIMEOUT
  )

  it(
    'DU-28b closing an attended session broadcasts nothing',
    async () => {
      const t = await makeHost()
      const session = await t.open('plain')
      await primeRoot(session)
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('hi', { source: LOCAL })).toEqual({})
      await t.restart()
      expect(t.broadcastsOf('unattended')).toEqual([])
    },
    TIMEOUT
  )
})
