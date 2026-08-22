/**
 * 安全策略规则的 `prompt`（纯人读提示语）—— 只测 unit 做不到的三件事：
 *
 *   ① 跨进程传输：evaluate → enforce → gateway → preload，询问事件的
 *      `request.policyPrompt` 逐字送到渲染端（EN-P3 测的是 enforce 那一截接缝，
 *      这里测的是整条链路，两者都要）；
 *   ② 用户 md 落盘现扫即生效：一份带 prompt 的 deny 策略丢进 ~/.shuvix/policies，
 *      下一次工具调用的错误里就带上它；
 *   ③ 「删光 prompt」的整链回归：同名覆盖一份不写 prompt 的 ask-on-write，
 *      询问卡片不该多出一栏、拒绝文案不该多出一段。
 *
 * 文案逐字与拼接语义留在 unit（packages/agent-runtime/src/security/__tests__/）。
 * 断言一律走 IPC（window.api.*）；DOM 只在 E2E-P5 用，且经 harness/pages.ts。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import { policiesPane, type PoliciesPane } from '../../harness/pages'

const MODEL = 'e2e-model'

interface PolicyRule {
  effect: string
  /** 缺省的 prompt 经 CDP returnByValue 变成 null（数组里的 undefined 不可表达） */
  prompt: string | null
}
interface PolicyRow {
  name: string
  displayName: string
  source: 'builtin' | 'user'
  overridden?: boolean
  rules: PolicyRule[]
}

interface ListedMessage {
  id: string
  type: string
  content: string
  blocks?: ToolBlock[]
}

/** 助手卡片里的工具块（工具结果落在这里，不再是独立消息） */
interface ToolBlock {
  type: string
  toolCallId?: string
  result?: string
  isError?: boolean
}

