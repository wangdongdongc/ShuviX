/**
 * 聊天会话里的用户询问，端到端（M7′）。
 *
 * **为什么非要有这一份**：三个单测各自证明了 broker、botService、sessionService 的行为，
 * 但没有一个能证明两份参与方在真实 app 里**确实注册上了** —— 那是模块加载顺序的副作用，
 * 谁都没显式调用过。M7′ 最容易静默回归的正是这一条：某天有人把 botService 的 import 从
 * 启动链上摘掉，所有单测照绿，而 bot 会话里的每一次询问重新变回「Session … is not active」。
 *
 * 链路：任务段 agent 是**派生的**，自身没有输入面板（`hasUserInputCapability` 恒 false），
 * 它的 `ask` 带着**根会话 id**（= 这条聊天会话）走 broker → botService.requestUserInput
 * → 广播 `input_request` → 前端答复 → `respondToUserInput(requestId, …)` 回到同一处。
 *
 * 内置 `bot-chat` 的任务段是 M8′ 待做、门控段跑 `tools: []`，今天没有任何内置路径会在聊天
 * 会话里发询问，所以这里自带一份最小探针管线：它只做一件事 —— 派一个带 `ask` 的 agent
 * 出去，把结果说出来。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  createBotSession,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'

let app: E2EApp
let events: EventRecorder
let provider: FakeProvider

const MODEL = 'e2e-model'
/** 探针管线的名字 —— bot md 用 `shuvix-bot-pipeline` 指向它 */
const PIPELINE = 't-ask'
const BOT = 'u-ask'
/**
 * 派发提示词里的记号 —— 假提供商的队列按「请求体读完的顺序」消费，标题请求与工具回合
 * 混在一起时不按内容认领就会串号。
 */
const MARK = 'ASK-PROBE-MARKER'

/**
 * 最小探针管线：派一个只带 `ask` 的 agent 出去，然后把它的结局说出来。
 *
 * `run()` 失败时**不往上抛而是说出来** —— 这条会话的 `message.list` 因此成了一个观测面：
 * 回归发生时（询问在 broker 处被拒）这里会留下那句 `Session … is not active`，
 * 而不是只在某个没人看的子代理转录里一闪而过。
 *
 * `say` 就是纯粹的落库动作：v2 取消仲裁之后没有「赢了才能说」那道强制，脚本 API 里
 * 也不再有 `claim`（写它是 ReferenceError）。
 */
const PIPELINE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PIPELINE}`,
  'description: e2e probe pipeline — dispatch one agent that may ask the user something.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'E2E 探针：派一个带 `ask` 的任务段出去，把结局原样说出来。',
  '',
  '```js workflow',
  "var out = ''",
  'try {',
  "  out = await run(input.agents.task || 'coding', '" + MARK + " ask the user which colour.', {",
  "    tools: ['ask'],",
  '    timeoutSec: 120',
  '  })',
  '} catch (e) {',
  "  out = 'RUN FAILED: ' + String((e && e.message) || e)",
  '}',
  "await say('probe result: ' + String(out))",
  "return { outcome: 'done' }",
  '```',
  ''
].join('\n')

