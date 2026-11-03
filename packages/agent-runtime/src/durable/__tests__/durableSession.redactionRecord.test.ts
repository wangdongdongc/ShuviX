/**
 * 记录即所发（docs/auto-redaction-design.md §16）在真脱敏器 + 真宿主上：对话记录里存什么，模型就收到什么；策略只决定
 * **新**内容脱不脱敏，按写入时这个对话在用的模型判，从不回头改历史。自动脱敏只在工具结果（含后台通知）和自动消息上。
 * 主轴是 `recordEqualsRequest`：每个请求都逐条等于记录的前缀。
 *
 *   RC-1  默认判定两轮：工具结果里的 KEY 存占位符；用户消息、模型回复、系统提示词、默认照发的几类都原样，不进表
 *   RC-2  输入框：steer / followUp / submitUser 不带 secrets 都原样、表空；带 + 值只换它，其余记成照原样发，之后工具打印也不换
 *   RC-3  agent 工具派发：任务与追问原样；子 agent 的回复回到父对话是工具结果，按父对话判
 *   RC-4  别的会话发来的：真值与对方的占位符都原样；importFrom 带来占位符的表项
 *   RC-5  同一会话两个对话：根不脱敏（faux-1）、子脱敏（faux-2），各按自己的模型存
 *   RC-6  通知（notify 忙 / 闲、writeNotice）：按锁住的模型问策略，入参没有对话；进入请求时逐字
 *   RC-7  hosted 任务（hook、审查员）：按子对话与它的模型判；结果契约说明在脱敏之后；根记录不受影响
 *   RC-8  换模型（不脱敏 → 脱敏）：历史明文照发、旧条目字节不变，新工具结果同值存占位符，请求里两种形式并存
 *   RC-8b 回复里的真值（文本、thinking 块）逐字进之后的请求，判定不碰它们
 *   RC-9  换模型（脱敏 → 不脱敏）：旧占位符照发，新输出同值存明文；工具参数写旧占位符，工具拿到真值
 *   RC-10 关掉策略再打开：旧占位符留着且还原得了；关着时新内容明文不记表，+ 值仍是占位符；打开后新内容换、旧明文不动
 *   RC-11 第一层 deny 插在中间：不发请求、出错回复；换回去请求照发
 *   RC-12 第二层 deny：工具结果存占位符，请求照发
 *   RC-13 问题卡：用户答 other 时写的值记成照原样发，结果不换；父会话代答的是工具结果，按策略换
 *   RC-14 还原回显：命令回显转义后的真值，脱敏时换回同一个占位符，不脱敏时存明文
 */
import { Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { DrivingSessionRef } from '@shuvix/chat-protocol/types/inputRequest'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createAskTool } from '../../askTool'
import { asWrittenKey } from '../../redaction/placeholder'
import { initShellParser } from '../../security/shell'
import { loadShellParserWasmFromNodeModules } from '../../security/shell/nodeWasm'
import { buildResultContractNote } from '../../subagent/nextTool'
import { backgroundContext as BG } from '../context'
import type { DurableSession } from '../durableSession'
import type { EgressDecision } from '../redactionEgress'
import type { RedactionPolicy, RedactionPolicyRequest } from '../redactionModels'
import type { AgentConfig } from '../seams'
import type { UserSecret } from '../sessionRedaction'
import { testProfile } from './support/agentConfig'
import { answer, assistantWith, callTool, fauxKit } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import {
  HOOK_PROFILES,
  hookRig,
  permissionPayload,
  promptPayload,
  queueRoles,
  REVIEW_HOOK,
  TITLE_HOOK,
  TITLER,
  type HookRig
} from './support/hookRig'
import {
  byCategory,
  byModel,
  DENY1,
  EMAIL,
  EXEMPT,
  KEY,
  P_KEY,
  PHONE,
  PLACEHOLDER,
  recordedMessages,
  recordEqualsRequest,
  REDACT,
  redactionHost,
  signer
} from './support/redaction'
import { callAgent, hostD, PROFILES } from './support/spawn'
import { holdTool } from './support/tools'
import { allEntries, messageText, requestTexts } from './support/transcript'
import { deferred, waitFor } from './support/wait'

registerHostCleanup()

beforeAll(async () => {
  await initShellParser(loadShellParserWasmFromNodeModules())
})

const TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID

/** 系统提示词里的那把 key：与工具结果里的 KEY 不是同一个值，才看得出它进没进表 */
const PROMPT_KEY = 'sk-proj-' + 'Z9y8X7w6V5u4T3s2R1q0P9o8'
const HOME = '/Users/alice/proj'
const PW = 'Added-By-Plus-42'
const PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----'
const PLUS: UserSecret = { value: PW, category: 'PASSWORD' }

/** 工具：打印固定的文本（或现算的） */
function printTool(text: string | (() => string), name = 'emit'): ToolRegistration {
  return defineTool({
    name,
    description: `${name}: prints something`,
    parameters: Type.Object({}),
    execute: async () => ({
      output: [{ type: 'text', text: typeof text === 'function' ? text() : text }]
    })
  })
}

/** 工具：打印参数（工具参数的还原由宿主做，桌面端 wrapToolOutput.restoreArguments 调的就是 restoreJson） */
function echoTool(getSession: () => DurableSession, seen: unknown[] = []): ToolRegistration {
  return defineTool({
    name: 'echo',
    description: 'echo: prints its argument',
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => {
      const { value } = await getSession().redaction!.restoreJson(args)
      seen.push(value)
      return { output: [{ type: 'text', text: `printed ${value.text}` }] }
    }
  })
}