interface AskRequestEvent extends RecordedEvent {
  request: {
    id: string
    command: string
    policyPrompt?: { text: string; policies: string[] } | null
  }
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let projDir = ''
let projectId = ''

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-policy-prompt')
  mkdirSync(projDir, { recursive: true })
  projectId = (await createProject(app.main, { name: 'PolicyPromptProj', path: projDir })).id

  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

const listPolicies = (): Promise<PolicyRow[]> =>
  app.main.eval<PolicyRow[]>(
    `(async () => {
      const list = await window.api.policy.list()
      return list.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        source: p.source,
        overridden: p.overridden,
        rules: p.rules.map((r) => ({ effect: r.effect, prompt: r.prompt ?? null }))
      }))
    })()`
  )

const builtinRow = async (name: string): Promise<PolicyRow> =>
  (await listPolicies()).find((p) => p.name === name && p.source === 'builtin')!

const createPolicy = (text: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.policy.create(${JSON.stringify({ text })})`)
const savePolicy = (
  originalName: string,
  text: string
): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.policy.save(${JSON.stringify({ originalName, text })})`)
const deletePolicy = (name: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.policy.delete(${JSON.stringify({ name })})`)

const newSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

/** 发送 prompt 但**不等它跑完** —— 询问用例里整条链路会停在等人应答上 */
const sendPrompt = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(() => {
      window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )

const respondToInput = (sid: string, requestId: string, response: unknown): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.respondToInput(${JSON.stringify({ sessionId: sid, requestId, response })})`
  )

/** 该 toolCallId 的工具块（工具调用是助手卡片内的块，按 toolCallId 认） */
const toolResult = async (sid: string, toolCallId: string): Promise<ToolBlock> => {
  const messages = await app.main.eval<ListedMessage[]>(
    `window.api.message.list(${JSON.stringify(sid)})`
  )
  const found = messages
    .flatMap((m) => m.blocks ?? [])
    .find((b) => b.type === 'tool' && b.toolCallId === toolCallId)
  expect(found, `tool result ${toolCallId} 未落库`).toBeDefined()
  return found!
}

/** 脚本化一轮 write 工具调用 + 一轮收尾正文 */
const scriptWrite = (callId: string, target: string): void => {
  provider.reset()
  provider.script(
    {
      toolCalls: [
        { id: callId, name: 'write', args: JSON.stringify({ path: target, content: 'X' }) }
      ],
      usage: { prompt: 90, completion: 6 }
    },
    { text: 'done', usage: { prompt: 120, completion: 4 } }
  )
}

/** 覆盖 ask-on-write 的用户 md（不写 prompt）—— effect 由调用方定 */
const writeGateOverride = (effect: 'ask' | 'deny'): string =>
  [
    '---',
    'shuvix: policy v1',
    'name: ask-on-write',
    'description: e2e override without any prompt',
    'shuvix-policy-scope:',
    '  subject.kind: [agent]',
    '  object.type: [path]',
    '  env.host: [desktop]',
    'shuvix-policy-rules:',
    `  - effect: ${effect}`,
    '    action: [write]',
    '---',
    'override body'
  ].join('\n')

describe('policy prompt —— 询问链路（内置 ask-on-write）', () => {
  it('E2E-P1 撞 ask-on-write → input_request 的 policyPrompt 逐字等于内置文案，署名为该策略显示名', async () => {
    const gate = await builtinRow('ask-on-write')
    expect(gate.rules[0].prompt, '内置 ask-on-write 没写 prompt').toBeTruthy()

    const sid = await newSession('P1-ask')
    await events.clear()
    scriptWrite('call_p1', join(projDir, 'p1.txt'))
    await sendPrompt(sid, 'write a file')

    const event = await events.waitFor<AskRequestEvent>('input_request', { sessionId: sid })
    // 整条传输链（evaluate → enforce → gateway → preload）都不加工这段文本
    expect(event.request.policyPrompt).toEqual({
      text: gate.rules[0].prompt,
      policies: [gate.displayName]
    })

    // 收尾：放行让这一轮跑完，免得挂着的询问影响后续用例
    await respondToInput(sid, event.request.id, { kind: 'ask', allowed: true })
    await events.waitFor('agent_end', { sessionId: sid })
  })

  it('E2E-P2 对该询问回 allowed:false → 工具结果是 User denied access to …，不含 prompt 任何片段', async () => {
    const gate = await builtinRow('ask-on-write')
    const promptText = gate.rules[0].prompt!
    const firstSentence = promptText.split(/[.。]/)[0]
    expect(firstSentence.length).toBeGreaterThan(5)

    const target = join(projDir, 'p2.txt')
    const sid = await newSession('P2-denied')
    await events.clear()
    scriptWrite('call_p2', target)
    await sendPrompt(sid, 'write a file')

    const event = await events.waitFor<AskRequestEvent>('input_request', { sessionId: sid })
    await respondToInput(sid, event.request.id, { kind: 'ask', allowed: false })
    await events.waitFor('agent_end', { sessionId: sid })

    const result = await toolResult(sid, 'call_p2')
    expect(result.isError).toBe(true)
    expect(result.result).toContain('User denied access to')
    expect(result.result).toContain(target)
    // 询问文本只到卡片为止 —— 拒绝的回话不把策略文案带进 agent 上下文
    expect(result.result).not.toContain(promptText)
    expect(result.result).not.toContain(firstSentence)
  })
})

describe('policy prompt —— 用户 md 落盘现扫即生效', () => {
  const DENY_PROMPT = 'This tree is maintained by hand; ask the user to edit it themselves.'
  const forbiddenDir = (): string => join(projDir, 'hands-off')

  it('E2E-P3 用户 deny 策略（带 prompt）→ 工具错误同时含归因与提示语', async () => {
    mkdirSync(forbiddenDir(), { recursive: true })
    expect(
      await createPolicy(
        [
          '---',
          'shuvix: policy v1',
          'name: e2e-deny-with-prompt',
          'description: e2e deny gate carrying a prompt',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          '  - effect: deny',
          '    action: [write]',
          `    match: "inDir(object.path, '${forbiddenDir()}')"`,
          `    prompt: ${DENY_PROMPT}`,
          '---',
          'body'
        ].join('\n')
      )
    ).toMatchObject({ success: true })

    const sid = await newSession('P3-deny')
    await events.clear()
    scriptWrite('call_p3', join(forbiddenDir(), 'x.txt'))
    await sendPrompt(sid, 'write into the forbidden dir')
    await events.waitFor('agent_end', { sessionId: sid })

    const result = await toolResult(sid, 'call_p3')
    expect(result.isError).toBe(true)
    // deny 不弹卡片，抛出的工具错误是提示语唯一的露出面：归因 + 文案两段都在
    expect(result.result).toContain("Denied by security policy rule 'e2e-deny-with-prompt#0'")
    expect(result.result).toContain(DENY_PROMPT)

    expect(await deletePolicy('e2e-deny-with-prompt')).toMatchObject({ success: true })
  })
})

describe('policy prompt —— 删光 prompt 的覆盖副本', () => {
  it('E2E-P4 同名覆盖 ask-on-write（不带 prompt）→ 询问无 policyPrompt；换 deny 覆盖文案逐字；删除后立即恢复', async () => {
    const builtin = await builtinRow('ask-on-write')
    const builtinPrompt = builtin.rules[0].prompt!

    // ① ask 覆盖：询问照常弹，只是不多出提示语那一栏
    expect(await createPolicy(writeGateOverride('ask'))).toMatchObject({ success: true })
    const overridden = (await listPolicies()).find(
      (p) => p.name === 'ask-on-write' && p.source === 'user'
    )!
    expect(overridden.rules).toEqual([{ effect: 'ask', prompt: null }])

    const askSid = await newSession('P4-ask')
    await events.clear()
    scriptWrite('call_p4a', join(projDir, 'p4a.txt'))
    await sendPrompt(askSid, 'write a file')

    const event = await events.waitFor<AskRequestEvent>('input_request', { sessionId: askSid })
    expect(event.request.policyPrompt ?? null).toBeNull()
    await respondToInput(askSid, event.request.id, { kind: 'ask', allowed: true })
    await events.waitFor('agent_end', { sessionId: askSid })

    // ② deny 覆盖：错误文案就是光秃秃的归因，没有多余的空行或分隔
    expect(await savePolicy('ask-on-write', writeGateOverride('deny'))).toMatchObject({
      success: true
    })
    const denySid = await newSession('P4-deny')
    await events.clear()
    scriptWrite('call_p4b', join(projDir, 'p4b.txt'))
    await sendPrompt(denySid, 'write a file')
    await events.waitFor('agent_end', { sessionId: denySid })

    const denied = await toolResult(denySid, 'call_p4b')
    expect(denied.isError).toBe(true)
    expect(denied.result).toContain("Denied by security policy rule 'ask-on-write#0'")
    expect(denied.result).not.toContain(builtinPrompt)
    expect(denied.result).not.toContain('\n\n')

    // ③ 删除覆盖 → 下一次评估现扫目录，内置的提示语立刻回来
    expect(await deletePolicy('ask-on-write')).toMatchObject({ success: true })
    const restoredSid = await newSession('P4-restored')
    await events.clear()
    scriptWrite('call_p4c', join(projDir, 'p4c.txt'))
    await sendPrompt(restoredSid, 'write a file')

    const restored = await events.waitFor<AskRequestEvent>('input_request', {
      sessionId: restoredSid
    })
    expect(restored.request.policyPrompt).toEqual({
      text: builtinPrompt,
      policies: [builtin.displayName]
    })
    await respondToInput(restoredSid, restored.request.id, { kind: 'ask', allowed: true })
    await events.waitFor('agent_end', { sessionId: restoredSid })
  })
})

describe('policy prompt —— 设置页与 md 原文', () => {
  let pane: PoliciesPane

  it('E2E-P5 属性卡逐规则渲染 prompt 行；没写 prompt 的用户策略不出现该行', async () => {
    expect(
      await createPolicy(
        [
          '---',
          'shuvix: policy v1',
          'name: e2e-no-prompt',
          'description: a user policy that says nothing',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [command]',
          'shuvix-policy-rules:',
          '  - effect: ask',
          '    action: [execute]',
          '---',
          'body'
        ].join('\n')
      )
    ).toMatchObject({ success: true })

    pane = await policiesPane(await app.openSettings('policies'))
    await pane.refresh()

    // 内置 protect-credentials：两条规则各有一句提示语
    const credentials = await builtinRow('protect-credentials')
    await pane.selectRow(credentials.displayName)
    expect((await pane.detail()).rulePrompts).toEqual(credentials.rules.map((r) => r.prompt))

    // 用户策略没写 prompt → 该行整个不出现（规则行本身照常渲染）
    await pane.selectRow('e2e-no-prompt')
    const plain = await pane.detail()
    expect(plain.effectBadges).toBe(1)
    expect(plain.rulePrompts).toEqual([])
  })

  it('E2E-P6 policy.getSource(builtin) 回吐的 md 含 prompt: 键，且等于当前界面语言的文案', async () => {
    const builtin = await builtinRow('ask-on-write')
    const source = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.policy.getSource(${JSON.stringify({ name: 'ask-on-write', source: 'builtin' })})`
    )
    expect(source.error).toBeUndefined()
    // 「创建覆盖副本」的初值里必须带上提示语，否则复制一份就等于悄悄删掉它
    expect(source.text).toContain('prompt:')
    expect(source.text).toContain(builtin.rules[0].prompt!)
  })
})