interface Msg {
  id: string
  role?: string
  content?: unknown
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

/** 发出但**不等** —— 询问挂起期间 prompt 根本不会返回 */
const promptDetached = (sid: string, text: string): Promise<string> =>
  app.main.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), 'sent')`
  )

const abortSession = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)

const respond = (params: Record<string, unknown>): Promise<unknown> =>
  app.main.eval(`window.api.agent.respondToInput(${JSON.stringify(params)})`)

/** 等到该会话上出现 n 条 assistant 消息 */
async function untilReplies(sid: string, n: number): Promise<Msg[]> {
  for (let i = 0; i < 150; i++) {
    const msgs = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    if (msgs.length >= n) return msgs
    await sleep(100)
  }
  return (await listMessages(sid)).filter((m) => m.role === 'assistant')
}

const textOf = (msgs: Msg[]): string => msgs.map((m) => String(m.content ?? '')).join('\n')

/**
 * 脚本化一次「调用 ask 工具」。
 *
 * 派发那一发的请求体里带着 MARK；工具结果回来之后 agent 还会再发一次，那一发里多了
 * `User selected: …` —— 两条 `when` 因此互不重叠，队列消费顺序错乱也认得出自己那一份。
 */
function askTurn(): Parameters<FakeProvider['script']>[0] {
  return {
    toolCalls: [
      {
        id: 'call_ask',
        name: 'ask',
        args: JSON.stringify({
          question: '用哪个颜色？',
          options: [
            { label: 'Blue', description: '冷一点' },
            { label: 'Red', description: '热一点' }
          ],
          allowMultiple: false
        })
      }
    ],
    usage: { prompt: 200, completion: 20 },
    when: (r: FakeRequest) => !r.isTitle && r.raw.includes(MARK) && !r.raw.includes('User selected')
  }
}

/** 工具结果回来之后那一发 —— 答复真的进了 agent 上下文，它才说得出这句 */
function afterAnswer(): Parameters<FakeProvider['script']>[0] {
  return {
    text: 'ASKED-OK',
    usage: { prompt: 220, completion: 6 },
    when: (r: FakeRequest) => !r.isTitle && r.raw.includes('User selected')
  }
}

/** 等这条会话上的下一条 input_request，返回其中的 requestId */
async function waitAsk(sid: string): Promise<string> {
  const e = await events.waitFor<RecordedEvent & { request: { id: string } }>('input_request', {
    sessionId: sid
  })
  return e.request.id
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PIPELINE}.md`), PIPELINE_MD)

  // 任务段显式指向 `coding`：默认的 `bot:<name>` 自指要到 M8′ 才有解析器，
  // 而这份用例要测的是询问路由，不是角色解析
  writeBotMd(app, BOT, {
    description: 'asks the user something',
    displayName: 'Asker',
    pipeline: PIPELINE,
    agents: { task: 'coding' }
  })
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('聊天会话里的询问', () => {
  it('派生 agent 的 ask 真的到达前端，答复也真的回到它的上下文里', async () => {
    // **M7′ 的主诉**：此前 broker 的单槽 resolver 只认有根会话，聊天会话的每一次询问都
    // 以「Session … is not active」收场 —— 工具拿到一条错误，用户那边什么都没发生。
    // 这条用例的第一行断言（等到 input_request）就是那道回归夹子
    provider.reset()
    await events.clear()
    provider.script(askTurn(), afterAnswer())

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'U-ask-arrive' })
    await promptDetached(sid, '挑个颜色')

    const requestId = await waitAsk(sid)
    await respond({ sessionId: sid, requestId, response: { kind: 'choice', selections: ['Blue'] } })
    await events.waitFor('input_request_resolved', { sessionId: sid })

    const said = textOf(await untilReplies(sid, 1))
    // 「ASKED-OK」只有在答复真的作为 tool result 回到 agent 上下文之后才说得出来 ——
    // 光有 input_request 事件只证明请求出去了，不证明这条链路是闭合的
    expect(said).toContain('ASKED-OK')
    expect(said).not.toContain('is not active')
    expect(said).not.toContain('RUN FAILED')
  })

  it('答复只凭 requestId 找归属 —— 传错 sessionId 也照样送达', async () => {
    // 调用方（IPC）手上的 sessionId 只是它以为的那个。真拿它去选参与方，
    // 一个前端 bug 就能让答复投进另一条会话；而 resolved 事件的 sessionId 必须是
    // **登记时**那个事实，不是答复时补上的猜测
    provider.reset()
    await events.clear()
    provider.script(askTurn(), afterAnswer())

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'U-ask-route' })
    const decoy = await createBotSession(app.main, { bots: [BOT], title: 'U-ask-decoy' })
    await promptDetached(sid, '挑个颜色')

    const requestId = await waitAsk(sid)
    await respond({
      sessionId: decoy,
      requestId,
      response: { kind: 'choice', selections: ['Red'] }
    })

    const resolved = await events.waitFor<RecordedEvent>('input_request_resolved', {
      sessionId: sid
    })
    expect(resolved.requestId).toBe(requestId)

    const said = textOf(await untilReplies(sid, 1))
    expect(said).toContain('ASKED-OK')

    // 送达成功时网关的兜底补播**不得**发生 —— 否则那条会话会平白收到一条撤卡指令
    const all = await events.all<RecordedEvent>()
    expect(all.filter((e) => e.type === 'input_request_resolved' && e.sessionId === decoy)).toEqual(
      []
    )
  })

  it('答一条不存在的 requestId：网关补播 resolved，把那张点不动的卡片收走', async () => {
    // 无人认领 = 请求早已被取消（会话停了、run 超时了），而前端那张待答卡还在：
    // 它只认 `input_request_resolved`，后端既然不会再发，就得由网关补一条。
    // 少了它，用户面对的是一个点下去毫无反应的按钮，唯一的线索在主进程日志里
    await events.clear()
    const sid = await createBotSession(app.main, { bots: [BOT], title: 'U-ask-orphan' })

    await respond({
      sessionId: sid,
      requestId: 'no-such-request',
      response: { kind: 'choice', selections: ['Blue'] }
    })

    const resolved = await events.waitFor<RecordedEvent>('input_request_resolved', {
      sessionId: sid
    })
    expect(resolved.requestId).toBe('no-such-request')
  })

  it('停会话：待答卡被 input_request_resolved 收走，而这条会话从头到尾没有 agent_end', async () => {
    provider.reset()
    await events.clear()
    provider.script(askTurn(), afterAnswer())

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'U-ask-abort' })
    await promptDetached(sid, '挑个颜色')

    const requestId = await waitAsk(sid)
    await abortSession(sid)

    const resolved = await events.waitFor<RecordedEvent>('input_request_resolved', {
      sessionId: sid
    })
    expect(resolved.requestId).toBe(requestId)

    // 有根会话的待答卡还能被 agent_end 兜底收掉；聊天会话没有根运行时，**永不发 agent_end** ——
    // 所以中止路径必须自己广播 resolved，这条断言就是那个「没有第二条退路」的证据
    const all = await events.all<RecordedEvent>()
    expect(all.filter((e) => e.type === 'agent_end' && e.sessionId === sid)).toEqual([])
  })
})