/** 对话记录（跳过 pi.system）的 JSON，比旧条目字节用 */
async function recordJson(session: DurableSession): Promise<string[]> {
  const entries = await allEntries(await session.currentConversation())
  return entries
    .filter((entry) => entry.kind !== 'pi.system')
    .map((entry) => JSON.stringify(entry.model))
}

async function storedText(session: DurableSession): Promise<string> {
  return (await recordJson(session)).join('\n')
}

async function childConversation(session: DurableSession, id: number): Promise<Conversation> {
  const conversation = await session.harness.conversation(id as never, BG)
  if (conversation === undefined) throw new Error(`no conversation ${id}`)
  return conversation
}

/** 表里的 [类别, 值]（次序按记入的先后） */
async function tableItems(session: DurableSession): Promise<Array<[string, string | undefined]>> {
  return [...(await session.redaction!.table()).entries()].map(([, item]) => [
    item.category,
    item.value
  ])
}

interface TwoModels {
  t: TestHost
  session: DurableSession
  switchTo(modelId: 'faux-1' | 'faux-2'): Promise<void>
}

/** 真宿主、两个模型、锁住的根 agent；`switchTo` 改设置再重配（运行中也生效的那条路） */
async function twoModels(
  id: string,
  policy: RedactionPolicy,
  tools: (getSession: () => DurableSession) => ToolRegistration[] = () => []
): Promise<TwoModels> {
  const config: AgentConfig = {
    profile: testProfile(),
    model: { provider: 'faux', modelId: 'faux-1' }
  }
  const live: { session?: DurableSession } = {}
  const t = await makeHost({
    ephemeral: [id],
    kit: fauxKit({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] }),
    redaction: redactionHost,
    redactionPolicy: policy,
    tools: tools(() => live.session!),
    agentConfig: config
  })
  const session = await t.open(id)
  live.session = session
  await primeRoot(session)
  return {
    t,
    session,
    switchTo: async (modelId) => {
      config.model = { provider: 'faux', modelId }
      expect((await session.reconfigureAgent()).applied).toBe(true)
      expect(session.lock!.model.modelId).toBe(modelId)
    }
  }
}

describe('记录即所发', () => {
  it(
    'RC-1 默认判定两轮：工具结果存占位符；用户消息、回复、系统提示词、路径都原样且不进表',
    async () => {
      const t = await makeHost({
        ephemeral: ['rc1'],
        redaction: redactionHost,
        tools: [printTool(`token ${KEY} at ${HOME}`)],
        agentConfig: {
          profile: testProfile({ systemPrompt: `the deploy key is ${PROMPT_KEY}` }),
          model: { provider: 'faux', modelId: 'faux-1' }
        }
      })
      const session = await t.open('rc1')
      t.kit.queue(callTool('emit'), answer(`call ${PHONE} about it`), answer('second'))
      expect(await session.submitUser(`write to ${EMAIL}`)).toEqual({})
      expect(await session.submitUser('and then?')).toEqual({})
      expect(t.kit.requests).toHaveLength(3)
      for (const n of [0, 1, 2]) {
        await recordEqualsRequest(session, t.kit, n)
        expect(t.kit.requests[n]!.systemPrompt, `request ${n}`).toContain(
          `the deploy key is ${PROMPT_KEY}`
        )
      }
      expect(requestTexts(t.kit, 2)).toEqual([
        `user:write to ${EMAIL}`,
        'assistant:[tool:emit]',
        `toolResult:token ${P_KEY} at ${HOME}`,
        `assistant:call ${PHONE} about it`,
        'user:and then?'
      ])
      expect(await tableItems(session)).toEqual([['API_KEY', KEY]])
      const table = await session.redaction!.table()
      for (const value of [EMAIL, PHONE, 'alice', PROMPT_KEY]) {
        expect(table.known.get(value), value).toBeUndefined()
      }
    },
    TIMEOUT
  )

  describe('RC-2 输入框', () => {
    const entries = ['submitUser', 'steer', 'followUp'] as const

    async function send(
      session: DurableSession,
      kind: (typeof entries)[number],
      text: string,
      composer?: { secrets: UserSecret[] }
    ): Promise<void> {
      const options = composer === undefined ? {} : { composer }
      if (kind === 'submitUser') {
        expect(await session.submitUser(text, options)).toEqual({})
      } else {
        const admitted = await session[kind](text, options)
        expect(admitted.error).toBeUndefined()
      }
    }

    for (const kind of entries) {
      for (const [label, composer] of [
        ['no composer', undefined],
        ['composer with no secrets', { secrets: [] as UserSecret[] }]
      ] as const) {
        it(
          `${kind} · ${label}：KEY 原样，表 0 项`,
          async () => {
            const t = await makeHost({
              ephemeral: ['rc2'],
              redaction: redactionHost,
              redactionPolicy: () => REDACT
            })
            const session = await t.open('rc2')
            await primeRoot(session)
            t.kit.queue(answer('ok'))
            const text = `use ${KEY}`
            await send(session, kind, text, composer)
            await waitFor(() => t.kit.requests.length >= 1)
            expect(requestTexts(t.kit, 0)).toEqual([`user:${text}`])
            await recordEqualsRequest(session, t.kit, 0)
            expect(await tableItems(session)).toEqual([])
          },
          TIMEOUT
        )
      }

      it(
        `${kind} · + 值：只换 PW，其余明文进 asWritten；之后工具打印它也不换`,
        async () => {
          const t = await makeHost({
            ephemeral: ['rc2s'],
            redaction: redactionHost,
            redactionPolicy: () => REDACT,
            tools: [printTool(`got ${KEY} and ${PW}`)]
          })
          const session = await t.open('rc2s')
          await primeRoot(session)
          t.kit.queue(callTool('emit'), answer('done'))
          await send(session, kind, `use ${KEY} with ${PW}`, { secrets: [PLUS] })
          await waitFor(() => t.kit.requests.length >= 2)
          const [p] = (await session.redaction!.table()).entries().next().value!
          expect(p).toMatch(/^\{\{REDACTED_PASSWORD_[a-z2-7]{8}\}\}$/)
          expect(requestTexts(t.kit, 1)).toEqual([
            `user:use ${KEY} with ${p}`,
            'assistant:[tool:emit]',
            `toolResult:got ${KEY} and ${p}`
          ])
          await recordEqualsRequest(session, t.kit, 1)
          expect(await tableItems(session)).toEqual([['PASSWORD', PW]])
          const table = await session.redaction!.table()
          expect(table.asWritten.has(asWrittenKey(signer, KEY))).toBe(true)
          expect(table.asWritten.has(asWrittenKey(signer, PW))).toBe(false)
        },
        TIMEOUT
      )
    }
  })

  it(
    'RC-3 agent 工具派发：任务与追问原样；子 agent 的回复回到父对话是工具结果，按父对话判',
    async () => {
      const d = await hostD({
        host: { redaction: redactionHost, redactionPolicy: () => REDACT }
      })
      const { session, t } = d
      t.kit.queue(callAgent('explore', `find ${KEY}`), answer(`found ${KEY}`), answer('done'))
      expect(await session.submitUser('go')).toEqual({})
      expect(d.outcomes.at(-1)!.error).toBeUndefined()
      const C = d.outcomes.at(-1)!.conversationId!
      const child = await childConversation(session, C)
      const root = await childConversation(session, ROOT)
      // 子对话：任务原样进记录、原样发，子 agent 的回复原样存
      expect(requestTexts(t.kit, 1)).toEqual([`user:find ${KEY}`])
      await recordEqualsRequest(session, t.kit, 1, child)
      expect(await recordedMessages(child)).toHaveLength(2)
      expect(messageText((await recordedMessages(child))[1])).toBe(`found ${KEY}`)
      // 父对话：派发参数是模型自己写的，原样；回复作为工具结果换成占位符
      expect(requestTexts(t.kit, 2).at(-1)).toBe(`toolResult:found ${P_KEY}`)
      await recordEqualsRequest(session, t.kit, 0, root)
      await recordEqualsRequest(session, t.kit, 2, root)
      expect(JSON.stringify(await recordedMessages(root))).toContain(`"prompt":"find ${KEY}"`)
      // 面板追问同样原样
      t.kit.queue(answer('more'))
      const outcome = await session.agents.continue(C, `more about ${KEY}`)
      expect(outcome.error).toBeUndefined()
      expect(requestTexts(t.kit, 3).slice(-1)).toEqual([`user:more about ${KEY}`])
      await recordEqualsRequest(session, t.kit, 3, child)
    },
    TIMEOUT
  )

  describe('RC-4 别的会话发来的', () => {
    const sources: DrivingSessionRef[] = [
      { kind: 'session', sessionId: 'from' },
      { kind: 'parent-session', sessionId: 'from' }
    ]
    for (const source of sources) {
      it(
        `${source.kind}：真值与对方的占位符都原样，请求逐字；importFrom 带来占位符的表项`,
        async () => {
          const t = await makeHost({
            ephemeral: ['from', 'to'],
            redaction: redactionHost,
            redactionPolicy: () => REDACT
          })
          const from = await t.open('from')
          const to = await t.open('to')
          expect(await from.redaction!.maskText(`use ${KEY}`)).toBe(`use ${P_KEY}`)
          expect(await tableItems(to)).toEqual([])
          const text = `plain ${KEY} and theirs ${P_KEY}`
          await to.redaction!.importFrom(from.redaction!, [text])
          expect(await tableItems(to)).toEqual([['API_KEY', KEY]])
          t.kit.queue(answer('ok'))
          expect(
            await to.submitUser(text, {
              driven: { parentId: 'from', background: true },
              requestId: 'R',
              source
            })
          ).toEqual({})
          expect(requestTexts(t.kit, 0)).toEqual([`user:${text}`])
          await recordEqualsRequest(to, t.kit, 0)
          expect((await to.redaction!.restoreJson(P_KEY)).value).toBe(KEY)
        },
        TIMEOUT
      )
    }
  })

  it(
    'RC-5 同一会话两个对话：根 faux-1 不脱敏，子 faux-2 脱敏，各按自己的模型存',
    async () => {
      const seen: RedactionPolicyRequest[] = []
      const d = await hostD({
        host: {
          redaction: redactionHost,
          redactionPolicy: byModel({ 'faux-1': EXEMPT, 'faux-2': REDACT }, seen)
        },
        tools: () => [printTool(`printed ${KEY}`)],
        dispatch: {
          profiles: {
            modeled: testProfile({ ...PROFILES.modeled, tools: ['emit'] })
          }
        }
      })
      const { session, t } = d
      t.kit.queue(
        callTool('emit', {}, 'call-root'),
        callAgent('modeled', 'go on'),
        callTool('emit', {}, 'call-child'),
        answer('child done'),
        answer('done')
      )
      expect(await session.submitUser('start')).toEqual({})
      expect(t.kit.requests.map((request) => request.modelId)).toEqual([
        'faux-1',
        'faux-1',
        'faux-2',
        'faux-2',
        'faux-1'
      ])
      const C = d.outcomes.at(-1)!.conversationId!
      const child = await childConversation(session, C)
      const root = await childConversation(session, ROOT)
      expect(requestTexts(t.kit, 4)).toContain(`toolResult:printed ${KEY}`)
      expect(JSON.stringify(await recordedMessages(root))).not.toContain(P_KEY)
      expect(requestTexts(t.kit, 3)).toContain(`toolResult:printed ${P_KEY}`)
      expect(JSON.stringify(await recordedMessages(child))).not.toContain(KEY)
      for (const n of [0, 1, 4]) await recordEqualsRequest(session, t.kit, n, root)
      for (const n of [2, 3]) await recordEqualsRequest(session, t.kit, n, child)
      expect(seen.some((r) => r.conversationId === C && r.model === 'faux-2')).toBe(true)
      expect(seen.some((r) => r.conversationId === ROOT && r.model === 'faux-1')).toBe(true)
    },
    TIMEOUT
  )

  describe('RC-6 通知', () => {
    const NOTICE = `<background-task id="t1">printed ${KEY}</background-task>`
    const MASKED = `<background-task id="t1">printed ${P_KEY}</background-task>`
    const cases: Array<[string, EgressDecision, string, boolean]> = [
      ['EXEMPT：原样，不记表', EXEMPT, NOTICE, false],
      ['REDACT：占位符', REDACT, MASKED, true]
    ]

    /** 策略问到的写入判定（入参没有对话）应恰有一次，按锁住的模型 */
    function expectJudgedByLock(seen: RedactionPolicyRequest[], id: string, model: string): void {
      const writes = seen.filter((request) => !('conversationId' in request))
      expect(writes).toEqual([{ sessionId: id, provider: 'faux', model }])
    }

    for (const [label, decision, stored, inTable] of cases) {
      it(
        `notify · 闲：${label}`,
        async () => {
          const seen: RedactionPolicyRequest[] = []
          const t = await makeHost({
            ephemeral: ['rc6a'],
            redaction: redactionHost,
            redactionPolicy: byModel({ 'faux-1': decision }, seen),
            noticeCoalesceMs: 0
          })
          const session = await t.open('rc6a')
          await primeRoot(session)
          t.kit.queue(answer('noted'))
          await session.notify(NOTICE)
          await waitFor(() => t.kit.requests.length >= 1)
          expect(requestTexts(t.kit, 0)).toEqual([`user:${stored}`])
          await recordEqualsRequest(session, t.kit, 0)
          expectJudgedByLock(seen, 'rc6a', 'faux-1')
          expect(await tableItems(session)).toEqual(inTable ? [['API_KEY', KEY]] : [])
        },
        TIMEOUT
      )

      it(
        `notify · 忙：${label}`,
        async () => {
          const gate = deferred()
          const running = deferred()
          const seen: RedactionPolicyRequest[] = []
          const t = await makeHost({
            ephemeral: ['rc6b'],
            redaction: redactionHost,
            redactionPolicy: byModel({ 'faux-1': decision }, seen),
            noticeCoalesceMs: 0,
            tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
          })
          const session = await t.open('rc6b')
          await primeRoot(session)
          t.kit.queue(callTool('hold'), answer('done'))
          const run = session.submitUser('go')
          await running.promise
          await session.notify(NOTICE)
          gate.resolve()
          expect(await run).toEqual({})
          expect(requestTexts(t.kit, 1)).toContain(`user:${stored}`)
          await recordEqualsRequest(session, t.kit, 1)
          expectJudgedByLock(seen, 'rc6b', 'faux-1')
          expect(await tableItems(session)).toEqual(inTable ? [['API_KEY', KEY]] : [])
        },
        TIMEOUT
      )

      it(
        `writeNotice：${label}`,
        async () => {
          const seen: RedactionPolicyRequest[] = []
          const t = await makeHost({
            ephemeral: ['rc6c'],
            redaction: redactionHost,
            redactionPolicy: byModel({ 'faux-1': decision }, seen),
            noticeCoalesceMs: 0
          })
          const session = await t.open('rc6c')
          await primeRoot(session)
          t.kit.queue(answer('first'), answer('second'))
          await session.submitUser('hello')
          const result = await session.writeNotice({ text: NOTICE, kind: 'background' })
          expect(result.status).toBe('submitted')
          await waitFor(async () => (await storedText(session)).includes('background-task'))
          await session.submitUser('next')
          await waitFor(() => t.kit.requests.length >= 2)
          expect(requestTexts(t.kit, 1).join('\n')).toContain(stored)
          await recordEqualsRequest(session, t.kit, 1)
          expectJudgedByLock(seen, 'rc6c', 'faux-1')
          expect(await tableItems(session)).toEqual(inTable ? [['API_KEY', KEY]] : [])
        },
        TIMEOUT
      )
    }

    it(
      '锁住的模型换了：通知按换后的模型判',
      async () => {
        const seen: RedactionPolicyRequest[] = []
        const rig = await twoModels('rc6d', byModel({ 'faux-1': REDACT, 'faux-2': EXEMPT }, seen))
        await rig.switchTo('faux-2')
        const result = await rig.session.writeNotice({ text: NOTICE, kind: 'background' })
        expect(result.status).toBe('submitted')
        await waitFor(async () => (await storedText(rig.session)).includes('background-task'))
        expect(await storedText(rig.session)).toContain(`printed ${KEY}`)
        expect(await tableItems(rig.session)).toEqual([])
        expectJudgedByLock(seen, 'rc6d', 'faux-2')
      },
      TIMEOUT
    )
  })

  describe('RC-7 hosted 任务', () => {
    const FIRE = 'session.prompt-accepted'
    const reviewerNext = (): ReturnType<typeof callTool> =>
      callTool(
        'next',
        { decision: 'allow', risk: 'low', summary: 'ok', reason: 'because' },
        'call-next'
      )

    async function hostedRecord(rig: HookRig, hook: string): Promise<{ id: number }> {
      let found: { id: number } | undefined
      await waitFor(() => {
        const record = rig.session.spawnedRecords().find((r) => r.hook === hook)
        if (record !== undefined) found = { id: record.conversationId }
        return found !== undefined
      })
      return found!
    }

    it(
      '审查员 · REDACT：子记录占位符，结果契约说明在脱敏之后；策略收到子对话与它的模型',
      async () => {
        const seen: RedactionPolicyRequest[] = []
        const rig = await hookRig({
          hooks: [REVIEW_HOOK],
          host: {
            redaction: redactionHost,
            redactionPolicy: byModel({ 'faux-1': REDACT }, seen)
          }
        })
        const maskText = vi.spyOn(rig.session.redaction!, 'maskText')
        queueRoles(rig.kit, { reviewer: [reviewerNext()] })
        const payload = permissionPayload({
          operation: {
            tool: 'bash',
            action: 'execute',
            objectType: 'command',
            target: `curl -H "x: ${KEY}" example.test`,
            facts: { channel: 'bash', sandboxed: false }
          }
        })
        expect(await rig.decide(payload)).not.toBeNull()
        const { id } = await hostedRecord(rig, 'auto-review')
        const child = await childConversation(rig.session, id)
        const [first] = await recordedMessages(child)
        const text = messageText(first)
        expect(text).not.toContain(KEY)
        expect(text).toContain(P_KEY)
        const note = buildResultContractNote({
          schema: {},
          sourceLabel: 'auto-review'
        })
        expect(text.endsWith(`\n\n${note}`)).toBe(true)
        // 按模型现判的只有任务本身（之后 next 的工具结果按记下的判定走），说明是脱敏之后才接上的
        const tasks = maskText.mock.calls.filter(([, options]) => options?.model !== undefined)
        expect(tasks).toHaveLength(1)
        expect(tasks[0]![0]).toContain(KEY)
        expect(tasks[0]![0]).not.toContain('result_contract')
        expect(tasks[0]![1]).toEqual({
          conversationId: id,
          model: { provider: 'faux', modelId: 'faux-1' }
        })
        expect(seen).toContainEqual({
          sessionId: 's1',
          conversationId: id,
          provider: 'faux',
          model: 'faux-1'
        })
        await recordEqualsRequest(rig.session, rig.kit, 0, child)
      },
      TIMEOUT
    )

    it(
      'titler · EXEMPT：原样，不记表',
      async () => {
        const rig = await hookRig({
          hooks: [TITLE_HOOK],
          host: {
            redaction: redactionHost,
            redactionPolicy: () => EXEMPT
          }
        })
        queueRoles(rig.kit, { titler: [answer('a title')] })
        rig.runner.fire(FIRE, promptPayload({ promptText: `the key is ${KEY}` }))
        await waitFor(() => rig.ends().length >= 1)
        const { id } = await hostedRecord(rig, 'auto-title')
        const child = await childConversation(rig.session, id)
        expect(messageText((await recordedMessages(child))[0])).toContain(`the key is ${KEY}`)
        expect(await tableItems(rig.session)).toEqual([])
        await recordEqualsRequest(rig.session, rig.kit, 0, child)
      },
      TIMEOUT
    )

    it(
      '按子对话的模型判，不是根的：根 faux-1 不脱敏，titler 用 faux-2 要脱敏',
      async () => {
        const seen: RedactionPolicyRequest[] = []
        const rig = await hookRig({
          hooks: [TITLE_HOOK],
          profiles: {
            ...HOOK_PROFILES,
            titler: testProfile({ ...TITLER, model: 'spec:faux-2' })
          },
          host: {
            redaction: redactionHost,
            redactionPolicy: byModel({ 'faux-1': EXEMPT, 'faux-2': REDACT }, seen)
          }
        })
        queueRoles(rig.kit, { root: [answer('ok')], titler: [answer('a title')] })
        expect(await rig.session.submitUser(`the key is ${KEY}`)).toEqual({})
        rig.runner.fire(FIRE, promptPayload({ promptText: `the key is ${KEY}` }))
        await waitFor(() => rig.ends().length >= 1)
        const { id } = await hostedRecord(rig, 'auto-title')
        const child = await childConversation(rig.session, id)
        expect(messageText((await recordedMessages(child))[0])).toContain(P_KEY)
        expect(JSON.stringify(await recordedMessages(child))).not.toContain(KEY)
        expect(await storedText(rig.session)).toContain(`the key is ${KEY}`)
        expect(seen).toContainEqual({
          sessionId: 's1',
          conversationId: id,
          provider: 'faux',
          model: 'faux-2'
        })
      },
      TIMEOUT
    )

    it(
      '用户明文 KEY 发送后：根记录明文，titler 子对话记录占位符',
      async () => {
        const rig = await hookRig({
          hooks: [TITLE_HOOK],
          host: {
            redaction: redactionHost,
            redactionPolicy: () => REDACT
          }
        })
        queueRoles(rig.kit, { root: [answer('ok'), answer('again')], titler: [answer('a title')] })
        expect(await rig.session.submitUser(`the key is ${KEY}`)).toEqual({})
        rig.runner.fire(FIRE, promptPayload({ promptText: `the key is ${KEY}` }))
        await waitFor(() => rig.ends().length >= 1)
        const { id } = await hostedRecord(rig, 'auto-title')
        const child = await childConversation(rig.session, id)
        expect(messageText((await recordedMessages(child))[0])).toContain(`the key is ${P_KEY}`)
        // 根对话的记录不受影响，下一个请求照旧是真值
        expect(await rig.session.submitUser('next')).toEqual({})
        const last = rig.kit.requests.at(-1)!
        expect(JSON.stringify(last.messages)).toContain(`the key is ${KEY}`)
        expect(JSON.stringify(last.messages)).not.toContain(P_KEY)
        await recordEqualsRequest(rig.session, rig.kit, rig.kit.requests.length - 1)
      },
      TIMEOUT
    )
  })

  it(
    'RC-8 换模型（不脱敏 → 脱敏）：历史明文照发、旧条目字节不变；新工具结果同值存占位符；请求里两种形式并存',
    async () => {
      const rig = await twoModels('rc8', byModel({ 'faux-1': EXEMPT, 'faux-2': REDACT }), () => [
        printTool(`printed ${KEY}`)
      ])
      const { t, session } = rig
      t.kit.queue(
        callTool('emit', {}, 'call-1'),
        answer(`I saw ${KEY}`),
        callTool('emit', {}, 'call-2'),
        answer('done')
      )
      expect(await session.submitUser(`first ${KEY}`)).toEqual({})
      const before = await recordJson(session)
      expect(before.join('\n')).toContain(`printed ${KEY}`)
      expect(await tableItems(session)).toEqual([])

      await rig.switchTo('faux-2')
      expect(await session.submitUser('second')).toEqual({})
      expect(t.kit.requests.map((request) => request.modelId)).toEqual([
        'faux-1',
        'faux-1',
        'faux-2',
        'faux-2'
      ])
      // 发给 faux-2 的第一个请求：历史逐字是明文
      expect(requestTexts(t.kit, 2)).toEqual([
        `user:first ${KEY}`,
        'assistant:[tool:emit]',
        `toolResult:printed ${KEY}`,
        `assistant:I saw ${KEY}`,
        'user:second'
      ])
      // 第二个请求：同一个值，旧的明文、新的占位符
      expect(requestTexts(t.kit, 3).slice(-2)).toEqual([
        'assistant:[tool:emit]',
        `toolResult:printed ${P_KEY}`
      ])
      const all = requestTexts(t.kit, 3).join('\n')
      expect(all).toContain(`toolResult:printed ${KEY}`)
      expect(all).toContain(`toolResult:printed ${P_KEY}`)
      // 旧条目一个字节都没动
      expect((await recordJson(session)).slice(0, before.length)).toEqual(before)
      for (const n of [0, 1, 2, 3]) await recordEqualsRequest(session, t.kit, n)
      expect(await tableItems(session)).toEqual([['API_KEY', KEY]])
    },
    TIMEOUT
  )

  it(
    'RC-9 换模型（脱敏 → 不脱敏）：旧占位符照发；新输出同值存明文；工具参数写旧占位符，工具拿到真值',
    async () => {
      const seenByTool: unknown[] = []
      const rig = await twoModels(
        'rc9',
        byModel({ 'faux-1': REDACT, 'faux-2': EXEMPT }),
        (getSession) => [printTool(`printed ${KEY}`), echoTool(getSession, seenByTool)]
      )
      const { t, session } = rig
      t.kit.queue(callTool('emit', {}, 'call-1'), answer('first'))
      expect(await session.submitUser('one')).toEqual({})
      expect(await storedText(session)).toContain(`printed ${P_KEY}`)

      await rig.switchTo('faux-2')
      t.kit.queue(
        callTool('emit', {}, 'call-2'),
        callTool('echo', { text: P_KEY }, 'call-3'),
        answer('done')
      )
      expect(await session.submitUser('two')).toEqual({})
      expect(requestTexts(t.kit, 2)).toContain(`toolResult:printed ${P_KEY}`)
      expect(requestTexts(t.kit, 3).slice(-1)).toEqual([`toolResult:printed ${KEY}`])
      expect(requestTexts(t.kit, 3).join('\n')).toContain(`toolResult:printed ${P_KEY}`)
      expect(seenByTool).toEqual([{ text: KEY }])
      // echo 打印的是真值，这个模型不脱敏，存明文；工具参数里是模型写的占位符
      expect(requestTexts(t.kit, 4).slice(-1)).toEqual([`toolResult:printed ${KEY}`])
      for (const n of [0, 1, 2, 3, 4]) await recordEqualsRequest(session, t.kit, n)
    },
    TIMEOUT
  )

  it(
    'RC-10 关掉策略再打开：旧占位符留着且还原得了；关着时新内容明文不记表，+ 值仍是占位符；打开后新内容换、旧明文不动',
    async () => {
      const decision: { current: EgressDecision } = { current: REDACT }
      const OFF_KEY = 'sk-proj-' + 'Off0Off0Off0Off0Off0Off0'
      const ON_KEY = 'sk-proj-' + 'On1On1On1On1On1On1On1On1'
      const printed: { text: string } = { text: `printed ${KEY}` }
      const t = await makeHost({
        ephemeral: ['rc10'],
        redaction: redactionHost,
        redactionPolicy: () => decision.current,
        tools: [printTool(() => printed.text)]
      })
      const session = await t.open('rc10')
      const redaction = session.redaction!

      // 开着：KEY 存占位符
      t.kit.queue(callTool('emit', {}, 'call-1'), answer('one'))
      expect(await session.submitUser('on')).toEqual({})
      expect(await tableItems(session)).toEqual([['API_KEY', KEY]])

      // 关掉：旧占位符还在请求里，工具照样还原
      decision.current = EXEMPT
      printed.text = `printed ${OFF_KEY}`
      t.kit.queue(callTool('emit', {}, 'call-2'), answer('two'))
      expect(await session.submitUser('off')).toEqual({})
      const offRequest = requestTexts(t.kit, 2)
      expect(offRequest).toContain(`toolResult:printed ${P_KEY}`)
      expect((await redaction.restoreJson({ command: `use ${P_KEY}` })).value).toEqual({
        command: `use ${KEY}`
      })
      expect(requestTexts(t.kit, 3).slice(-1)).toEqual([`toolResult:printed ${OFF_KEY}`])
      expect(await tableItems(session)).toEqual([['API_KEY', KEY]])

      // 关着：+ 值仍变占位符；工具打印 + 值存明文
      printed.text = `printed ${PW}`
      t.kit.queue(callTool('emit', {}, 'call-3'), answer('three'))
      expect(await session.submitUser(`pw is ${PW}`, { composer: { secrets: [PLUS] } })).toEqual({})
      const plus = requestTexts(t.kit, 4).at(-1)!
      expect(plus).not.toContain(PW)
      expect(plus).toMatch(/^user:pw is \{\{REDACTED_PASSWORD_[a-z2-7]{8}\}\}$/)
      expect(requestTexts(t.kit, 5).slice(-1)).toEqual([`toolResult:printed ${PW}`])
      const items = await tableItems(session)
      expect(items).toEqual([
        ['API_KEY', KEY],
        ['PASSWORD', PW]
      ])

      // 再开回：新内容换，旧明文不动
      const before = await recordJson(session)
      decision.current = REDACT
      printed.text = `printed ${ON_KEY}`
      t.kit.queue(callTool('emit', {}, 'call-4'), answer('four'))
      expect(await session.submitUser('on again')).toEqual({})
      const last = t.kit.requests.length - 1
      const final = requestTexts(t.kit, last)
      expect(final.at(-1)).toMatch(/^toolResult:printed \{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}$/)
      expect(final).toContain(`toolResult:printed ${OFF_KEY}`)
      expect(final).toContain(`toolResult:printed ${PW}`)
      expect((await recordJson(session)).slice(0, before.length)).toEqual(before)
      for (let n = 0; n < t.kit.requests.length; n++) {
        await recordEqualsRequest(session, t.kit, n)
      }
    },
    TIMEOUT
  )

  it(
    'RC-11 第一层 deny 插在中间：不发请求、错误回复；换回去请求照发',
    async () => {
      const rig = await twoModels('rc11', byModel({ 'faux-1': REDACT, 'faux-2': DENY1 }))
      const { t, session } = rig
      t.kit.queue(answer('first'))
      expect(await session.submitUser('one')).toEqual({})
      expect(t.kit.requests).toHaveLength(1)

      await rig.switchTo('faux-2')
      const refused = await session.submitUser('two')
      expect(t.kit.requests).toHaveLength(1)
      expect(refused.error).toMatch(/does not allow sending requests/)
      const stored = await recordedMessages(await session.currentConversation())
      expect(stored.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'error' })

      await rig.switchTo('faux-1')
      t.kit.queue(answer('third'))
      expect(await session.submitUser('three')).toEqual({})
      expect(t.kit.requests).toHaveLength(2)
      expect(t.kit.requests[1]!.modelId).toBe('faux-1')
      const texts = requestTexts(t.kit, 1)
      expect(texts[0]).toBe('user:one')
      expect(texts.at(-1)).toBe('user:three')
    },
    TIMEOUT
  )

  it(
    'RC-12 第二层 deny：工具结果存占位符，请求照发',
    async () => {
      const t = await makeHost({
        ephemeral: ['rc12'],
        redaction: redactionHost,
        redactionPolicy: () => byCategory({ PRIVATE_KEY: 'block', API_KEY: 'send' }),
        tools: [printTool(`pem:\n${PEM}\nkey ${KEY}`)]
      })
      const session = await t.open('rc12')
      t.kit.queue(callTool('emit'), answer('done'))
      expect(await session.submitUser('go')).toEqual({})
      expect(t.kit.requests).toHaveLength(2)
      const seen = requestTexts(t.kit, 1).at(-1)!
      expect(seen).not.toContain('BEGIN PRIVATE KEY')
      expect(seen).toMatch(/pem:\n\{\{REDACTED_PRIVATE_KEY_[a-z2-7]{8}\}\}\nkey sk-proj-/)
      expect(seen).toContain(KEY)
      await recordEqualsRequest(session, t.kit, 1)
      expect((await tableItems(session)).map(([category]) => category)).toEqual(['PRIVATE_KEY'])
    },
    TIMEOUT
  )

  describe('RC-13 问题卡', () => {
    const ASK_ARGS = {
      question: 'which key?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' }
      ]
    }

    async function asked(id: string): Promise<{ t: TestHost; session: DurableSession }> {
      const live: { session?: DurableSession } = {}
      const t = await makeHost({
        ephemeral: [id],
        redaction: redactionHost,
        redactionPolicy: () => REDACT,
        tools: [
          createAskTool({ requestUserInput: (request) => live.session!.requestUserInput(request) })
        ]
      })
      const session = await t.open(id)
      live.session = session
      return { t, session }
    }

    it(
      '用户答 other：写的值记成照原样发，ask 结果里的 KEY 不换',
      async () => {
        const { t, session } = await asked('rc13a')
        t.kit.queue(callTool('ask', ASK_ARGS, 'call-ask'), answer('done'))
        const run = session.submitUser('ask me')
        await waitFor(() => session.pendingInputCount === 1)
        const [text] = await session.redaction!.maskComposerTexts([`use ${KEY}`], [])
        expect(text).toBe(`use ${KEY}`)
        expect(session.respondToInput('call-ask', { kind: 'other', text })).toBe(true)
        expect(await run).toEqual({})
        expect(requestTexts(t.kit, 1).at(-1)).toContain(`use ${KEY}`)
        expect(await tableItems(session)).toEqual([])
        await recordEqualsRequest(session, t.kit, 1)
      },
      TIMEOUT
    )

    it(
      '父会话代答（没有 secrets 这一步）：是工具结果，按策略换',
      async () => {
        const { t, session } = await asked('rc13b')
        t.kit.queue(callTool('ask', ASK_ARGS, 'call-ask'), answer('done'))
        const run = session.submitUser('ask me')
        await waitFor(() => session.pendingInputCount === 1)
        expect(
          session.respondToInput(
            'call-ask',
            { kind: 'other', text: `use ${KEY}` },
            { answeredBy: { kind: 'parent-session', sessionId: 'P' } }
          )
        ).toBe(true)
        expect(await run).toEqual({})
        const seen = requestTexts(t.kit, 1).at(-1)!
        expect(seen).toContain(`use ${P_KEY}`)
        expect(seen).not.toContain(KEY)
        expect(await tableItems(session)).toEqual([['API_KEY', KEY]])
        await recordEqualsRequest(session, t.kit, 1)
      },
      TIMEOUT
    )
  })

  describe('RC-14 还原回显', () => {
    const VALUE = `it's $HOME-pw`
    const ESCAPED = `it'\\''s $HOME-pw`

    /** 真宿主：工具按命令字段还原参数，回显转义后的命令 */
    async function rig(
      id: string,
      decision: EgressDecision
    ): Promise<{ t: TestHost; session: DurableSession; placeholder: string }> {
      const live: { session?: DurableSession } = {}
      const t = await makeHost({
        ephemeral: [id],
        redaction: redactionHost,
        redactionPolicy: () => decision,
        tools: [
          defineTool({
            name: 'sh',
            description: 'sh: echoes the command it ran',
            parameters: Type.Object({ command: Type.String() }),
            execute: async (args) => {
              const { value } = await live.session!.redaction!.restoreJson(args, {
                field: 'command',
                dialect: 'posix'
              })
              return { output: [{ type: 'text', text: `+ ${value.command}` }] }
            }
          })
        ]
      })
      const session = await t.open(id)
      live.session = session
      const [masked] = await session.redaction!.maskComposerTexts(
        [`pw ${VALUE}`],
        [{ value: VALUE, category: 'PASSWORD' }]
      )
      const placeholder = masked!.match(PLACEHOLDER)![0]
      t.kit.queue(callTool('sh', { command: `echo '${placeholder}'` }, 'call-sh'), answer('done'))
      expect(await session.submitUser('run it')).toEqual({})
      return { t, session, placeholder }
    }

    it(
      'REDACT：回显里转义后的真值换回同一个占位符',
      async () => {
        const { t, session, placeholder } = await rig('rc14a', REDACT)
        const seen = requestTexts(t.kit, 1).at(-1)!
        expect(seen).toBe(`toolResult:+ echo '${placeholder}'`)
        expect(seen).not.toContain(ESCAPED)
        await recordEqualsRequest(session, t.kit, 1)
      },
      TIMEOUT
    )

    it(
      'EXEMPT：回显按明文存',
      async () => {
        const { t, session } = await rig('rc14b', EXEMPT)
        expect(requestTexts(t.kit, 1).at(-1)).toBe(`toolResult:+ echo '${ESCAPED}'`)
        await recordEqualsRequest(session, t.kit, 1)
      },
      TIMEOUT
    )
  })

  it(
    'RC-8b 回复里的真值逐字进下一个模型的请求；thinking 块也一样',
    async () => {
      const rig = await twoModels('rc8b', byModel({ 'faux-1': EXEMPT, 'faux-2': REDACT }))
      const { t, session } = rig
      t.kit.queue(answer(`said ${KEY}`))
      expect(await session.submitUser('one')).toEqual({})
      await rig.switchTo('faux-2')
      t.kit.queue(answer('later'))
      expect(await session.submitUser('two')).toEqual({})
      await recordEqualsRequest(session, t.kit, 1)
      expect(JSON.stringify(t.kit.requests[1]!.messages)).toContain(`said ${KEY}`)
      // 回复里 thinking 块的存法不受判定影响
      const thinking = await twoModels('rc8c', () => REDACT)
      thinking.t.kit.queue(
        assistantWith([
          { type: 'thinking', thinking: `think ${KEY}` },
          { type: 'text', text: `text ${KEY}` }
        ]),
        answer('later')
      )
      expect(await thinking.session.submitUser('one')).toEqual({})
      expect(await thinking.session.submitUser('two')).toEqual({})
      await recordEqualsRequest(thinking.session, thinking.t.kit, 1)
      expect(JSON.stringify(thinking.t.kit.requests[1]!.messages)).toContain(`think ${KEY}`)
    },
    TIMEOUT
  )
})
